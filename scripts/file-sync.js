/**
 * IPFS 分布式存储网络 - 文件自动同步模块
 * 基于 floodsub 广播实现节点间文件自动分发
 *
 * 同步流程：
 * 1. 文件上传后，通过 floodsub 广播 FILE_SYNC 通知（含文件元数据）
 * 2. 所有在线节点收到通知后，检查本地是否已有该文件
 * 3. 缺失的节点从源节点本地存储拉取文件内容（同进程共享存储目录）
 * 4. 拉取成功后更新本地索引和节点配额
 */

import fs from 'fs-extra';
import path from 'path';
import FileOperations from './file-ops.js';

const NODES_DIR = '/home/project/.ipfs-nodes';
const SYNC_TOPIC = 'ipfs-storage-network';
const SYNC_MSG_TYPE = 'FILE_SYNC';

const fileOps = new FileOperations(NODES_DIR);

// 已处理的同步消息 ID（防重复）
const processedSyncIds = new Set();

/**
 * 本地直接同步：将文件复制到所有 running 状态的节点
 * 所有节点共享同一文件系统目录，无需跨进程网络通信
 * @param {object} fileInfo - 文件索引信息 { cid, fileName, size, encrypted, storedNodes }
 * @returns {object} 同步结果 { syncedNodes, totalNodes }
 */
export async function localSync(fileInfo) {
  const { cid, fileName, size, encrypted } = fileInfo;
  const sourceNodes = fileInfo.storedNodes || [];
  if (sourceNodes.length === 0) {
    return { success: false, reason: '无源节点' };
  }

  // 读取源文件内容
  const sourceNode = sourceNodes[0];
  const content = await fileOps.readFromNode(sourceNode, cid);
  if (!content) {
    return { success: false, reason: `源节点 ${sourceNode} 无文件内容` };
  }

  // 获取所有 running 状态的节点
  const nodeDirs = await fs.readdir(NODES_DIR);
  const runningNodes = [];
  for (const dir of nodeDirs) {
    if (!dir.startsWith('node-')) continue;
    const configPath = path.join(NODES_DIR, dir, 'config.json');
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);
      if (config.status === 'running') {
        runningNodes.push(dir);
      }
    }
  }

  // 复制到缺失的节点
  const syncedNodes = [];
  for (const nodeId of runningNodes) {
    if (sourceNodes.includes(nodeId)) continue;

    const blockPath = path.join(NODES_DIR, nodeId, 'blocks', `${cid}.block`);
    if (await fs.pathExists(blockPath)) continue;

    // 检查配额
    const configPath = path.join(NODES_DIR, nodeId, 'config.json');
    const config = await fs.readJson(configPath);
    const quota = Math.min(config.quota || 100 * 1024 * 1024, 100 * 1024 * 1024);
    if ((config.usedSpace || 0) + content.length > quota) continue;

    await storeToLocalNode(nodeId, cid, content, { fileName, size, encrypted });
    syncedNodes.push(nodeId);
  }

  return {
    success: true,
    syncedNodes,
    totalNodes: runningNodes.length,
    alreadyPresent: runningNodes.length - syncedNodes.length
  };
}

/**
 * 广播文件同步通知（daemon 进程内使用）
 * 在 P2P 网络在线时，通过 floodsub 通知其他进程/节点
 * @param {object} fileInfo - 文件索引信息
 * @param {string} sourceNodeId - 源节点 ID
 * @param {object} network - libp2p-network 模块实例
 * @returns {object} 广播结果
 */
export async function broadcastFileSync(fileInfo, sourceNodeId, network) {
  const activeNodes = network.getActiveNodes();
  if (activeNodes.length === 0) {
    return { success: false, reason: 'P2P 网络未启动，跳过同步广播' };
  }

  const syncMessage = {
    type: SYNC_MSG_TYPE,
    syncId: `${fileInfo.cid}-${Date.now()}`,
    cid: fileInfo.cid,
    fileName: fileInfo.fileName,
    size: fileInfo.size,
    encrypted: fileInfo.encrypted || false,
    sourceNode: sourceNodeId,
    storedNodes: fileInfo.storedNodes || [],
    timestamp: new Date().toISOString()
  };

  const broadcastNode = activeNodes.includes(sourceNodeId) ? sourceNodeId : activeNodes[0];
  const result = await network.broadcastGossip(broadcastNode, syncMessage);

  return {
    success: true,
    syncId: syncMessage.syncId,
    recipients: result.recipients,
    broadcastNode
  };
}

/**
 * 启动文件同步监听
 * 订阅 floodsub 广播，自动处理 FILE_SYNC 消息
 * @param {object} network - libp2p-network 模块实例
 * @param {object} options - { onSync, onError }
 * @returns {object} { unsubscribe, getStats }
 */
export function startFileSyncListener(network, options = {}) {
  const { onSync, onError } = options;
  const stats = { received: 0, synced: 0, skipped: 0, errors: 0 };
  const unsubscribers = [];

  const activeNodes = network.getActiveNodes();
  for (const nodeId of activeNodes) {
    const unsub = network.subscribeGossip(nodeId, async (message, fromPeer) => {
      // 只处理 FILE_SYNC 类型消息
      if (message.type !== SYNC_MSG_TYPE) return;

      stats.received++;

      // 防重复处理
      if (processedSyncIds.has(message.syncId)) {
        stats.skipped++;
        return;
      }
      processedSyncIds.add(message.syncId);

      // 限制 processedSyncIds 大小
      if (processedSyncIds.size > 1000) {
        const first = processedSyncIds.values().next().value;
        processedSyncIds.delete(first);
      }

      try {
        const result = await handleSyncMessage(nodeId, message);
        if (result.action === 'synced') {
          stats.synced++;
          if (onSync) onSync({ nodeId, ...result });
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.errors++;
        if (onError) onError({ nodeId, error: err.message, cid: message.cid });
      }
    });
    unsubscribers.push(unsub);
  }

  return {
    unsubscribe: () => unsubscribers.forEach(fn => fn()),
    getStats: () => ({ ...stats })
  };
}

/**
 * 处理单条同步消息
 * 检查本地节点是否已有文件，缺失则拉取
 */
async function handleSyncMessage(nodeId, message) {
  const { cid, sourceNode, fileName, size, encrypted } = message;

  // 检查本地节点是否已有该文件
  const blockPath = path.join(NODES_DIR, nodeId, 'blocks', `${cid}.block`);
  if (await fs.pathExists(blockPath)) {
    return { action: 'already-exists', cid, nodeId };
  }

  // 检查节点配额
  const configPath = path.join(NODES_DIR, nodeId, 'config.json');
  if (await fs.pathExists(configPath)) {
    const config = await fs.readJson(configPath);
    const quota = Math.min(config.quota || 100 * 1024 * 1024, 100 * 1024 * 1024);
    if ((config.usedSpace || 0) + size > quota) {
      return { action: 'quota-exceeded', cid, nodeId };
    }
  }

  // 从源节点拉取文件内容（同进程共享存储目录）
  const content = await fileOps.readFromNode(sourceNode, cid);
  if (!content) {
    // 尝试从其他 storedNodes 拉取
    for (const altNode of message.storedNodes || []) {
      if (altNode === nodeId) continue;
      const altContent = await fileOps.readFromNode(altNode, cid);
      if (altContent) {
        await storeToLocalNode(nodeId, cid, altContent, { fileName, size, encrypted });
        return { action: 'synced', cid, nodeId, fromNode: altNode };
      }
    }
    return { action: 'source-unavailable', cid, nodeId };
  }

  // 存储到本地节点
  await storeToLocalNode(nodeId, cid, content, { fileName, size, encrypted });
  return { action: 'synced', cid, nodeId, fromNode: sourceNode };
}

/**
 * 存储文件到本地节点（含元数据和配额更新）
 */
async function storeToLocalNode(nodeId, cid, content, metadata) {
  const nodeDir = path.join(NODES_DIR, nodeId, 'blocks');
  await fs.ensureDir(nodeDir);

  // 写入 block
  const blockPath = path.join(nodeDir, `${cid}.block`);
  await fs.writeFile(blockPath, content);

  // 写入元数据
  const metaPath = path.join(nodeDir, `${cid}.meta.json`);
  await fs.writeJson(metaPath, {
    fileName: metadata.fileName,
    originalSize: metadata.size,
    encrypted: metadata.encrypted,
    syncedAt: new Date().toISOString(),
    syncSource: true
  }, { spaces: 2 });

  // 更新节点使用空间
  const configPath = path.join(NODES_DIR, nodeId, 'config.json');
  if (await fs.pathExists(configPath)) {
    const config = await fs.readJson(configPath);
    config.usedSpace = (config.usedSpace || 0) + content.length;
    await fs.writeJson(configPath, config, { spaces: 2 });
  }

  // 更新全局文件索引（追加当前节点到 storedNodes，使用分片索引）
  const { IndexStore } = await import('./index-store.js');
  const indexStore = new IndexStore(NODES_DIR);
  await indexStore.init();
  const fileInfo = await indexStore.get(cid);
  if (fileInfo) {
    if (!fileInfo.storedNodes.includes(nodeId)) {
      fileInfo.storedNodes.push(nodeId);
      fileInfo.replicas = fileInfo.storedNodes.length;
      fileInfo.lastSyncAt = new Date().toISOString();
      await indexStore.set(cid, fileInfo);
    }
  }
}

/**
 * 手动触发全量同步
 * 将索引中所有文件同步到所有 running 状态的节点
 * @returns {object} 同步结果
 */
export async function fullSync() {
  const { IndexStore } = await import('./index-store.js');
  const indexStore = new IndexStore(NODES_DIR);
  await indexStore.init();
  const index = await indexStore.getAll();

  if (Object.keys(index).length === 0) {
    return { success: true, synced: 0, message: '文件索引为空，无需同步' };
  }

  const results = [];

  for (const [, fileInfo] of Object.entries(index)) {
    const syncResult = await localSync(fileInfo);
    if (syncResult.success && syncResult.syncedNodes.length > 0) {
      for (const nodeId of syncResult.syncedNodes) {
        results.push({ cid: fileInfo.cid, nodeId, fromNode: fileInfo.storedNodes[0] });
      }
    }
  }

  return {
    success: true,
    synced: results.length,
    details: results
  };
}

/**
 * 获取同步状态
 */
export async function getSyncStatus() {
  const { IndexStore } = await import('./index-store.js');
  const indexStore = new IndexStore(NODES_DIR);
  await indexStore.init();
  const index = await indexStore.getAll();
  const files = Object.values(index);

  if (files.length === 0) {
    return { files: 0, nodes: 0, coverage: '0.0%' };
  }

  // 统计所有节点
  const nodeDirs = await fs.readdir(NODES_DIR);
  const nodes = nodeDirs.filter(d => d.startsWith('node-'));

  let totalReplicas = 0;
  for (const f of files) {
    totalReplicas += (f.storedNodes || []).length;
  }

  const maxReplicas = files.length * nodes.length;
  const coverage = maxReplicas > 0 ? (totalReplicas / maxReplicas * 100).toFixed(1) : 0;

  return {
    files: files.length,
    nodes: nodes.length,
    totalReplicas,
    coverage: `${coverage}%`
  };
}

export default {
  localSync,
  broadcastFileSync,
  startFileSyncListener,
  fullSync,
  getSyncStatus
};
