/**
 * IPFS 分布式存储网络 - 安全插件（SecurityPlugin）
 *
 * 插件架构下的安全能力封装：
 * - 将 security.js 的所有导出注册为 'security' 服务
 * - 注册 whitelist CLI 命令
 * - 注册审计中间件：敏感命令执行时发射 'audit/command' 事件
 * - 订阅 'file/uploaded' 事件记录审计日志
 */

import { PluginBase } from '../core/plugin-base.js';
import * as security from '../security.js';
import fs from 'fs-extra';
import path from 'path';

const SENSITIVE_COMMANDS = new Set(['upload', 'download', 'delete', 'upgrade']);

export class SecurityPlugin extends PluginBase {
  constructor() {
    super('security', {
      description: '路径校验、密钥管理、用户认证、消息签名、白名单',
      provides: ['security'],
      dependencies: []
    });
  }

  async install(ctx) {
    await super.install(ctx);

    // 1. 将 security 模块整体作为服务提供
    this.provide('security', security);

    // 2. 注册 whitelist 命令
    this.command('whitelist', {
      description: 'P2P 节点白名单管理（启用后仅允许白名单内的 PeerId 连接）',
      options: [
        { flags: '--enable', description: '启用白名单' },
        { flags: '--disable', description: '禁用白名单' },
        { flags: '--add <peerId>', description: '添加 PeerId 到白名单' },
        { flags: '--remove <peerId>', description: '从白名单移除 PeerId' },
        { flags: '--list', description: '查看白名单状态' }
      ],
      handler: async (options = {}) => {
        const sec = this.ctx.use('security');
        let wl = await sec.loadWhitelist();

        if (options.enable) {
          wl.enabled = true;
          await sec.saveWhitelist(wl);
          return { success: true, message: '白名单已启用' };
        } else if (options.disable) {
          wl.enabled = false;
          await sec.saveWhitelist(wl);
          return { success: true, message: '白名单已禁用' };
        } else if (options.add) {
          if (!wl.peerIds.includes(options.add)) {
            wl.peerIds.push(options.add);
            await sec.saveWhitelist(wl);
          }
          return { success: true, message: `已添加，白名单共 ${wl.peerIds.length} 个节点` };
        } else if (options.remove) {
          wl.peerIds = wl.peerIds.filter(id => id !== options.remove);
          await sec.saveWhitelist(wl);
          return { success: true, message: `已移除，白名单共 ${wl.peerIds.length} 个节点` };
        } else {
          return { success: true, data: wl };
        }
      }
    });

    // 3. 注册审计中间件：敏感命令执行时发射审计事件
    this.track(ctx.middleware(async (mCtx, cmdName, args, next) => {
      if (SENSITIVE_COMMANDS.has(cmdName)) {
        mCtx.emit('audit/command', {
          command: cmdName,
          timestamp: new Date().toISOString(),
          source: 'middleware'
        });
      }
      return next();
    }));

    // 4. 订阅 file/uploaded 事件，记录审计日志
    this.on('file/uploaded', (payload) => {
      this.emit('audit/command', {
        command: 'upload',
        detail: `文件 ${payload?.fileName || payload?.cid || 'unknown'} 已上传`,
        timestamp: new Date().toISOString(),
        source: 'event'
      });
    });
  }

  async healthCheck() {
    const details = {};
    try {
      // 检查安全模块核心函数是否可用
      details.moduleLoaded = typeof security.validateInputPath === 'function'
        && typeof security.requireAuth === 'function';

      // 检查白名单配置
      try {
        const wl = await security.loadWhitelist();
        details.whitelistEnabled = wl.enabled;
        details.whitelistSize = wl.peerIds?.length || 0;
      } catch {
        details.whitelistReadable = false;
      }

      // 检查用户文件（多用户模式检测）
      const usersPath = path.resolve('.ipfs-nodes/users.json');
      details.multiUserMode = await fs.pathExists(usersPath);

      // 检查会话文件
      const sessionPath = path.resolve('.ipfs-nodes/session.json');
      details.hasActiveSession = await fs.pathExists(sessionPath);

      return {
        healthy: details.moduleLoaded,
        message: details.moduleLoaded
          ? `安全模块就绪${details.multiUserMode ? ' (多用户模式)' : ' (单用户模式)'}`
          : '安全模块加载异常',
        details
      };
    } catch (e) {
      this.recordError(e);
      return { healthy: false, message: `检查失败: ${e.message}`, details };
    }
  }
}

export default SecurityPlugin;
