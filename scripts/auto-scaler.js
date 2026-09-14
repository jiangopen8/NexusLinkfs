/**
 * IPFS 分布式存储网络 - 节点自动伸缩器
 * 根据集群磁盘使用率自动缩容/扩容节点：
 * - 使用率超过上限阈值 → 停止最空闲节点（保留数据，可恢复）
 * - 使用率低于下限阈值 → 恢复已停止节点或新增节点
 * - 节点数始终保持在 [minNodes, maxNodes] 范围内
 */

import fs from 'fs-extra';
import path from 'path';

const NODES_DIR = '/home/project/.ipfs-nodes';
const MIN_NODES = 3;
const MAX_NODES = 100;
const SCALE_UP_THRESHOLD = 0.5;   // 使用率低于 50% 时扩容
const SCALE_DOWN_THRESHOLD = 0.8; // 使用率超过 80% 时缩容
const SCALE_STEP = 1;             // 每次伸缩 1 个节点
const SCALE_CONFIG_FILE = 'autoscale.json';

export class AutoScaler {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
  }

  /**
   * 读取伸缩配置（可通过 node autoscale config 修改）
   */
  async getConfig() {
    const configPath = path.join(this.nodesDir, SCALE_CONFIG_FILE);
    const defaults = {
      enabled: true,
      scaleUpThreshold: SCALE_UP_THRESHOLD,
      scaleDownThreshold: SCALE_DOWN_THRESHOLD,
      minNodes: MIN_NODES,
      maxNodes: MAX_NODES,
      scaleStep: SCALE_STEP
    };
    if (await fs.pathExists(configPath)) {
      const saved = await fs.readJson(configPath);
      return { ...defaults, ...saved };
    }
    return defaults;
  }

  /**
   * 保存伸缩配置
   */
  async saveConfig(config) {
    const configPath = path.join(this.nodesDir, SCALE_CONFIG_FILE);
    await fs.writeJson(configPath, config, { spaces: 2 });
    return config;
  }

  /**
   * 获取集群存储统计
   */
  async getClusterStats() {
    const dirs = await fs.readdir(this.nodesDir).catch(() => []);
    const running = [];
    const stopped = [];
    let totalQuota = 0;
    let totalUsed = 0;

    for (const dir of dirs) {
      if (!dir.startsWith('node-')) continue;
      const configPath = path.join(this.nodesDir, dir, 'config.json');
      if (!await fs.pathExists(configPath)) continue;
      const config = await fs.readJson(configPath);
      const entry = {
        nodeId: dir,
        status: config.status,
        quota: config.quota || 0,
        usedSpace: config.usedSpace || 0,
        fileCount: (config.files || []).length
      };
      if (config.status === 'running') {
        running.push(entry);
        totalQuota += entry.quota;
        totalUsed += entry.usedSpace;
      } else {
        stopped.push(entry);
      }
    }

    const usageRate = totalQuota > 0 ? totalUsed / totalQuota : 0;
    return { running, stopped, totalQuota, totalUsed, usageRate };
  }

  /**
   * 执行一次伸缩决策
   * 返回 { action, reason, details }
   */
  async evaluate(nodeManager) {
    const config = await this.getConfig();
    const stats = await this.getClusterStats();
    const runningCount = stats.running.length;

    // 无运行节点时不做缩容判断
    if (runningCount === 0) {
      return { action: 'none', reason: '无运行中的节点', stats, config };
    }

    // ── 缩容判断 ──
    if (stats.usageRate >= config.scaleDownThreshold && runningCount > config.minNodes) {
      const removable = runningCount - config.minNodes;
      const count = Math.min(config.scaleStep, removable);
      const details = [];

      // 选择最空闲的节点停止
      const sorted = [...stats.running].sort((a, b) => a.usedSpace - b.usedSpace);
      for (let i = 0; i < count; i++) {
        const target = sorted[i];
        await nodeManager.stopNode(target.nodeId);
        details.push({
          nodeId: target.nodeId,
          usedSpace: target.usedSpace,
          fileCount: target.fileCount,
          action: 'stopped'
        });
      }

      return {
        action: 'scale_down',
        reason: `使用率 ${(stats.usageRate * 100).toFixed(1)}% ≥ 阈值 ${(config.scaleDownThreshold * 100).toFixed(0)}%，停止 ${count} 个最空闲节点`,
        details,
        stats,
        config
      };
    }

    // ── 扩容判断 ──
    if (stats.usageRate <= config.scaleUpThreshold && runningCount < config.maxNodes) {
      const count = Math.min(config.scaleStep, config.maxNodes - runningCount);
      const details = [];

      for (let i = 0; i < count; i++) {
        // 优先恢复已停止的节点（数据仍在）
        if (stats.stopped.length > i) {
          const target = stats.stopped[i];
          await nodeManager.restoreNode(target.nodeId);
          details.push({ nodeId: target.nodeId, action: 'restored' });
        } else {
          // 无已停止节点可恢复，新增节点
          const newConfig = await nodeManager.addNode();
          details.push({ nodeId: newConfig.nodeId, action: 'added' });
        }
      }

      return {
        action: 'scale_up',
        reason: `使用率 ${(stats.usageRate * 100).toFixed(1)}% ≤ 阈值 ${(config.scaleUpThreshold * 100).toFixed(0)}%，扩容 ${count} 个节点`,
        details,
        stats,
        config
      };
    }

    return {
      action: 'none',
      reason: `使用率 ${(stats.usageRate * 100).toFixed(1)}% 在正常区间 [${(config.scaleUpThreshold * 100).toFixed(0)}%, ${(config.scaleDownThreshold * 100).toFixed(0)}%]，无需伸缩`,
      stats,
      config
    };
  }

  /**
   * 获取伸缩状态报告
   */
  async getStatus() {
    const config = await this.getConfig();
    const stats = await this.getClusterStats();

    let recommendation = '维持现状';
    if (stats.running.length > 0) {
      if (stats.usageRate >= config.scaleDownThreshold && stats.running.length > config.minNodes) {
        recommendation = '建议缩容（使用率过高）';
      } else if (stats.usageRate <= config.scaleUpThreshold && stats.running.length < config.maxNodes) {
        recommendation = '建议扩容（使用率过低）';
      }
    }

    return {
      config,
      runningNodes: stats.running.length,
      stoppedNodes: stats.stopped.length,
      totalQuota: stats.totalQuota,
      totalUsed: stats.totalUsed,
      usageRate: stats.usageRate,
      usagePercent: (stats.usageRate * 100).toFixed(1) + '%',
      recommendation
    };
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

export default AutoScaler;
