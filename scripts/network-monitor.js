/**
 * IPFS 分布式存储网络 - 网络监控模块
 * 负责网络状态监控、节点发现、容量统计
 */

import fs from 'fs-extra';
import path from 'path';

const NODES_DIR = '/home/project/.ipfs-nodes';

export class NetworkMonitor {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
  }

  /**
   * 获取网络状态概览
   */
  async getNetworkStatus() {
    const networkConfig = await this.getNetworkConfig();
    const nodes = await this.getNodeList();
    const files = await this.getFileList();

    const runningNodes = nodes.filter(n => n.status === 'running');
    const totalQuota = nodes.reduce((sum, n) => sum + (n.quota || 0), 0);
    const totalUsed = nodes.reduce((sum, n) => sum + (n.usedSpace || 0), 0);
    const totalFiles = files.length;
    const totalFileSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

    return {
      network: {
        version: networkConfig.version || '1.0.0',
        createdAt: networkConfig.createdAt,
        nodeCount: nodes.length,
        runningNodes: runningNodes.length,
        stoppedNodes: nodes.length - runningNodes.length
      },
      storage: {
        totalQuota,
        totalQuotaHuman: this.formatBytes(totalQuota),
        totalUsed,
        totalUsedHuman: this.formatBytes(totalUsed),
        usagePercent: totalQuota > 0 ? ((totalUsed / totalQuota) * 100).toFixed(1) : 0
      },
      files: {
        count: totalFiles,
        totalSize: totalFileSize,
        totalSizeHuman: this.formatBytes(totalFileSize)
      },
      nodes: nodes.map(n => ({
        nodeId: n.nodeId,
        peerId: n.peerId,
        status: n.status,
        quota: this.formatBytes(n.quota || 0),
        used: this.formatBytes(n.usedSpace || 0),
        usagePercent: n.quota > 0 ? ((n.usedSpace / n.quota) * 100).toFixed(1) : 0
      }))
    };
  }

  /**
   * 获取网络配置
   */
  async getNetworkConfig() {
    const configPath = path.join(this.nodesDir, 'network.json');
    if (!await fs.pathExists(configPath)) {
      return {};
    }
    return await fs.readJson(configPath);
  }

  /**
   * 获取节点列表
   */
  async getNodeList() {
    const nodes = [];
    if (!await fs.pathExists(this.nodesDir)) {
      return nodes;
    }

    const dirs = await fs.readdir(this.nodesDir);
    for (const dir of dirs) {
      if (dir.startsWith('node-')) {
        const configPath = path.join(this.nodesDir, dir, 'config.json');
        if (await fs.pathExists(configPath)) {
          const config = await fs.readJson(configPath);
          nodes.push(config);
        }
      }
    }

    return nodes;
  }

  /**
   * 获取文件列表
   */
  async getFileList() {
    const indexPath = path.join(this.nodesDir, 'index.json');
    if (!await fs.pathExists(indexPath)) {
      return [];
    }

    const index = await fs.readJson(indexPath);
    return Object.values(index);
  }

  /**
   * 获取节点详情
   */
  async getNodeDetail(nodeId) {
    const nodeDir = path.join(this.nodesDir, nodeId);
    const configPath = path.join(nodeDir, 'config.json');
    const identityPath = path.join(nodeDir, 'identity.json');

    if (!await fs.pathExists(configPath)) {
      return null;
    }

    const config = await fs.readJson(configPath);
    let identity = null;

    if (await fs.pathExists(identityPath)) {
      identity = await fs.readJson(identityPath);
    }

    // 获取节点存储的文件
    const blocksDir = path.join(nodeDir, 'blocks');
    let storedFiles = [];

    if (await fs.pathExists(blocksDir)) {
      const files = await fs.readdir(blocksDir);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));
      
      for (const metaFile of metaFiles) {
        const meta = await fs.readJson(path.join(blocksDir, metaFile));
        storedFiles.push(meta);
      }
    }

    return {
      ...config,
      identity,
      storedFiles,
      quotaHuman: this.formatBytes(config.quota || 0),
      usedHuman: this.formatBytes(config.usedSpace || 0)
    };
  }

  /**
   * 检查节点健康状态
   */
  async healthCheck() {
    const nodes = await this.getNodeList();
    const results = [];

    for (const node of nodes) {
      const nodeDir = path.join(this.nodesDir, node.nodeId);
      const blocksDir = path.join(nodeDir, 'blocks');
      
      let blockCount = 0;
      if (await fs.pathExists(blocksDir)) {
        const files = await fs.readdir(blocksDir);
        blockCount = files.filter(f => f.endsWith('.block')).length;
      }

      results.push({
        nodeId: node.nodeId,
        status: node.status,
        healthy: node.status === 'running',
        blockCount,
        quotaUsage: node.quota > 0 ? (node.usedSpace / node.quota) : 0
      });
    }

    return {
      totalNodes: nodes.length,
      healthyNodes: results.filter(r => r.healthy).length,
      nodes: results
    };
  }

  /**
   * 网络容量预测
   */
  async capacityForecast() {
    const status = await this.getNetworkStatus();
    const { totalQuota, totalUsed } = status.storage;
    
    const remaining = totalQuota - totalUsed;
    const usageRate = totalQuota > 0 ? totalUsed / totalQuota : 0;

    return {
      currentUsage: this.formatBytes(totalUsed),
      remaining: this.formatBytes(remaining),
      usageRate: (usageRate * 100).toFixed(1) + '%',
      canAddNode: remaining > 100 * 1024 * 1024, // 至少 100MB 才能添加节点
      recommendation: usageRate > 0.8 
        ? '存储空间即将用尽，建议清理文件或扩容' 
        : usageRate > 0.5 
          ? '存储空间使用过半，注意监控' 
          : '存储空间充足'
    };
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export default NetworkMonitor;
