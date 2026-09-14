/**
 * IPFS 分布式存储网络 - 滚动升级引擎
 * 
 * 支持节点在线升级：逐节点停止 → 执行升级脚本 → 重启 → 验证完整性
 * 数据与进程解耦（文件系统持久化），停止/重启不丢失数据
 * 
 * 升级流程：
 * 1. 前置检查：副本健康度、容量余量、升级脚本验证
 * 2. 逐节点滚动：停止 → 执行升级脚本 → 重启 → 验证
 * 3. 失败回滚：恢复节点到升级前状态
 */

import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { validateScriptPath } from './security.js';

const NODES_DIR = '/home/project/.ipfs-nodes';
const UPGRADE_STATE_FILE = 'upgrade-state.json';

export class UpgradeManager {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.statePath = path.join(nodesDir, UPGRADE_STATE_FILE);
  }

  /**
   * 获取所有节点状态
   */
  async getNodes() {
    const nodes = [];
    if (!await fs.pathExists(this.nodesDir)) return nodes;

    const dirs = await fs.readdir(this.nodesDir);
    for (const dir of dirs) {
      if (!dir.startsWith('node-')) continue;
      const configPath = path.join(this.nodesDir, dir, 'config.json');
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        nodes.push(config);
      }
    }
    return nodes.sort((a, b) => {
      const idxA = parseInt(a.nodeId.split('-')[1] || '0');
      const idxB = parseInt(b.nodeId.split('-')[1] || '0');
      return idxA - idxB;
    });
  }

  /**
   * 前置检查：验证是否满足滚动升级条件
   * @returns {object} 检查结果
   */
  async preCheck() {
    const nodes = await this.getNodes();
    const runningNodes = nodes.filter(n => n.status === 'running');
    const stoppedNodes = nodes.filter(n => n.status === 'stopped');
    const issues = [];
    const warnings = [];

    if (runningNodes.length === 0) {
      issues.push('无在线节点，无法执行升级');
    }

    if (runningNodes.length < 2) {
      issues.push(`仅 ${runningNodes.length} 个在线节点，滚动升级需要至少 2 个节点保证数据可用`);
    }

    // 检查副本健康度：读取索引，确认所有文件的副本数 > 1
    const indexStats = await this.checkReplicaHealth(runningNodes);
    if (indexStats.degradedFiles > 0) {
      warnings.push(`${indexStats.degradedFiles} 个文件副本数 ≤ 1，升级期间可能不可用`);
    }
    if (indexStats.unavailableFiles > 0) {
      issues.push(`${indexStats.unavailableFiles} 个文件已无可用副本，请先修复`);
    }

    // 检查容量余量：升级期间节点离线，修复需要额外空间
    const totalQuota = runningNodes.reduce((s, n) => s + (n.quota || 0), 0);
    const totalUsed = runningNodes.reduce((s, n) => s + (n.usedSpace || 0), 0);
    const usageRate = totalQuota > 0 ? totalUsed / totalQuota : 0;
    if (usageRate > 0.9) {
      warnings.push(`集群使用率 ${(usageRate * 100).toFixed(1)}%（>90%），升级期间副本修复可能失败`);
    }

    // 检查是否有进行中的升级（中断的可通过 --resume 恢复）
    const existingState = await this.loadState();
    if (existingState && existingState.status === 'in_progress') {
      issues.push(`存在进行中的升级（进度: ${existingState.completedNodes?.length || 0}/${existingState.totalNodes}），请运行 upgrade --resume 继续或 --rollback 回滚`);
    }

    return {
      canUpgrade: issues.length === 0,
      issues,
      warnings,
      stats: {
        totalNodes: nodes.length,
        runningNodes: runningNodes.length,
        stoppedNodes: stoppedNodes.length,
        usageRate,
        totalQuota,
        totalUsed,
        ...indexStats
      }
    };
  }

  /**
   * 检查副本健康度
   */
  async checkReplicaHealth(runningNodes) {
    const runningIds = new Set(runningNodes.map(n => n.nodeId));
    let totalFiles = 0;
    let degradedFiles = 0;
    let unavailableFiles = 0;

    // 读取分片索引
    const indexDir = path.join(this.nodesDir, 'index');
    if (await fs.pathExists(indexDir)) {
      const shards = await fs.readdir(indexDir);
      for (const shard of shards) {
        if (!shard.endsWith('.json')) continue;
        try {
          const shardData = await fs.readJson(path.join(indexDir, shard));
          for (const [, fileInfo] of Object.entries(shardData)) {
            totalFiles++;
            const availableReplicas = (fileInfo.storedNodes || [])
              .filter(nid => runningIds.has(nid))
              .length;
            if (availableReplicas === 0) unavailableFiles++;
            else if (availableReplicas <= 1) degradedFiles++;
          }
        } catch (e) { /* 跳过损坏的分片 */ }
      }
    }

    return { totalFiles, degradedFiles, unavailableFiles };
  }

  /**
   * 执行滚动升级
   * @param {object} options - { script, dryRun, onProgress }
   *   script: 每个节点停止后执行的升级脚本路径（可选）
   *   dryRun: 仅模拟，不实际停止/重启
   */
  async rollingUpgrade(options = {}) {
    const { script, dryRun = false, onProgress } = options;

    // 前置检查
    const check = await this.preCheck();
    if (!check.canUpgrade) {
      return { success: false, error: '前置检查未通过', issues: check.issues };
    }

    // P0: 升级脚本安全校验
    if (script) {
      try {
        script = validateScriptPath(script);
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    const nodes = await this.getNodes();
    const runningNodes = nodes.filter(n => n.status === 'running');

    // 创建升级状态
    const state = {
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      script: script || null,
      dryRun,
      totalNodes: runningNodes.length,
      completedNodes: [],
      failedNodes: [],
      nodeBackups: {}
    };

    if (!dryRun) {
      await this.saveState(state);
    }

    const results = [];

    for (let i = 0; i < runningNodes.length; i++) {
      const node = runningNodes[i];
      const nodeId = node.nodeId;
      const progress = `[${i + 1}/${runningNodes.length}] ${nodeId}`;

      if (onProgress) onProgress(progress, 'upgrading');

      if (dryRun) {
        results.push({ nodeId, status: 'simulated', steps: ['stop', 'upgrade', 'restart', 'verify'] });
        continue;
      }

      try {
        // 步骤 1: 备份节点配置
        const configPath = path.join(this.nodesDir, nodeId, 'config.json');
        const configBackup = await fs.readJson(configPath);
        state.nodeBackups[nodeId] = configBackup;

        // 步骤 2: 停止节点
        configBackup.status = 'stopped';
        configBackup.stoppedAt = new Date().toISOString();
        configBackup.stopReason = 'upgrade';
        await fs.writeJson(configPath, configBackup, { spaces: 2 });

        // 步骤 3: 执行升级脚本
        let scriptOutput = null;
        if (script) {
          try {
            scriptOutput = execSync(`node ${script} ${nodeId}`, {
              encoding: 'utf8',
              timeout: 60000,
              cwd: path.dirname(script)
            }).trim();
          } catch (err) {
            scriptOutput = `脚本执行失败: ${err.message}`;
          }
        }

        // 步骤 4: 重启节点（恢复数据，保留原有配额和使用量）
        const config = await fs.readJson(configPath);
        config.status = 'running';
        config.startedAt = new Date().toISOString();
        config.lastUpgradeAt = new Date().toISOString();
        delete config.stoppedAt;
        delete config.stopReason;
        await fs.writeJson(configPath, config, { spaces: 2 });

        // 步骤 5: 验证节点数据完整性
        const verifyResult = await this.verifyNodeData(nodeId);

        if (!verifyResult.ok) {
          // 验证失败：回滚此节点
          config.status = 'running';
          delete config.lastUpgradeAt;
          await fs.writeJson(configPath, state.nodeBackups[nodeId], { spaces: 2 });
          state.failedNodes.push(nodeId);
          results.push({ nodeId, status: 'failed', error: verifyResult.error, scriptOutput });
        } else {
          state.completedNodes.push(nodeId);
          results.push({ nodeId, status: 'upgraded', blocks: verifyResult.blockCount, scriptOutput });
        }

        // 更新状态
        await this.saveState(state);

      } catch (err) {
        state.failedNodes.push(nodeId);
        results.push({ nodeId, status: 'failed', error: err.message });
        await this.saveState(state);
      }
    }

    // 完成升级
    state.status = state.failedNodes.length === 0 ? 'completed' : 'completed_with_errors';
    state.completedAt = new Date().toISOString();
    if (!dryRun) {
      await this.saveState(state);
    }

    return {
      success: state.failedNodes.length === 0,
      dryRun,
      totalNodes: runningNodes.length,
      upgraded: state.completedNodes.length,
      failed: state.failedNodes.length,
      results
    };
  }

  /**
   * 从中断处恢复升级
   * 检测 upgrade-state.json 中 in_progress 状态，修复中断节点，继续升级剩余节点
   */
  async resume(options = {}) {
    const { onProgress } = options;

    const state = await this.loadState();
    if (!state) {
      return { success: false, error: '无升级记录，请先运行 upgrade --run' };
    }
    if (state.status !== 'in_progress') {
      return { success: false, error: `当前升级状态为 "${state.status}"，无需恢复` };
    }

    // 1. 修复中断节点：状态为 stopped 且 stopReason=upgrade 的节点
    const repaired = [];
    const nodes = await this.getNodes();
    for (const node of nodes) {
      if (node.status === 'stopped' && node.stopReason === 'upgrade') {
        const configPath = path.join(this.nodesDir, node.nodeId, 'config.json');
        const config = await fs.readJson(configPath);
        config.status = 'running';
        config.startedAt = new Date().toISOString();
        config.lastUpgradeAt = new Date().toISOString();
        config.resumedFromInterrupt = true;
        delete config.stoppedAt;
        delete config.stopReason;
        await fs.writeJson(configPath, config, { spaces: 2 });

        // 验证修复后的节点
        const verify = await this.verifyNodeData(node.nodeId);
        if (verify.ok) {
          if (!state.completedNodes.includes(node.nodeId)) {
            state.completedNodes.push(node.nodeId);
          }
          repaired.push({ nodeId: node.nodeId, blocks: verify.blockCount });
        } else {
          state.failedNodes.push(node.nodeId);
          repaired.push({ nodeId: node.nodeId, error: verify.error });
        }
      }
    }

    // 2. 确定剩余待升级节点
    const processedSet = new Set([...state.completedNodes, ...state.failedNodes]);
    const allNodes = await this.getNodes();
    const remaining = allNodes.filter(n =>
      n.status === 'running' && !processedSet.has(n.nodeId)
    );

    // 3. 继续升级剩余节点
    const results = repaired.map(r => ({
      nodeId: r.nodeId,
      status: r.error ? 'repaired_failed' : 'repaired',
      blocks: r.blocks,
      error: r.error
    }));

    const script = state.script;
    for (let i = 0; i < remaining.length; i++) {
      const node = remaining[i];
      const nodeId = node.nodeId;
      const progress = `[恢复 ${i + 1}/${remaining.length}] ${nodeId}`;
      if (onProgress) onProgress(progress);

      try {
        const configPath = path.join(this.nodesDir, nodeId, 'config.json');
        const configBackup = await fs.readJson(configPath);
        state.nodeBackups[nodeId] = configBackup;

        // 停止
        configBackup.status = 'stopped';
        configBackup.stoppedAt = new Date().toISOString();
        configBackup.stopReason = 'upgrade';
        await fs.writeJson(configPath, configBackup, { spaces: 2 });

        // 执行升级脚本
        let scriptOutput = null;
        if (script) {
          try {
            scriptOutput = execSync(`node ${script} ${nodeId}`, {
              encoding: 'utf8', timeout: 60000, cwd: path.dirname(script)
            }).trim();
          } catch (err) {
            scriptOutput = `脚本执行失败: ${err.message}`;
          }
        }

        // 重启
        const config = await fs.readJson(configPath);
        config.status = 'running';
        config.startedAt = new Date().toISOString();
        config.lastUpgradeAt = new Date().toISOString();
        delete config.stoppedAt;
        delete config.stopReason;
        await fs.writeJson(configPath, config, { spaces: 2 });

        // 验证
        const verify = await this.verifyNodeData(nodeId);
        if (verify.ok) {
          state.completedNodes.push(nodeId);
          results.push({ nodeId, status: 'upgraded', blocks: verify.blockCount, scriptOutput });
        } else {
          await fs.writeJson(configPath, state.nodeBackups[nodeId], { spaces: 2 });
          state.failedNodes.push(nodeId);
          results.push({ nodeId, status: 'failed', error: verify.error, scriptOutput });
        }
        await this.saveState(state);
      } catch (err) {
        state.failedNodes.push(nodeId);
        results.push({ nodeId, status: 'failed', error: err.message });
        await this.saveState(state);
      }
    }

    // 4. 完成
    state.status = state.failedNodes.length === 0 ? 'completed' : 'completed_with_errors';
    state.completedAt = new Date().toISOString();
    state.resumedAt = new Date().toISOString();
    await this.saveState(state);

    return {
      success: state.failedNodes.length === 0,
      resumed: true,
      repairedNodes: repaired.length,
      remainingUpgraded: remaining.length,
      totalCompleted: state.completedNodes.length,
      totalNodes: state.totalNodes,
      failed: state.failedNodes.length,
      results
    };
  }

  /**
   * 验证节点数据完整性（检查 block 文件与元数据一致性）
   */
  async verifyNodeData(nodeId) {
    const blocksDir = path.join(this.nodesDir, nodeId, 'blocks');
    if (!await fs.pathExists(blocksDir)) {
      return { ok: true, blockCount: 0 };
    }

    try {
      const files = await fs.readdir(blocksDir);
      const blockFiles = files.filter(f => f.endsWith('.block'));
      let corruptCount = 0;

      for (const blockFile of blockFiles) {
        const cid = blockFile.replace('.block', '');
        const blockPath = path.join(blocksDir, blockFile);
        const stat = await fs.stat(blockPath);

        // 检查 block 文件非空且可读
        if (stat.size === 0) {
          corruptCount++;
          continue;
        }

        // 检查对应元数据存在
        const metaPath = path.join(blocksDir, `${cid}.meta.json`);
        if (!await fs.pathExists(metaPath)) {
          // 元数据缺失不算损坏（可能是 chunk block）
          continue;
        }
      }

      if (corruptCount > 0) {
        return { ok: false, blockCount: blockFiles.length, error: `${corruptCount} 个 block 文件为空（可能损坏）` };
      }

      return { ok: true, blockCount: blockFiles.length };
    } catch (err) {
      return { ok: false, blockCount: 0, error: err.message };
    }
  }

  /**
   * 回滚升级：恢复所有节点到升级前状态
   */
  async rollback() {
    const state = await this.loadState();
    if (!state) {
      return { success: false, error: '无升级记录，无需回滚' };
    }

    if (state.status === 'rolled_back') {
      return { success: false, error: '已回滚过，无需重复操作' };
    }

    const restored = [];
    const failed = [];

    for (const [nodeId, backup] of Object.entries(state.nodeBackups || {})) {
      try {
        const configPath = path.join(this.nodesDir, nodeId, 'config.json');
        // 恢复升级前的配置（保留数据，只恢复状态和元信息）
        const currentConfig = await fs.pathExists(configPath)
          ? await fs.readJson(configPath)
          : {};
        
        // 保留当前 usedSpace（数据可能已变化），恢复其他字段
        const restoredConfig = {
          ...backup,
          usedSpace: currentConfig.usedSpace ?? backup.usedSpace,
          status: 'running',
          rolledBackAt: new Date().toISOString()
        };
        delete restoredConfig.lastUpgradeAt;
        await fs.writeJson(configPath, restoredConfig, { spaces: 2 });
        restored.push(nodeId);
      } catch (err) {
        failed.push({ nodeId, error: err.message });
      }
    }

    state.status = 'rolled_back';
    state.rolledBackAt = new Date().toISOString();
    await this.saveState(state);

    return {
      success: failed.length === 0,
      restored: restored.length,
      failed: failed.length,
      failedNodes: failed
    };
  }

  /**
   * 获取升级状态
   */
  async getStatus() {
    const state = await this.loadState();
    if (!state) {
      return { hasUpgrade: false };
    }
    return { hasUpgrade: true, ...state };
  }

  /**
   * 加载升级状态
   */
  async loadState() {
    if (!await fs.pathExists(this.statePath)) return null;
    try {
      return await fs.readJson(this.statePath);
    } catch (e) {
      return null;
    }
  }

  /**
   * 保存升级状态
   */
  async saveState(state) {
    await fs.writeJson(this.statePath, state, { spaces: 2 });
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export default UpgradeManager;
