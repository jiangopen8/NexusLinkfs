/**
 * IPFS 分布式存储网络 - 升级插件（Upgrade Plugin）
 * 
 * 插件架构：将 upgrade.js 的滚动升级引擎包装为标准插件，
 * 通过 PluginContext 注册服务、命令和事件。
 * 
 * 能力接缝（Capability Seam）：
 * - Service Provider: 提供 'upgrade' 服务（UpgradeManager 实例）
 * - Consumer: CLI 命令 'upgrade'
 * - Events: 'upgrade/completed', 'upgrade/rolled-back'
 * 
 * 鉴权：--run/--rollback/--resume 为高危操作，多用户模式下需有效 token
 */

import { PluginBase } from '../core/plugin-base.js';
import UpgradeManager from '../upgrade.js';
import fs from 'fs-extra';
import path from 'path';

export class UpgradePlugin extends PluginBase {
  constructor() {
    super('upgrade', {
      description: '滚动升级引擎（前置检查、逐节点升级、验证、回滚、中断恢复）',
      provides: ['upgrade'],
      dependencies: ['node-manager', 'security']
    });
    this.upgradeManager = null;
  }

  async install(ctx) {
    await super.install(ctx);

    // 创建 UpgradeManager 实例并注册为服务
    this.upgradeManager = new UpgradeManager();
    this.provide('upgrade', this.upgradeManager);

    // 注册 CLI 命令
    this.command('upgrade', {
      description: '节点滚动升级管理（前置检查、逐节点升级、验证、回滚）',
      options: {
        check: { flag: '--check', description: '前置检查：验证是否满足升级条件' },
        run: { flag: '--run', description: '执行滚动升级' },
        rollback: { flag: '--rollback', description: '回滚到升级前状态' },
        status: { flag: '--status', description: '查看升级状态' },
        resume: { flag: '--resume', description: '从中断处恢复升级' },
        dryRun: { flag: '--dry-run', description: '模拟升级流程' },
        script: { flag: '-s, --script <path>', description: '升级脚本路径' },
        token: { flag: '--token <token>', description: '认证 token（多用户模式必需）' }
      },
      handler: async (options) => this._handleUpgrade(options)
    });
  }

  async _handleUpgrade(options) {
    const security = this.ctx.tryUse('security');

    // 高危操作鉴权：--run / --rollback / --resume
    if (options.run || options.rollback || options.resume) {
      if (security) {
        const auth = await security.requireAuth(options.token);
        if (!auth.allowed) {
          throw new Error(`鉴权失败: ${auth.reason}`);
        }
      }
    }

    if (options.check) {
      return this.upgradeManager.preCheck();
    }

    if (options.run) {
      const result = await this.upgradeManager.rollingUpgrade({
        script: options.script,
        dryRun: options.dryRun || false
      });
      this.emit('upgrade/completed', result);
      return result;
    }

    if (options.resume) {
      const result = await this.upgradeManager.resume({});
      if (result.resumed) {
        this.emit('upgrade/completed', result);
      }
      return result;
    }

    if (options.rollback) {
      const result = await this.upgradeManager.rollback();
      if (result.success) {
        this.emit('upgrade/rolled-back', result);
      }
      return result;
    }

    if (options.status) {
      return this.upgradeManager.getStatus();
    }

    return { error: '请指定操作: --check / --run / --resume / --rollback / --status' };
  }

  async healthCheck() {
    const details = {};
    try {
      if (!this.upgradeManager) {
        return { healthy: false, message: 'UpgradeManager 未初始化', details };
      }
      details.serviceReady = true;

      // 检查是否有进行中的升级
      const statePath = path.resolve('.ipfs-nodes/upgrade-state.json');
      const hasState = await fs.pathExists(statePath);
      details.hasUpgradeState = hasState;

      if (hasState) {
        try {
          const state = await fs.readJson(statePath);
          details.upgradePhase = state.phase || 'unknown';
          details.upgradeProgress = state.completedNodes?.length || 0;
        } catch {
          details.stateReadable = false;
        }
      }

      return {
        healthy: true,
        message: hasState ? `有进行中的升级 (${details.upgradePhase})` : '升级引擎就绪',
        details
      };
    } catch (e) {
      this.recordError(e);
      return { healthy: false, message: `检查失败: ${e.message}`, details };
    }
  }
}

export default UpgradePlugin;
