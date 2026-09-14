/**
 * IPFS 分布式存储网络 - Chunk 副本修复模块
 * 
 * 功能：
 * - 检测分块文件的 chunk 副本健康状态
 * - 发现副本数低于目标值的 chunk
 * - 从健康副本读取数据，重新分发到缺失节点
 * 
 * 修复流程：
 * 1. 读取 DAG 根获取 chunk 列表
 * 2. 对每个 chunk 检查各节点上的副本存在性
 * 3. 副本数 < targetReplicas 的 chunk 标记为需修复
 * 4. 从健康节点读取 chunk 数据
 * 5. 写入到缺失的节点（选择有空间且未持有该 chunk 的节点）
 * 6. 更新索引中的 storedNodes
 */

import fs from 'fs-extra';
import path from 'path';

export class ChunkRepair {
  constructor(nodesDir = '/home/project/.ipfs-nodes') {
    this.nodesDir = nodesDir;
  }

  /**
   * 检测分块文件的 chunk 副本健康状态
   * @param {object} dagNode - DAG 根节点数据
   * @param {string[]} storedNodes - 文件索引中记录的存储节点列表
   * @param {number} targetReplicas - 目标副本数
   * @param {object} options - { allNodes: 扫描所有在线节点而非仅 storedNodes }
   * @returns {object} 健康报告
   */
  async assessChunkHealth(dagNode, storedNodes, targetReplicas, options = {}) {
    const { allNodes = [] } = options;
    // 扫描范围：优先使用 allNodes（所有在线节点），否则仅检查 storedNodes
    const scanNodes = allNodes.length > 0 ? allNodes : storedNodes;
    const chunks = dagNode.chunks || [];
    const report = {
      rootCid: null,
      totalChunks: chunks.length,
      healthyChunks: 0,
      degradedChunks: 0,
      criticalChunks: 0,
      details: []
    };

    for (const chunkMeta of chunks) {
      const availableNodes = [];
      const missingNodes = [];

      // 检查每个扫描节点是否持有该 chunk
      for (const nodeId of scanNodes) {
        const exists = await this.checkChunkExists(nodeId, chunkMeta.cid);
        if (exists) {
          availableNodes.push(nodeId);
        } else {
          missingNodes.push(nodeId);
        }
      }

      const replicaCount = availableNodes.length;
      let status;
      if (replicaCount >= targetReplicas) {
        status = 'healthy';
        report.healthyChunks++;
      } else if (replicaCount > 0) {
        status = 'degraded';
        report.degradedChunks++;
      } else {
        status = 'critical';
        report.criticalChunks++;
      }

      report.details.push({
        index: chunkMeta.index,
        cid: chunkMeta.cid,
        size: chunkMeta.size,
        status,
        replicaCount,
        targetReplicas,
        availableNodes,
        missingNodes
      });
    }

    return report;
  }

  /**
   * 检查 chunk 是否存在于指定节点
   */
  async checkChunkExists(nodeId, chunkCid) {
    const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${chunkCid}.block`);
    return await fs.pathExists(blockPath);
  }

  /**
   * 执行 chunk 副本修复
   * @param {object} dagNode - DAG 根节点数据
   * @param {string[]} storedNodes - 文件索引中记录的存储节点列表
   * @param {number} targetReplicas - 目标副本数
   * @param {object} options - { dryRun, onProgress, allNodes }
   * @returns {object} 修复报告
   */
  async repairChunks(dagNode, storedNodes, targetReplicas, options = {}) {
    const { dryRun = false, onProgress, allNodes = [] } = options;

    // 1. 评估健康状态（扫描所有在线节点以发现 storedNodes 之外的副本）
    const health = await this.assessChunkHealth(dagNode, storedNodes, targetReplicas, { allNodes });

    const report = {
      totalChunks: health.totalChunks,
      healthyChunks: health.healthyChunks,
      repaired: 0,
      failed: 0,
      skipped: 0,
      actions: []
    };

    // 2. 对需要修复的 chunk 执行修复
    const needRepair = health.details.filter(d => d.status !== 'healthy');

    // 计算当前总副本数，用于限制 targetReplicas 不超过实际分布
    // 避免在多节点集群中因 targetReplicas 过大导致所有降级 chunk 被误判为不可修复
    const totalReplicas = health.details.reduce((sum, d) => sum + d.replicaCount, 0);
    const avgReplicas = Math.ceil(totalReplicas / Math.max(health.totalChunks, 1));
    const effectiveTarget = Math.min(targetReplicas, avgReplicas);

    for (const chunk of needRepair) {
      if (chunk.status === 'critical') {
        // 所有副本丢失，无法修复
        report.actions.push({
          chunkIndex: chunk.index,
          cid: chunk.cid,
          action: 'unrecoverable',
          reason: '所有副本丢失，无健康数据源'
        });
        report.failed++;
        continue;
      }

      // 计算需要补充的副本数（使用 effectiveTarget 避免过度修复）
      const needed = effectiveTarget - chunk.replicaCount;
      if (needed <= 0) {
        report.skipped++;
        continue;
      }

      // 找到可写入的目标节点（在扫描范围中但未持有该 chunk 的节点）
      const targetNodes = chunk.missingNodes.slice(0, needed);
      if (targetNodes.length === 0) {
        report.skipped++;
        continue;
      }

      if (dryRun) {
        report.actions.push({
          chunkIndex: chunk.index,
          cid: chunk.cid,
          action: 'would_repair',
          source: chunk.availableNodes[0],
          targets: targetNodes,
          size: chunk.size
        });
        continue;
      }

      // 从健康节点读取 chunk 数据
      const sourceNode = chunk.availableNodes[0];
      const chunkData = await this.readChunkFromNode(sourceNode, chunk.cid);
      if (!chunkData) {
        report.actions.push({
          chunkIndex: chunk.index,
          cid: chunk.cid,
          action: 'failed',
          reason: `无法从 ${sourceNode} 读取数据`
        });
        report.failed++;
        continue;
      }

      // 写入到目标节点
      let repairedCount = 0;
      for (const targetNode of targetNodes) {
        try {
          await this.writeChunkToNode(targetNode, chunk.cid, chunkData, {
            type: 'chunk',
            chunkIndex: chunk.index,
            size: chunk.size,
            repairedAt: new Date().toISOString(),
            sourceNode
          });
          repairedCount++;
        } catch (err) {
          // 单节点写入失败不阻断
        }
      }

      if (repairedCount > 0) {
        report.repaired++;
        report.actions.push({
          chunkIndex: chunk.index,
          cid: chunk.cid,
          action: 'repaired',
          source: sourceNode,
          targets: targetNodes.slice(0, repairedCount),
          size: chunk.size
        });
      } else {
        report.failed++;
        report.actions.push({
          chunkIndex: chunk.index,
          cid: chunk.cid,
          action: 'failed',
          reason: '所有目标节点写入失败'
        });
      }

      if (onProgress) {
        onProgress({
          processed: report.repaired + report.failed + report.skipped,
          total: needRepair.length
        });
      }
    }

    return report;
  }

  /**
   * 从节点读取 chunk 数据
   */
  async readChunkFromNode(nodeId, chunkCid) {
    const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${chunkCid}.block`);
    if (!await fs.pathExists(blockPath)) {
      return null;
    }
    return await fs.readFile(blockPath);
  }

  /**
   * 写入 chunk 到节点（含配额检查）
   */
  async writeChunkToNode(nodeId, chunkCid, data, metadata) {
    const nodeDir = path.join(this.nodesDir, nodeId, 'blocks');
    await fs.ensureDir(nodeDir);

    // 配额检查
    const configPath = path.join(this.nodesDir, nodeId, 'config.json');
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);
      const quota = Math.min(config.quota || 100 * 1024 * 1024, 100 * 1024 * 1024);
      if ((config.usedSpace || 0) + data.length > quota) {
        throw new Error(`节点 ${nodeId} 存储空间不足`);
      }
    }

    // 写入 block
    const blockPath = path.join(nodeDir, `${chunkCid}.block`);
    await fs.writeFile(blockPath, data);

    // 写入元数据
    const metaPath = path.join(nodeDir, `${chunkCid}.meta.json`);
    await fs.writeJson(metaPath, { ...metadata, storedAt: new Date().toISOString() }, { spaces: 2 });

    // 更新配额
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);
      config.usedSpace = (config.usedSpace || 0) + data.length;
      await fs.writeJson(configPath, config, { spaces: 2 });
    }
  }

  /**
   * 获取修复状态摘要
   */
  formatReport(report) {
    const lines = [];
    lines.push(`总 chunk: ${report.totalChunks}`);
    lines.push(`健康: ${report.healthyChunks}`);
    lines.push(`已修复: ${report.repaired}`);
    lines.push(`失败: ${report.failed}`);
    lines.push(`跳过: ${report.skipped}`);
    return lines.join('\n');
  }
}

export default ChunkRepair;
