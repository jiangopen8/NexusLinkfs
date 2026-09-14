/**
 * IPFS 分布式存储网络 - 节点管理器
 * 负责节点身份创建、生命周期管理、存储配额分配
 */

import { keys } from '@libp2p/crypto';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { exportPeerId, importPeerId } from './peer-id-utils.js';
import HardwareAssessor from './hardware-assessor.js';
import fs from 'fs-extra';
import path from 'path';

const NODES_DIR = '/home/project/.ipfs-nodes';
const DEFAULT_NODE_COUNT = 3;
const STORAGE_RESERVE_RATIO = 0.7; // 保留 30% 给系统
const MAX_QUOTA_PER_NODE = 100 * 1024 * 1024; // 单节点上限 100MB
const BASE_P2P_PORT = 9500; // libp2p WebSocket 基础端口

// 延迟导入 libp2p 网络模块（避免不需要真实网络时的加载开销）
let libp2pNetwork = null;
async function getLibp2pNetwork() {
  if (!libp2pNetwork) {
    libp2pNetwork = await import('./libp2p-network.js');
  }
  return libp2pNetwork;
}

export class NodeManager {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.nodes = new Map();
    this.assessor = new HardwareAssessor(nodesDir);
  }

  /**
   * 根据硬件配置评估推荐节点数（3-100）
   */
  async getRecommendedNodeCount() {
    const assessment = await this.assessor.assess();
    return assessment.recommendedNodes;
  }

  /**
   * 获取完整硬件评估报告
   */
  async getHardwareAssessment() {
    return await this.assessor.assess();
  }

  /**
   * 初始化存储网络（自动评估硬件配置）
   */
  async init() {
    await fs.ensureDir(this.nodesDir);

    const diskInfo = await this.getDiskInfo();
    const assessment = await this.assessor.assess();
    const networkConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      diskInfo,
      hardware: {
        recommendedNodes: assessment.recommendedNodes,
        bottleneck: assessment.bottleneck,
        quotaPerNode: assessment.quotaPerNode,
        totalCapacity: assessment.totalCapacity
      },
      nodeCount: 0,
      totalQuota: 0,
      usedSpace: 0
    };

    await fs.writeJson(
      path.join(this.nodesDir, 'network.json'),
      networkConfig,
      { spaces: 2 }
    );

    return { success: true, diskInfo, assessment, nodesDir: this.nodesDir };
  }

  /**
   * 获取磁盘信息
   */
  async getDiskInfo() {
    try {
      const stats = await fs.statfs(this.nodesDir);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usableBytes = Math.floor(freeBytes * STORAGE_RESERVE_RATIO);

      return {
        totalBytes,
        freeBytes,
        usableBytes,
        totalHuman: this.formatBytes(totalBytes),
        freeHuman: this.formatBytes(freeBytes),
        usableHuman: this.formatBytes(usableBytes)
      };
    } catch (err) {
      // 降级方案：使用固定估算值
      return {
        totalBytes: 10 * 1024 * 1024 * 1024,
        freeBytes: 5 * 1024 * 1024 * 1024,
        usableBytes: Math.floor(5 * 1024 * 1024 * 1024 * STORAGE_RESERVE_RATIO),
        totalHuman: '10 GB',
        freeHuman: '5 GB',
        usableHuman: '3.5 GB'
      };
    }
  }

  /**
   * 创建节点身份
   */
  async createIdentity(nodeId) {
    const privateKey = await keys.generateKeyPair('Ed25519');
    const peerId = peerIdFromPrivateKey(privateKey);
    const rawPublicKey = privateKey.publicKey.raw ?? privateKey.publicKey;
    const identity = {
      nodeId,
      peerId: peerId.toString(),
      peerIdBytes: exportPeerId(peerId),
      createdAt: new Date().toISOString(),
      publicKey: Buffer.from(rawPublicKey).toString('base64')
    };

    const nodeDir = path.join(this.nodesDir, nodeId);
    await fs.ensureDir(nodeDir);
    await fs.writeJson(path.join(nodeDir, 'identity.json'), identity, { spaces: 2 });

    return identity;
  }

  /**
   * 加载节点身份
   */
  async loadIdentity(nodeId) {
    const identityPath = path.join(this.nodesDir, nodeId, 'identity.json');
    if (!await fs.pathExists(identityPath)) {
      return null;
    }
    return await fs.readJson(identityPath);
  }

  /**
   * 计算节点存储配额
   * 单节点上限 100MB，即使磁盘空间充足也不超过此限制
   */
  async calculateQuota(nodeCount = DEFAULT_NODE_COUNT) {
    const diskInfo = await this.getDiskInfo();
    const rawQuota = Math.floor(diskInfo.usableBytes / nodeCount);
    // 应用 100MB 上限
    const quotaPerNode = Math.min(rawQuota, MAX_QUOTA_PER_NODE);

    return {
      nodeCount,
      quotaPerNode,
      quotaHuman: this.formatBytes(quotaPerNode),
      totalQuota: quotaPerNode * nodeCount,
      totalQuotaHuman: this.formatBytes(quotaPerNode * nodeCount),
      cappedByLimit: rawQuota > MAX_QUOTA_PER_NODE
    };
  }

  /**
   * 启动存储节点
   * @param {string} nodeId - 节点 ID
   * @param {object} options - { nodeCount, port, withP2P }
   */
  async startNode(nodeId, options = {}) {
    const nodeDir = path.join(this.nodesDir, nodeId);
    await fs.ensureDir(nodeDir);

    // 加载或创建身份
    let identity = await this.loadIdentity(nodeId);
    if (!identity) {
      identity = await this.createIdentity(nodeId);
    }

    // 计算配额
    const quota = await this.calculateQuota(options.nodeCount || DEFAULT_NODE_COUNT);

    // 分配 P2P 端口
    const nodeIndex = parseInt(nodeId.split('-')[1] || '0');
    const p2pPort = options.port || (BASE_P2P_PORT + nodeIndex);

    // 创建节点配置
    const nodeConfig = {
      nodeId,
      peerId: identity.peerId,
      status: 'running',
      startedAt: new Date().toISOString(),
      quota: quota.quotaPerNode,
      usedSpace: 0,
      files: [],
      connections: [],
      port: p2pPort,
      p2pEnabled: options.withP2P || false,
      multiaddr: `/ip4/127.0.0.1/tcp/${p2pPort}/ws/p2p/${identity.peerId}`
    };

    await fs.writeJson(path.join(nodeDir, 'config.json'), nodeConfig, { spaces: 2 });
    this.nodes.set(nodeId, nodeConfig);

    return nodeConfig;
  }

  /**
   * 启动真实 libp2p 网络（所有节点互联）
   * 此方法会保持进程运行，适合作为守护进程使用
   */
  async startP2PNetwork(nodeCount = DEFAULT_NODE_COUNT) {
    const network = await getLibp2pNetwork();
    const nodes = [];

    // 启动所有节点的 libp2p 实例
    for (let i = 0; i < nodeCount; i++) {
      const nodeId = `node-${i}`;
      const port = BASE_P2P_PORT + i;

      const result = await network.startLibp2pNode(nodeId, { port });
      nodes.push(result);

      // 更新或创建节点配置（daemon 可独立于 node start 运行）
      const configPath = path.join(this.nodesDir, nodeId, 'config.json');
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        config.multiaddr = result.multiaddrs[0];
        config.p2pEnabled = true;
        config.status = 'running';
        await fs.writeJson(configPath, config, { spaces: 2 });
      } else {
        // 节点未通过 node start 创建，自动初始化存储配置
        const identity = await this.createIdentity(nodeId);
        const quota = await this.calculateQuota(nodeCount);
        const nodeConfig = {
          nodeId,
          peerId: identity.peerId,
          status: 'running',
          startedAt: new Date().toISOString(),
          quota: quota.quotaPerNode,
          usedSpace: 0,
          files: [],
          connections: [],
          port,
          p2pEnabled: true,
          multiaddr: result.multiaddrs[0]
        };
        await fs.ensureDir(path.join(this.nodesDir, nodeId));
        await fs.writeJson(configPath, nodeConfig, { spaces: 2 });
      }
    }

    // 节点互联：全网格拓扑（每个节点连接到所有其他节点）
    // 全网格确保 gossipsub mesh 能正确建立
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        try {
          await network.connectToPeer(nodes[i].nodeId, nodes[j].multiaddrs[0]);
        } catch (err) {
          // 连接失败不阻断启动
        }
      }
    }

    // 等待连接稳定
    await new Promise(r => setTimeout(r, 1000));

    return {
      nodes: nodes.map(n => ({
        nodeId: n.nodeId,
        peerId: n.peerId,
        multiaddr: n.multiaddrs[0],
        peers: network.getPeers(n.nodeId).length
      })),
      totalConnections: nodes.reduce((sum, n) => sum + network.getPeers(n.nodeId).length, 0)
    };
  }

  /**
   * 启动节点集群
   * @param {number|null} nodeCount - 节点数量，null 时自动根据硬件评估
   */
  async startCluster(nodeCount = null) {
    // 未指定节点数时，自动根据硬件配置评估
    if (nodeCount === null || nodeCount === undefined) {
      nodeCount = await this.getRecommendedNodeCount();
    }

    const results = [];
    const quota = await this.calculateQuota(nodeCount);

    for (let i = 0; i < nodeCount; i++) {
      const nodeId = `node-${i}`;
      const config = await this.startNode(nodeId, { nodeCount });
      results.push(config);
    }

    // 更新网络配置
    await this.updateNetworkConfig({
      nodeCount,
      totalQuota: quota.totalQuota
    });

    return { nodes: results, quota, autoAssessed: nodeCount === await this.getRecommendedNodeCount() };
  }

  /**
   * 停止节点
   */
  async stopNode(nodeId) {
    const nodeDir = path.join(this.nodesDir, nodeId);
    const configPath = path.join(nodeDir, 'config.json');

    if (!await fs.pathExists(configPath)) {
      return { success: false, error: `节点 ${nodeId} 不存在` };
    }

    const config = await fs.readJson(configPath);
    config.status = 'stopped';
    config.stoppedAt = new Date().toISOString();
    await fs.writeJson(configPath, config, { spaces: 2 });

    this.nodes.delete(nodeId);
    return { success: true, nodeId };
  }

  /**
   * 恢复已停止的节点（保留原有数据）
   */
  async restoreNode(nodeId) {
    const nodeDir = path.join(this.nodesDir, nodeId);
    const configPath = path.join(nodeDir, 'config.json');

    if (!await fs.pathExists(configPath)) {
      return { success: false, error: `节点 ${nodeId} 不存在` };
    }

    const config = await fs.readJson(configPath);
    config.status = 'running';
    config.restoredAt = new Date().toISOString();
    delete config.stoppedAt;
    await fs.writeJson(configPath, config, { spaces: 2 });

    this.nodes.set(nodeId, config);

    // 更新网络配置中的节点数
    const allNodes = await this.listNodes();
    const runningCount = allNodes.filter(n => n.status === 'running').length;
    await this.updateNetworkConfig({ nodeCount: runningCount });

    return { success: true, nodeId, config };
  }

  /**
   * 获取节点状态
   */
  async getNodeStatus(nodeId) {
    const nodeDir = path.join(this.nodesDir, nodeId);
    const configPath = path.join(nodeDir, 'config.json');

    if (!await fs.pathExists(configPath)) {
      return null;
    }

    return await fs.readJson(configPath);
  }

  /**
   * 列出所有节点
   */
  async listNodes() {
    const nodes = [];
    
    if (!await fs.pathExists(this.nodesDir)) {
      return nodes;
    }

    const dirs = await fs.readdir(this.nodesDir);
    for (const dir of dirs) {
      if (dir.startsWith('node-')) {
        const status = await this.getNodeStatus(dir);
        if (status) {
          nodes.push(status);
        }
      }
    }

    return nodes;
  }

  /**
   * 添加新节点（扩容）
   */
  async addNode() {
    const existingNodes = await this.listNodes();
    const newNodeId = `node-${existingNodes.length}`;
    
    const config = await this.startNode(newNodeId, {
      nodeCount: existingNodes.length + 1
    });

    await this.updateNetworkConfig({
      nodeCount: existingNodes.length + 1
    });

    return config;
  }

  /**
   * 移除节点（含数据迁移选项）
   * @param {string} nodeId - 节点 ID
   * @param {object} options - { migrate: boolean } 是否先迁移数据
   */
  async removeNode(nodeId, options = {}) {
    const { migrate = false } = options;
    const nodeDir = path.join(this.nodesDir, nodeId);

    if (!await fs.pathExists(nodeDir)) {
      return { success: false, error: `节点 ${nodeId} 不存在` };
    }

    let migrationResult = null;

    // 数据迁移：将节点上的所有 block 转移到其他节点
    if (migrate) {
      migrationResult = await this.migrateNodeData(nodeId);
      if (!migrationResult.success) {
        return { success: false, error: `数据迁移失败: ${migrationResult.error}` };
      }
    }

    // 先停止节点
    await this.stopNode(nodeId);

    // 删除节点目录
    await fs.remove(nodeDir);

    const remainingNodes = await this.listNodes();
    await this.updateNetworkConfig({
      nodeCount: remainingNodes.length
    });

    return {
      success: true,
      nodeId,
      remainingNodes: remainingNodes.length,
      migration: migrationResult
    };
  }

  /**
   * 节点数据迁移：将源节点的所有 block 转移到其他 running 节点
   * 商用级保证：移除节点前数据不丢失
   * @param {string} sourceNodeId - 源节点 ID
   * @returns {object} 迁移结果
   */
  async migrateNodeData(sourceNodeId) {
    const sourceBlocksDir = path.join(this.nodesDir, sourceNodeId, 'blocks');
    if (!await fs.pathExists(sourceBlocksDir)) {
      return { success: true, migrated: 0, message: '节点无数据' };
    }

    // 获取目标节点（排除源节点，按剩余空间排序）
    const allNodes = await this.listNodes();
    const targetNodes = allNodes
      .filter(n => n.nodeId !== sourceNodeId && n.status === 'running')
      .sort((a, b) => (b.quota - b.usedSpace) - (a.quota - a.usedSpace));

    if (targetNodes.length === 0) {
      return { success: false, error: '无可用目标节点进行数据迁移' };
    }

    // 读取源节点所有 block
    const files = await fs.readdir(sourceBlocksDir);
    const blockFiles = files.filter(f => f.endsWith('.block'));
    const result = {
      success: true,
      migrated: 0,
      failed: 0,
      skipped: 0,
      details: []
    };

    // 加载索引用于更新 storedNodes
    const indexPath = path.join(this.nodesDir, 'index.json');
    let index = {};
    if (await fs.pathExists(indexPath)) {
      index = await fs.readJson(indexPath);
    }

    for (const blockFile of blockFiles) {
      const cid = blockFile.replace('.block', '');
      const sourcePath = path.join(sourceBlocksDir, blockFile);
      const content = await fs.readFile(sourcePath);

      // 找到有足够空间的目标节点
      let migrated = false;
      for (const target of targetNodes) {
        const availableSpace = target.quota - (target.usedSpace || 0);
        if (availableSpace < content.length) continue;

        // 检查目标节点是否已有该 block（去重）
        const targetBlockPath = path.join(this.nodesDir, target.nodeId, 'blocks', blockFile);
        if (await fs.pathExists(targetBlockPath)) {
          result.skipped++;
          migrated = true;
          break;
        }

        try {
          // 写入目标节点
          const targetDir = path.join(this.nodesDir, target.nodeId, 'blocks');
          await fs.ensureDir(targetDir);
          await fs.writeFile(targetBlockPath, content);

          // 复制元数据
          const sourceMetaPath = path.join(sourceBlocksDir, `${cid}.meta.json`);
          if (await fs.pathExists(sourceMetaPath)) {
            const meta = await fs.readJson(sourceMetaPath);
            meta.migratedFrom = sourceNodeId;
            meta.migratedAt = new Date().toISOString();
            await fs.writeJson(
              path.join(targetDir, `${cid}.meta.json`),
              meta,
              { spaces: 2 }
            );
          }

          // 更新目标节点配额
          const targetConfigPath = path.join(this.nodesDir, target.nodeId, 'config.json');
          const targetConfig = await fs.readJson(targetConfigPath);
          targetConfig.usedSpace = (targetConfig.usedSpace || 0) + content.length;
          await fs.writeJson(targetConfigPath, targetConfig, { spaces: 2 });

          // 更新索引中的 storedNodes
          if (index[cid]) {
            const nodes = index[cid].storedNodes || [];
            const idx = nodes.indexOf(sourceNodeId);
            if (idx !== -1) {
              nodes[idx] = target.nodeId;
            } else if (!nodes.includes(target.nodeId)) {
              nodes.push(target.nodeId);
            }
            index[cid].storedNodes = nodes;
            index[cid].lastMigrationAt = new Date().toISOString();
          }

          result.migrated++;
          result.details.push({ cid, from: sourceNodeId, to: target.nodeId });
          migrated = true;

          // 更新内存中的目标节点剩余空间
          target.usedSpace = (target.usedSpace || 0) + content.length;
          break;
        } catch (err) {
          continue; // 尝试下一个目标节点
        }
      }

      if (!migrated) {
        result.failed++;
        result.details.push({ cid, from: sourceNodeId, to: null, error: '无足够空间的目标节点' });
      }
    }

    // 原子写入更新后的索引
    if (Object.keys(index).length > 0) {
      const tmpPath = indexPath + '.tmp';
      await fs.writeJson(tmpPath, index, { spaces: 2 });
      await fs.rename(tmpPath, indexPath);
    }

    if (result.failed > 0) {
      result.success = false;
      result.error = `${result.failed} 个文件迁移失败（目标节点空间不足）`;
    }

    return result;
  }

  /**
   * 更新网络配置
   */
  async updateNetworkConfig(updates) {
    const configPath = path.join(this.nodesDir, 'network.json');
    let config = {};

    if (await fs.pathExists(configPath)) {
      config = await fs.readJson(configPath);
    }

    Object.assign(config, updates, { updatedAt: new Date().toISOString() });
    await fs.writeJson(configPath, config, { spaces: 2 });
    return config;
  }

  /**
   * 格式化字节数
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export default NodeManager;
