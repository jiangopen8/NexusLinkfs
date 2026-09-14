/**
 * IPFS 分布式存储网络 - 多用户插件（UserPlugin）
 *
 * 插件架构下的多用户管理模块，包装 user-manager.js。
 * 提供用户注册、登录（含会话持久化）、登出、节点分配等能力。
 * 依赖：security 插件（会话管理）、node-manager 插件（节点操作）
 */

import { PluginBase } from '../core/plugin-base.js';
import fs from 'fs-extra';
import path from 'path';

export class UserPlugin extends PluginBase {
  constructor() {
    super('multi-user', {
      description: '多用户管理（注册、登录、登出、节点分配）',
      version: '1.0.0',
      provides: ['userManager'],
      dependencies: ['security', 'node-manager']
    });
  }

  async install(ctx) {
    await super.install(ctx);

    const { UserManager } = await import('../user-manager.js');
    const um = new UserManager();
    this.provide('userManager', um);

    // user register
    this.command('user-register', {
      description: '注册新用户（自动生成认证密钥）',
      arguments: ['<username>'],
      options: [{ flags: '--display-name <name>', description: '显示名称' }],
      handler: async (username, options) => {
        const user = await um.registerUser(username, { displayName: options?.displayName });
        this.emit('user/registered', { username });
        return user;
      }
    });

    // user login
    this.command('user-login', {
      description: '用户登录，颁发认证 token 并保存会话',
      arguments: ['<username>'],
      handler: async (username) => {
        const result = await um.login(username);
        // 通过 security 插件持久化会话
        const security = ctx.use('security');
        await security.saveSession(username, result);
        this.emit('user/logged-in', { username });
        return result;
      }
    });

    // user logout
    this.command('user-logout', {
      description: '登出，清除本地会话',
      handler: async () => {
        const security = ctx.use('security');
        const session = await security.loadSession();
        if (!session) return { success: false, reason: '当前无活跃会话' };
        await security.clearSession();
        this.emit('user/logged-out', { username: session.username });
        return { success: true, username: session.username };
      }
    });

    // user list
    this.command('user-list', {
      description: '列出所有用户及节点统计',
      handler: async () => {
        return um.getNetworkStats();
      }
    });

    // user start
    this.command('user-start', {
      description: '为用户启动存储节点',
      arguments: ['<username>'],
      options: [{ flags: '-n, --count <number>', description: '节点数量', default: '3' }],
      handler: async (username, options) => {
        const count = parseInt(options?.count || '3');
        const nodes = await um.startUserNodes(username, count);
        this.emit('user/nodes-started', { username, count });
        return nodes;
      }
    });

    // user nodes
    this.command('user-nodes', {
      description: '查看用户的节点列表',
      arguments: ['<username>'],
      handler: async (username) => {
        return um.getUserNodes(username);
      }
    });
  }

  async healthCheck() {
    const details = {};
    try {
      // 检查用户文件
      const usersPath = path.resolve('.ipfs-nodes/users.json');
      const exists = await fs.pathExists(usersPath);
      details.usersFileExists = exists;

      if (exists) {
        try {
          const users = await fs.readJson(usersPath);
          details.userCount = Object.keys(users).length;
        } catch {
          details.usersReadable = false;
        }
      }

      // 检查会话
      const sessionPath = path.resolve('.ipfs-nodes/session.json');
      details.hasSession = await fs.pathExists(sessionPath);

      const healthy = true; // 用户插件始终可用，只是报告状态
      return {
        healthy,
        message: exists
          ? `${details.userCount || 0} 个用户注册${details.hasSession ? ', 有活跃会话' : ''}`
          : '单用户模式（未启用多用户）',
        details
      };
    } catch (e) {
      this.recordError(e);
      return { healthy: false, message: `检查失败: ${e.message}`, details };
    }
  }
}

export default UserPlugin;
