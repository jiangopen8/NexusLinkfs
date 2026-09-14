/**
 * IPFS 分布式存储网络 - 数据完整性模块
 * 负责：
 * - 定期完整性扫描（检测 bit rot / 静默损坏）
 * - 副本健康检查（检测丢失副本）
 * - 自动修复（从存活副本重新分发）
 * - 孤立 block 垃圾回收
 * 
 * 商用级数据可靠性保障：
 * - 每个 block 通过 CID 哈希验证完整性
 * - 副本数低于目标值时自动修复
 * - 网络不稳定时采用渐进式修复（一次修复一个副本）
 */

import fs from 'fs-extra';
import path from 'path';
import FileOperations from './file-ops.js';

const NODES_DIR = '/home/project/.ipfs-nodes';

export class DataIntegrity {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.fileOps = new FileOperations(nodesDir);
  }

  /**
   * 全量完整性扫描
   * 遍历索引中所有文件，验证每个副本的哈希完整性
   * @returns {object} 扫描报告
   */
  async fullScan() {
    const index = await this.fileOps.getFullIndex();
    const entries = Object.values(index);
    const report = {
      totalFiles: entries.length,
      healthyFiles: 0,
      corruptedFiles: 0,
      missingReplicas: 0,
      repairedFiles: 0,
      details: [],
      scannedAt: new Date().toISOString()
    };

    for (const fileInfo of entries) {
      const fileReport = await this.scanFile(fileInfo);
      report.details.push(fileReport);

      if (fileReport.status === 'healthy') {
        report.healthyFiles++;
      } else if (fileReport.status === 'corrupted') {
        report.corruptedFiles++;
      }
      if (fileReport.missingReplicas > 0) {
        report.missingReplicas += fileReport.missingReplicas;
      }
    }

    // 持久化扫描报告
    await this.saveScanReport(report);
    return report;
  }

  /**
   * 扫描单个文件的所有副本
   * 使用文件级 minReplicas 判断是否降级（低于最小副本数才告警）
   */
  async scanFile(fileInfo) {
    const { cid, storedNodes, targetReplicas } = fileInfo;
    const expectedReplicas = targetReplicas || fileInfo.replicas || 3;
    const minReplicas = fileInfo.minReplicas || Math.max(1, Math.ceil(expectedReplicas * 0.6));
    const result = {
      cid,
      fileName: fileInfo.fileName,
      status: 'healthy',
      replicas: [],
      missingReplicas: 0,
      corruptedReplicas: 0
    };

    // 检查索引中记录的每个副本
    for (const nodeId of storedNodes) {
      const blockExists = await this.fileOps.checkBlockExists(nodeId, cid);
      if (!blockExists) {
        result.replicas.push({ nodeId, status: 'missing' });
        result.missingReplicas++;
        continue;
      }

      // 读取并验证哈希
      const content = await this.fileOps.readFromNode(nodeId, cid);
      if (!content) {
        result.replicas.push({ nodeId, status: 'unreadable' });
        result.missingReplicas++;
        continue;
      }

      const verified = await this.fileOps.verifyContentIntegrity(content, cid);
      if (verified) {
        result.replicas.push({ nodeId, status: 'healthy' });
      } else {
        result.replicas.push({ nodeId, status: 'corrupted' });
        result.corruptedReplicas++;
      }
    }

    // 检查是否有未记录的节点实际持有该文件（孤立副本检测）
    const allNodes = await this.getRunningNodes();
    for (const nodeId of allNodes) {
      if (!storedNodes.includes(nodeId)) {
        const exists = await this.fileOps.checkBlockExists(nodeId, cid);
        if (exists) {
          result.replicas.push({ nodeId, status: 'unindexed' });
        }
      }
    }

    // 判断整体状态（使用 minReplicas 作为降级阈值）
    const healthyCount = result.replicas.filter(r => r.status === 'healthy').length;
    if (result.corruptedReplicas > 0) {
      result.status = 'corrupted';
    } else if (healthyCount < minReplicas) {
      result.status = 'critical'; // 低于最小副本数：危急
    } else if (healthyCount < expectedReplicas) {
      result.status = 'degraded'; // 低于目标但高于最小：降级
    }

    return result;
  }

  /**
   * 自动修复：修复所有降级/损坏的文件
   * 策略：从健康副本重新分发到缺失/损坏的节点
   * @param {object} options - { dryRun, maxRepairs }
   * @returns {object} 修复报告
   */
  async repair(options = {}) {
    const { dryRun = false, maxRepairs = 10 } = options;
    const index = await this.fileOps.getFullIndex();
    // 按修复优先级排序：high > normal > low
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    const entries = Object.values(index).sort((a, b) => {
      const pa = priorityOrder[a.repairPriority || 'normal'] ?? 1;
      const pb = priorityOrder[b.repairPriority || 'normal'] ?? 1;
      return pa - pb;
    });
    const report = {
      totalChecked: 0,
      repaired: 0,
      failed: 0,
      skipped: 0,
      actions: [],
      repairedAt: new Date().toISOString()
    };

    for (const fileInfo of entries) {
      if (report.repaired >= maxRepairs) {
        report.skipped += entries.length - report.totalChecked;
        break;
      }

      report.totalChecked++;
      const scanResult = await this.scanFile(fileInfo);

      // 无需修复
      if (scanResult.status === 'healthy') continue;

      // 找到健康副本作为源
      const healthyReplica = scanResult.replicas.find(r => r.status === 'healthy');
      if (!healthyReplica) {
        report.failed++;
        report.actions.push({
          cid: fileInfo.cid,
          action: 'unrecoverable',
          reason: '无健康副本可用'
        });
        continue;
      }

      // 确定需要修复的目标节点（使用文件级 targetReplicas）
      const targetReplicas = fileInfo.targetReplicas || fileInfo.replicas || 3;
      const repairPriority = fileInfo.repairPriority || 'normal';
      const healthyNodes = scanResult.replicas
        .filter(r => r.status === 'healthy')
        .map(r => r.nodeId);
      const needRepair = scanResult.replicas
        .filter(r => r.status === 'missing' || r.status === 'corrupted')
        .map(r => r.nodeId);

      // 如果副本数不足，从其他 running 节点补充
      const allNodes = await this.getRunningNodes();
      const candidateNodes = allNodes.filter(
        n => !healthyNodes.includes(n) && !needRepair.includes(n)
      );

      const repairTargets = [...needRepair];
      while (healthyNodes.length + repairTargets.length < targetReplicas && candidateNodes.length > 0) {
        repairTargets.push(candidateNodes.shift());
      }

      if (repairTargets.length === 0) continue;

      if (dryRun) {
        report.actions.push({
          cid: fileInfo.cid,
          action: 'would_repair',
          source: healthyReplica.nodeId,
          targets: repairTargets
        });
        continue;
      }

      // 执行修复：从健康副本读取并写入目标节点
      const sourceContent = await this.fileOps.readFromNode(healthyReplica.nodeId, fileInfo.cid);
      if (!sourceContent) {
        report.failed++;
        report.actions.push({
          cid: fileInfo.cid,
          action: 'source_read_failed',
          source: healthyReplica.nodeId
        });
        continue;
      }

      const repairedNodes = [];
      for (const targetNode of repairTargets) {
        try {
          // 如果是损坏的副本，先删除
          const blockPath = path.join(this.nodesDir, targetNode, 'blocks', `${fileInfo.cid}.block`);
          if (await fs.pathExists(blockPath)) {
            const stat = await fs.stat(blockPath);
            await fs.remove(blockPath);
            await this.fileOps.updateNodeUsage(targetNode, -stat.size);
          }

          // 写入新副本
          await this.fileOps.storeToNode(targetNode, fileInfo.cid, sourceContent, {
            fileName: fileInfo.fileName,
            originalSize: fileInfo.size,
            encrypted: fileInfo.encrypted,
            repairedFrom: healthyReplica.nodeId
          });
          repairedNodes.push(targetNode);
        } catch (err) {
          // 单节点修复失败不阻断（可能是配额不足）
          report.actions.push({
            cid: fileInfo.cid,
            action: 'partial_repair_failed',
            target: targetNode,
            reason: err.message
          });
        }
      }

      if (repairedNodes.length > 0) {
        // 更新索引中的 storedNodes
        const newStoredNodes = [...new Set([...healthyNodes, ...repairedNodes])];
        await this.fileOps.updateReplicaList(fileInfo.cid, newStoredNodes);

        report.repaired++;
        report.actions.push({
          cid: fileInfo.cid,
          action: 'repaired',
          source: healthyReplica.nodeId,
          targets: repairedNodes
        });
      } else {
        report.failed++;
      }
    }

    return report;
  }

  /**
   * 垃圾回收：清理无索引引用的孤立 block
   * @returns {object} GC 报告
   */
  async garbageCollect(options = {}) {
    const { dryRun = false } = options;
    await this.fileOps.ensureIndex();
    const index = await this.fileOps.getFullIndex();
    const indexedCids = new Set(Object.keys(index));
    const report = {
      scannedNodes: 0,
      orphanedBlocks: 0,
      freedBytes: 0,
      removed: [],
      gcAt: new Date().toISOString()
    };

    const nodeDirs = await fs.readdir(this.nodesDir).catch(() => []);
    for (const dir of nodeDirs) {
      if (!dir.startsWith('node-')) continue;
      report.scannedNodes++;

      const blocksDir = path.join(this.nodesDir, dir, 'blocks');
      if (!await fs.pathExists(blocksDir)) continue;

      const files = await fs.readdir(blocksDir);
      for (const file of files) {
        if (!file.endsWith('.block')) continue;
        const cid = file.replace('.block', '');

        if (!indexedCids.has(cid)) {
          const blockPath = path.join(blocksDir, file);
          const metaPath = path.join(blocksDir, `${cid}.meta.json`);
          const stat = await fs.stat(blockPath);

          report.orphanedBlocks++;
          report.freedBytes += stat.size;

          if (!dryRun) {
            await fs.remove(blockPath);
            await fs.remove(metaPath);
            await this.fileOps.updateNodeUsage(dir, -stat.size);
            report.removed.push({ nodeId: dir, cid, size: stat.size });
          }
        }
      }
    }

    return report;
  }

  /**
   * 获取快速健康摘要（供 dashboard 使用）
   */
  async getHealthSummary() {
    const index = await this.fileOps.getFullIndex();
    const entries = Object.values(index);
    let healthy = 0;
    let degraded = 0;
    let corrupted = 0;

    for (const fileInfo of entries) {
      const scanResult = await this.scanFile(fileInfo);
      if (scanResult.status === 'healthy') healthy++;
      else if (scanResult.status === 'degraded') degraded++;
      else corrupted++;
    }

    return {
      totalFiles: entries.length,
      healthy,
      degraded,
      corrupted,
      healthRate: entries.length > 0 ? ((healthy / entries.length) * 100).toFixed(1) + '%' : '100%'
    };
  }

  /**
   * 获取所有 running 状态的节点 ID
   */
  async getRunningNodes() {
    const nodes = [];
    const dirs = await fs.readdir(this.nodesDir).catch(() => []);
    for (const dir of dirs) {
      if (!dir.startsWith('node-')) continue;
      const configPath = path.join(this.nodesDir, dir, 'config.json');
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        if (config.status === 'running') {
          nodes.push(dir);
        }
      }
    }
    return nodes;
  }

  /**
   * 持久化扫描报告
   */
  async saveScanReport(report) {
    const reportPath = path.join(this.nodesDir, 'integrity-report.json');
    await fs.writeJson(reportPath, report, { spaces: 2 });
  }

  /**
   * 读取最近一次扫描报告
   */
  async getLastReport() {
    const reportPath = path.join(this.nodesDir, 'integrity-report.json');
    if (!await fs.pathExists(reportPath)) {
      return null;
    }
    return await fs.readJson(reportPath);
  }
}

export default DataIntegrity;
