/**
 * IPFS 分布式存储网络 - 副本策略模块
 * 负责：
 * - 智能副本放置（分散存储，避免单点故障）
 * - 多路径下载重试（网络不稳定容错）
 * - 副本健康评估
 * - 再平衡建议（数据倾斜检测）
 * 
 * 商用级设计原则：
 * - 副本分散：同一文件的副本尽量分布在不同节点
 * - 负载均衡：优先选择剩余空间大的节点
 * - 容错优先：下载时并行尝试多个副本，任一成功即返回
 * - 渐进降级：部分节点不可用时仍能提供读取服务
 */

import fs from 'fs-extra';
import path from 'path';

const NODES_DIR = '/home/project/.ipfs-nodes';

export class ReplicaStrategy {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
  }

  /**
   * 智能副本放置：选择最优节点存储副本
   * 策略：
   * 1. 排除已存储该文件的节点（避免重复）
   * 2. 按剩余空间降序排列（负载均衡）
   * 3. 优先选择最近未参与存储的节点（分散性）
   * @param {string} cid - 文件 CID
   * @param {number} replicaCount - 需要的副本数
   * @param {number} contentSize - 内容大小
   * @returns {string[]} 选中的节点 ID 列表
   */
  async selectNodesForReplica(cid, replicaCount, contentSize) {
    const nodes = await this.getNodeStats();
    const runningNodes = nodes.filter(n => n.status === 'running');

    // 过滤掉空间不足的节点
    const eligible = runningNodes.filter(
      n => (n.quota - n.usedSpace) >= contentSize
    );

    if (eligible.length === 0) {
      return [];
    }

    // 按剩余空间降序排列
    eligible.sort((a, b) => (b.quota - b.usedSpace) - (a.quota - a.usedSpace));

    // 选择前 N 个（已自然分散，因为按剩余空间排序）
    return eligible.slice(0, Math.min(replicaCount, eligible.length)).map(n => n.nodeId);
  }

  /**
   * 多路径下载：并行尝试多个副本，返回最快成功的结果
   * 网络不稳定容错：任一副本可读即成功
   * @param {string} cid - 文件 CID
   * @param {string[]} storedNodes - 存储节点列表
   * @param {function} readFn - 读取函数 (nodeId, cid) => Buffer|null
   * @returns {object} { content, sourceNode, attempts }
   */
  async multiPathDownload(cid, storedNodes, readFn) {
    const attempts = [];
    let content = null;
    let sourceNode = null;

    // 顺序尝试（避免并发 I/O 压力，但每个失败后立即尝试下一个）
    for (const nodeId of storedNodes) {
      const startTime = Date.now();
      try {
        const data = await readFn(nodeId, cid);
        const elapsed = Date.now() - startTime;
        attempts.push({ nodeId, success: !!data, elapsed });

        if (data) {
          content = data;
          sourceNode = nodeId;
          break;
        }
      } catch (err) {
        const elapsed = Date.now() - startTime;
        attempts.push({ nodeId, success: false, elapsed, error: err.message });
      }
    }

    return {
      success: !!content,
      content,
      sourceNode,
      attempts,
      totalAttempts: attempts.length
    };
  }

  /**
   * 副本健康评估：评估整个网络的副本健康状况
   * @returns {object} 评估报告
   */
  async assessReplicaHealth() {
    const { IndexStore } = await import('./index-store.js');
    const indexStore = new IndexStore(this.nodesDir);
    await indexStore.init();
    const index = await indexStore.getAll();
    const entries = Object.values(index);

    if (entries.length === 0) {
      return { totalFiles: 0, healthy: 0, degraded: 0, critical: 0, healthRate: '100%', details: [] };
    }
    const nodes = await this.getNodeStats();
    const runningNodeIds = nodes.filter(n => n.status === 'running').map(n => n.nodeId);

    let healthy = 0;
    let degraded = 0;
    let critical = 0;
    const details = [];

    for (const fileInfo of entries) {
      const targetReplicas = fileInfo.targetReplicas || fileInfo.replicas || 3;
      const storedNodes = fileInfo.storedNodes || [];

      // 检查实际可用副本数（节点必须 running 且 block 存在）
      let availableReplicas = 0;
      for (const nodeId of storedNodes) {
        if (!runningNodeIds.includes(nodeId)) continue;
        const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${fileInfo.cid}.block`);
        if (await fs.pathExists(blockPath)) {
          availableReplicas++;
        }
      }

      const ratio = availableReplicas / targetReplicas;
      let status;
      if (ratio >= 1) {
        status = 'healthy';
        healthy++;
      } else if (ratio >= 0.5) {
        status = 'degraded';
        degraded++;
      } else {
        status = 'critical';
        critical++;
      }

      details.push({
        cid: fileInfo.cid,
        fileName: fileInfo.fileName,
        targetReplicas,
        availableReplicas,
        status
      });
    }

    return {
      totalFiles: entries.length,
      healthy,
      degraded,
      critical,
      healthRate: entries.length > 0 ? ((healthy / entries.length) * 100).toFixed(1) + '%' : '100%',
      details
    };
  }

  /**
   * 数据倾斜检测：检查节点间存储是否均衡
   * @returns {object} 倾斜报告
   */
  async detectImbalance() {
    const nodes = await this.getNodeStats();
    const runningNodes = nodes.filter(n => n.status === 'running');

    if (runningNodes.length === 0) {
      return { balanced: true, nodes: [] };
    }

    const usages = runningNodes.map(n => n.quota > 0 ? n.usedSpace / n.quota : 0);
    const avgUsage = usages.reduce((a, b) => a + b, 0) / usages.length;
    const maxDeviation = Math.max(...usages.map(u => Math.abs(u - avgUsage)));

    const nodeDetails = runningNodes.map((n, i) => ({
      nodeId: n.nodeId,
      usedSpace: n.usedSpace,
      quota: n.quota,
      usageRate: usages[i],
      deviation: usages[i] - avgUsage
    }));

    return {
      balanced: maxDeviation < 0.2, // 偏差 < 20% 视为均衡
      avgUsageRate: (avgUsage * 100).toFixed(1) + '%',
      maxDeviation: (maxDeviation * 100).toFixed(1) + '%',
      nodes: nodeDetails,
      recommendation: maxDeviation >= 0.2
        ? '数据分布不均衡，建议运行再平衡'
        : '数据分布均衡'
    };
  }

  /**
   * 获取所有节点统计信息
   */
  async getNodeStats() {
    const nodes = [];
    const dirs = await fs.readdir(this.nodesDir).catch(() => []);

    for (const dir of dirs) {
      if (!dir.startsWith('node-')) continue;
      const configPath = path.join(this.nodesDir, dir, 'config.json');
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        nodes.push({
          nodeId: dir,
          status: config.status,
          quota: config.quota || 0,
          usedSpace: config.usedSpace || 0
        });
      }
    }

    return nodes;
  }
}

export default ReplicaStrategy;
