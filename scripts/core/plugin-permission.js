/**
 * IPFS 分布式存储网络 - 插件权限管理（PluginPermission）
 * 
 * 权限模型：
 * - 管理员（admin）：管理系统插件、发布/下架市场插件、管理市场源
 * - 普通用户（user）：仅可浏览市场、申请安装/卸载扩展插件
 * 
 * 管理员判定规则（优先级从高到低）：
 * 1. .ipfs-nodes/admin.json 中配置的管理员列表
 * 2. 单用户模式（无 users.json）→ 当前操作者即为管理员
 * 3. 多用户模式下未配置 admin.json → 第一个注册的用户为管理员
 * 
 * 命令权限矩阵：
 * | 操作                          | 管理员 | 普通用户 |
 * |-------------------------------|--------|----------|
 * | plugin mount/unmount/reload   | ✅     | ❌       |
 * | market list/search/info       | ✅     | ✅       |
 * | market install/uninstall      | ✅     | ✅       |
 * | market publish/unpublish      | ✅     | ❌       |
 * | market add-source/remove-src  | ✅     | ❌       |
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const NODES_DIR = resolve('/home/project/.ipfs-nodes');
const ADMIN_FILE = join(NODES_DIR, 'admin.json');
const USERS_FILE = join(NODES_DIR, 'users.json');

// 需要管理员权限的市场操作
const ADMIN_ONLY_MARKET_COMMANDS = new Set([
  'publish', 'unpublish', 'add-source', 'remove-source'
]);

// 需要管理员权限的插件操作（系统插件）
const ADMIN_ONLY_PLUGIN_COMMANDS = new Set([
  'mount', 'unmount', 'reload', 'load', 'unload'
]);

export class PluginPermission {
  constructor(options = {}) {
    this.adminFile = options.adminFile || ADMIN_FILE;
    this.usersFile = options.usersFile || USERS_FILE;
  }

  /**
   * 获取管理员列表
   * @returns {string[]} 管理员用户名列表
   */
  getAdmins() {
    // 1. 优先读取 admin.json
    if (existsSync(this.adminFile)) {
      try {
        const data = JSON.parse(readFileSync(this.adminFile, 'utf-8'));
        return Array.isArray(data.admins) ? data.admins : [];
      } catch { return []; }
    }

    // 2. 单用户模式 → 无管理员概念，所有人都是管理员
    if (!existsSync(this.usersFile)) {
      return ['*']; // 通配符表示所有人
    }

    // 3. 多用户模式但无 admin.json → 第一个注册的用户为管理员
    try {
      const users = JSON.parse(readFileSync(this.usersFile, 'utf-8'));
      const usernames = Object.keys(users);
      return usernames.length > 0 ? [usernames[0]] : [];
    } catch { return []; }
  }

  /**
   * 设置管理员列表
   * @param {string[]} admins - 管理员用户名列表
   */
  setAdmins(admins) {
    mkdirSync(NODES_DIR, { recursive: true });
    writeFileSync(this.adminFile, JSON.stringify({
      admins,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf-8');
  }

  /**
   * 检查用户是否为管理员
   * @param {string} username - 用户名（null 表示单用户模式）
   * @returns {boolean}
   */
  isAdmin(username) {
    const admins = this.getAdmins();

    // 通配符：单用户模式，所有人都是管理员
    if (admins.includes('*')) return true;

    // 未指定用户名且为单用户模式
    if (!username && !existsSync(this.usersFile)) return true;

    return username ? admins.includes(username) : false;
  }

  /**
   * 检查当前会话用户是否为管理员
   * 通过 session.json 获取当前登录用户
   * @returns {object} { isAdmin, username, reason }
   */
  checkCurrentAdmin() {
    const sessionPath = join(NODES_DIR, 'session.json');

    // 单用户模式：无 session 文件 → 默认管理员
    if (!existsSync(this.usersFile)) {
      return { isAdmin: true, username: 'admin', reason: '单用户模式，默认管理员权限' };
    }

    // 多用户模式：检查 session
    if (!existsSync(sessionPath)) {
      return { isAdmin: false, username: null, reason: '未登录，请先执行 user-login' };
    }

    try {
      const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
      const username = session.username;
      if (!username) {
        return { isAdmin: false, username: null, reason: '会话无效' };
      }
      const admin = this.isAdmin(username);
      return {
        isAdmin: admin,
        username,
        reason: admin ? '管理员' : '普通用户（无系统插件管理权限）'
      };
    } catch {
      return { isAdmin: false, username: null, reason: '会话文件损坏' };
    }
  }

  /**
   * 权限守卫：检查是否允许执行市场命令
   * @param {string} subCommand - 市场子命令
   * @returns {object} { allowed, reason }
   */
  guardMarketCommand(subCommand) {
    // 只读命令所有人可用
    if (!ADMIN_ONLY_MARKET_COMMANDS.has(subCommand)) {
      return { allowed: true, reason: '只读/用户操作' };
    }

    // 管理员专属命令
    const check = this.checkCurrentAdmin();
    if (check.isAdmin) {
      return { allowed: true, reason: check.reason };
    }
    return {
      allowed: false,
      reason: `权限不足: "${subCommand}" 为管理员操作。${check.reason}`
    };
  }

  /**
   * 权限守卫：检查是否允许执行插件管理命令（系统插件）
   * @param {string} subCommand - 插件子命令
   * @param {string} targetPlugin - 目标插件名
   * @param {boolean} isSystemPlugin - 是否为系统插件
   * @returns {object} { allowed, reason }
   */
  guardPluginCommand(subCommand, targetPlugin, isSystemPlugin) {
    // 非管理类命令所有人可用
    if (!ADMIN_ONLY_PLUGIN_COMMANDS.has(subCommand)) {
      return { allowed: true, reason: '只读操作' };
    }

    // 扩展插件（非系统插件）的 mount/unmount 允许普通用户
    if (!isSystemPlugin) {
      return { allowed: true, reason: '扩展插件，用户可操作' };
    }

    // 系统插件：仅管理员
    const check = this.checkCurrentAdmin();
    if (check.isAdmin) {
      return { allowed: true, reason: check.reason };
    }
    return {
      allowed: false,
      reason: `权限不足: 系统插件 "${targetPlugin}" 仅管理员可操作。${check.reason}`
    };
  }

  /**
   * 判断插件是否为系统插件（内置注册表中的插件）
   * @param {string} pluginName - 插件名
   * @param {string[]} systemPluginNames - 系统插件名列表
   * @returns {boolean}
   */
  isSystemPlugin(pluginName, systemPluginNames) {
    return systemPluginNames.includes(pluginName);
  }
}

export default PluginPermission;
