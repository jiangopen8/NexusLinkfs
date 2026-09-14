/**
 * IPFS 分布式存储网络 - 数据再平衡模块
 * 
 * 商用级再平衡设计：
 * - 倾斜检测：基于节点使用率偏差（标准差 / 最大偏差）
 * - 迁移计划：从最满节点向最空节点迁移 block，直到偏差收敛
 * - 安全迁移：先复制到目标 → 验证哈希 → 更新索引 → 删除源
 * - 渐进执行：支持 dryRun 预览、maxMoves 限制、单 block 失败不阻断
 * - 副本感知：迁移后 storedNodes 更新，不减少有效副本数
 * 
 * 触发条件（自动模式）：
 * - 任意节点使用率偏离平均值 > threshold（默认 20%）
 * - 或最大使用率节点与最小使用率节点差值 > gapThreshold（默认 30%）
 */

import fs from 'fs-extra';
import path from 'path';
import { CID } from 'multiformats/cid';
import * as sha256 from 'multiformats/hashes/sha2';

const NODES_DIR = '/home/project/.ipfs-nodes';

export class RebalanceEngine {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.configPath = path.join(nodesDir, 'rebalance-config.json');
  }

  /**
   * 获取再平衡配置
   */
  async getConfig() {
    const defaults = {
      enabled: true,
      deviationThreshold: 0.20,   // 偏差阈值（20%）
      gapThreshold: 0.30,         // 最大-最小差值阈值（30%）
      maxMovesPerRun: 20,         // 单次最大迁移数
      minFreeSpaceRatio: 0.1,     // 目标节点至少保留 10% 空闲
      lastRun: null,
      lastResult: null
    };

    if (await fs.pathExists(this.configPath)) {
      const saved = await fs.readJson(this.configPath);
      return { ...defaults, ...saved };
    }
    return defaults;
  }

  /**
   * 保存配置
   */
  async saveConfig(config) {
    await fs.ensureDir(this.nodesDir);
    const tmpPath = this.configPath + `.tmp.${process.pid}`;
    await fs.writeJson(tmpPath, config, { spaces: 2 });
    await fs.rename(tmpPath, this.configPath);
  }

  /**
   * 获取所有节点统计（running 状态）
   */
  async getNodeStats() {
    const nodes = [];
    const dirs = await fs.readdir(this.nodesDir).catch(() => []);

    for (const dir of dirs) {
      if (!dir.startsWith('node-')) continue;
      const configPath = path.join(this.nodesDir, dir, 'config.json');
      if (!await fs.pathExists(configPath)) continue;

      const config = await fs.readJson(configPath);
      if (config.status !== 'running') continue;

      // 统计实际 block 数
      const blocksDir = path.join(this.nodesDir, dir, 'blocks');
      let blockCount = 0;
      let blockBytes = 0;
      if (await fs.pathExists(blocksDir)) {
        const files = await fs.readdir(blocksDir);
        for (const f of files) {
          if (f.endsWith('.block')) {
            blockCount++;
            const stat = await fs.stat(path.join(blocksDir, f));
            blockBytes += stat.size;
          }
        }
      }

      nodes.push({
        nodeId: dir,
        quota: config.quota || 0,
        usedSpace: config.usedSpace || 0,
        usageRate: config.quota > 0 ? (config.usedSpace || 0) / config.quota : 0,
        blockCount,
        blockBytes
      });
    }

    return nodes;
  }

  /**
   * 检测是否需要再平衡
   * @returns {object} { needed, reason, stats }
   */
  async detectImbalance() {
    const config = await this.getConfig();
    const nodes = await this.getNodeStats();

    if (nodes.length < 2) {
      return { needed: false, reason: '节点数不足 2，无需再平衡', nodes };
    }

    const avgUsage = nodes.reduce((s, n) => s + n.usageRate, 0) / nodes.length;
    const maxNode = nodes.reduce((a, b) => a.usageRate > b.usageRate ? a : b);
    const minNode = nodes.reduce((a, b) => a.usageRate < b.usageRate ? a : b);
    const gap = maxNode.usageRate - minNode.usageRate;
    const maxDeviation = Math.max(...nodes.map(n => Math.abs(n.usageRate - avgUsage)));

    const needed = maxDeviation > config.deviationThreshold || gap > config.gapThreshold;

    let reason;
    if (!needed) {
      reason = `数据分布均衡（最大偏差 ${(maxDeviation * 100).toFixed(1)}%，差值 ${(gap * 100).toFixed(1)}%）`;
    } else if (gap > config.gapThreshold) {
      reason = `节点间差值过大：${maxNode.nodeId}(${(maxNode.usageRate * 100).toFixed(1)}%) vs ${minNode.nodeId}(${(minNode.usageRate * 100).toFixed(1)}%)，差值 ${(gap * 100).toFixed(1)}%`;
    } else {
      reason = `使用率偏差超限：最大偏差 ${(maxDeviation * 100).toFixed(1)}%（阈值 ${(config.deviationThreshold * 100).toFixed(0)}%）`;
    }

    return {
      needed,
      reason,
      avgUsageRate: avgUsage,
      maxDeviation,
      gap,
      maxNode: maxNode.nodeId,
      minNode: minNode.nodeId,
      nodes
    };
  }

  /**
   * 生成再平衡迁移计划
   * 策略：从使用率最高的节点选取 block 迁移到使用率最低的节点
   * @param {object} options - { maxMoves }
   * @returns {object} 迁移计划
   */
  async generatePlan(options = {}) {
    const config = await this.getConfig();
    const maxMoves = options.maxMoves || config.maxMovesPerRun;
    const detection = await this.detectImbalance();

    if (!detection.needed) {
      return { needed: false, reason: detection.reason, moves: [] };
    }

    const nodes = detection.nodes;
    const avgUsage = detection.avgUsageRate;

    // 源节点：使用率高于平均值的节点（按使用率降序）
    const sources = nodes
      .filter(n => n.usageRate > avgUsage)
      .sort((a, b) => b.usageRate - a.usageRate);

    // 目标节点：使用率低于平均值的节点（按使用率升序）
    const targets = nodes
      .filter(n => n.usageRate < avgUsage)
      .sort((a, b) => a.usageRate - b.usageRate);

    if (sources.length === 0 || targets.length === 0) {
      return { needed: false, reason: '无法确定迁移方向', moves: [] };
    }

    // 加载索引
    const { IndexStore } = await import('./index-store.js');
    const indexStore = new IndexStore(this.nodesDir);
    await indexStore.init();
    const fullIndex = await indexStore.getAll();

    const moves = [];
    let moveCount = 0;

    for (const source of sources) {
      if (moveCount >= maxMoves) break;

      // 获取源节点上的所有 block
      const blocksDir = path.join(this.nodesDir, source.nodeId, 'blocks');
      if (!await fs.pathExists(blocksDir)) continue;

      const files = await fs.readdir(blocksDir);
      const blocks = files.filter(f => f.endsWith('.block'));

      // 按大小降序排列（优先迁移大文件，效率更高）
      const blocksWithSize = [];
      for (const block of blocks) {
        const stat = await fs.stat(path.join(blocksDir, block));
        blocksWithSize.push({ file: block, cid: block.replace('.block', ''), size: stat.size });
      }
      blocksWithSize.sort((a, b) => b.size - a.size);

      for (const block of blocksWithSize) {
        if (moveCount >= maxMoves) break;

        // 找到最空的目标节点（且该节点尚未持有此 block）
        const fileInfo = fullIndex[block.cid];
        const existingNodes = fileInfo?.storedNodes || [];

        let target = null;
        for (const t of targets) {
          if (t.nodeId === source.nodeId) continue;
          if (existingNodes.includes(t.nodeId)) continue;
          // 检查目标节点是否有足够空间
          const freeSpace = t.quota - t.usedSpace;
          if (freeSpace >= block.size) {
            target = t;
            break;
          }
        }

        if (!target) continue;

        moves.push({
          cid: block.cid,
          fileName: fileInfo?.fileName || 'unknown',
          size: block.size,
          from: source.nodeId,
          to: target.nodeId,
          reason: `${source.nodeId} 使用率 ${(source.usageRate * 100).toFixed(1)}% → ${target.nodeId} ${(target.usageRate * 100).toFixed(1)}%`
        });

        // 模拟更新目标节点使用率（避免重复选择同一目标）
        target.usedSpace += block.size;
        target.usageRate = target.quota > 0 ? target.usedSpace / target.quota : 0;
        moveCount++;
      }
    }

    return {
      needed: true,
      reason: detection.reason,
      avgUsageRate: detection.avgUsageRate,
      moves,
      totalMoves: moves.length,
      totalBytes: moves.reduce((s, m) => s + m.size, 0)
    };
  }

  /**
   * 执行再平衡迁移
   * 安全流程：复制到目标 → 验证哈希 → 更新索引 → 删除源
   * @param {object} options - { dryRun, maxMoves, onProgress }
   * @returns {object} 执行报告
   */
  async execute(options = {}) {
    const { dryRun = false, maxMoves, onProgress } = options;

    const plan = await this.generatePlan({ maxMoves });
    if (!plan.needed || plan.moves.length === 0) {
      return {
        success: true,
        needed: false,
        reason: plan.reason || '无需再平衡',
        migrated: 0,
        failed: 0,
        moves: []
      };
    }

    if (dryRun) {
      return {
        success: true,
        needed: true,
        dryRun: true,
        reason: plan.reason,
        plannedMoves: plan.moves.length,
        totalBytes: plan.totalBytes,
        moves: plan.moves
      };
    }

    const { IndexStore } = await import('./index-store.js');
    const indexStore = new IndexStore(this.nodesDir);
    await indexStore.init();

    const report = {
      success: true,
      needed: true,
      migrated: 0,
      failed: 0,
      skipped: 0,
      freedBytes: 0,
      moves: [],
      startedAt: new Date().toISOString()
    };

    for (const move of plan.moves) {
      try {
        const result = await this.migrateBlock(move, indexStore);
        if (result.success) {
          report.migrated++;
          report.freedBytes += move.size;
          report.moves.push({ ...move, status: 'migrated' });
        } else {
          report.failed++;
          report.moves.push({ ...move, status: 'failed', error: result.error });
        }
      } catch (err) {
        report.failed++;
        report.moves.push({ ...move, status: 'failed', error: err.message });
      }

      if (onProgress) {
        onProgress({
          current: report.migrated + report.failed,
          total: plan.moves.length,
          lastMove: move
        });
      }
    }

    report.completedAt = new Date().toISOString();

    // 保存执行结果
    const config = await this.getConfig();
    config.lastRun = report.completedAt;
    config.lastResult = {
      migrated: report.migrated,
      failed: report.failed,
      freedBytes: report.freedBytes
    };
    await this.saveConfig(config);

    return report;
  }

  /**
   * 迁移单个 block（安全四步）
   * 1. 复制到目标节点
   * 2. 验证目标 block 哈希
   * 3. 更新索引 storedNodes
   * 4. 删除源 block + 更新配额
   */
  async migrateBlock(move, indexStore) {
    const { cid, from, to, size } = move;

    const sourcePath = path.join(this.nodesDir, from, 'blocks', `${cid}.block`);
    const targetDir = path.join(this.nodesDir, to, 'blocks');
    const targetPath = path.join(targetDir, `${cid}.block`);

    // 前置检查
    if (!await fs.pathExists(sourcePath)) {
      return { success: false, error: '源 block 不存在' };
    }
    if (await fs.pathExists(targetPath)) {
      return { success: false, error: '目标已存在该 block' };
    }

    // 检查目标配额
    const targetConfigPath = path.join(this.nodesDir, to, 'config.json');
    if (await fs.pathExists(targetConfigPath)) {
      const targetConfig = await fs.readJson(targetConfigPath);
      if ((targetConfig.usedSpace || 0) + size > (targetConfig.quota || 0)) {
        return { success: false, error: '目标节点空间不足' };
      }
    }

    // Step 1: 复制到目标
    await fs.ensureDir(targetDir);
    await fs.copy(sourcePath, targetPath);

    // 复制元数据
    const sourceMetaPath = path.join(this.nodesDir, from, 'blocks', `${cid}.meta.json`);
    if (await fs.pathExists(sourceMetaPath)) {
      const meta = await fs.readJson(sourceMetaPath);
      meta.rebalancedFrom = from;
      meta.rebalancedAt = new Date().toISOString();
      await fs.writeJson(path.join(targetDir, `${cid}.meta.json`), meta, { spaces: 2 });
    }

    // Step 2: 验证哈希
    const targetContent = await fs.readFile(targetPath);
    const verified = await this.verifyBlockHash(targetContent, cid);
    if (!verified) {
      // 验证失败，回滚
      await fs.remove(targetPath);
      return { success: false, error: '迁移后哈希验证失败' };
    }

    // Step 3: 更新索引
    const fileInfo = await indexStore.get(cid);
    if (fileInfo) {
      const storedNodes = fileInfo.storedNodes || [];
      if (!storedNodes.includes(to)) {
        storedNodes.push(to);
      }
      // 从 storedNodes 移除源节点（因为我们要删除源 block）
      const newStoredNodes = storedNodes.filter(n => n !== from);
      await indexStore.updateReplicaList(cid, newStoredNodes);
    }

    // Step 4: 删除源 + 更新配额
    await fs.remove(sourcePath);
    await fs.remove(sourceMetaPath);
    await this.updateNodeUsage(from, -size);
    await this.updateNodeUsage(to, size);

    return { success: true };
  }

  /**
   * 验证 block 哈希与 CID 一致
   */
  async verifyBlockHash(content, cidString) {
    try {
      const cid = CID.parse(cidString);
      const computedHash = await sha256.sha256.digest(content);
      const originalBytes = cid.multihash.bytes;
      const computedBytes = computedHash.bytes;
      if (originalBytes.length !== computedBytes.length) return false;
      for (let i = 0; i < originalBytes.length; i++) {
        if (originalBytes[i] !== computedBytes[i]) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 更新节点使用空间
   */
  async updateNodeUsage(nodeId, delta) {
    const configPath = path.join(this.nodesDir, nodeId, 'config.json');
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);
      config.usedSpace = Math.max(0, (config.usedSpace || 0) + delta);
      await fs.writeJson(configPath, config, { spaces: 2 });
    }
  }

  /**
   * 获取再平衡状态摘要
   */
  async getStatus() {
    const config = await this.getConfig();
    const detection = await this.detectImbalance();

    return {
      enabled: config.enabled,
      needed: detection.needed,
      reason: detection.reason,
      avgUsageRate: detection.avgUsageRate ? (detection.avgUsageRate * 100).toFixed(1) + '%' : '-',
      maxDeviation: detection.maxDeviation ? (detection.maxDeviation * 100).toFixed(1) + '%' : '-',
      gap: detection.gap ? (detection.gap * 100).toFixed(1) + '%' : '-',
      thresholds: {
        deviation: (config.deviationThreshold * 100).toFixed(0) + '%',
        gap: (config.gapThreshold * 100).toFixed(0) + '%'
      },
      lastRun: config.lastRun,
      lastResult: config.lastResult,
      nodes: detection.nodes?.map(n => ({
        nodeId: n.nodeId,
        usageRate: (n.usageRate * 100).toFixed(1) + '%',
        blockCount: n.blockCount
      })) || []
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

export default RebalanceEngine;
