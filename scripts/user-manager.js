/**
 * IPFS 分布式存储网络 - 多用户管理模块
 * 
 * 多用户架构设计：
 * - 用户隔离：每个用户拥有独立的节点目录和数据空间
 * - 节点命名：{username}-node-{index}，全局唯一
 * - 端口分配：基于全局注册表自动分配，避免冲突
 * - 全局注册表：记录所有用户节点的 multiaddr，支持跨用户发现
 * - 跨用户互联：通过注册表发现其他用户节点，建立 libp2p 连接
 * 
 * 目录结构：
 * .ipfs-nodes/
 * ├── users.json              # 用户注册表
 * ├── registry.json           # 全局节点注册表（跨用户发现）
 * ├── users/
 * │   ├── alice/
 * │   │   ├── user.json       # 用户配置
 * │   │   ├── alice-node-0/   # 节点数据
 * │   │   ├── alice-node-1/
 * │   │   └── index.json      # 用户文件索引
 * │   └── bob/
 * │       ├── user.json
 * │       ├── bob-node-0/
 * │       └── index.json
 */

import fs from 'fs-extra';
import path from 'path';
import NodeManager from './node-manager.js';
import { generateAuthSecrets, generateToken, verifyToken } from './security.js';

const BASE_DIR = '/home/project/.ipfs-nodes';
const USERS_DIR = path.join(BASE_DIR, 'users');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const REGISTRY_FILE = path.join(BASE_DIR, 'registry.json');
const BASE_P2P_PORT = 9500;
const MAX_QUOTA_PER_NODE = 100 * 1024 * 1024; // 100MB

export class UserManager {
  constructor(baseDir = BASE_DIR) {
    this.baseDir = baseDir;
    this.usersDir = path.join(baseDir, 'users');
    this.usersFile = path.join(baseDir, 'users.json');
    this.registryFile = path.join(baseDir, 'registry.json');
  }

  /**
   * 注册用户
   * @param {string} username - 用户名（小写字母+数字+连字符）
   * @param {object} options - { displayName }
   */
  async registerUser(username, options = {}) {
    // 验证用户名格式
    if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(username)) {
      throw new Error('用户名格式无效：需要 3-30 位小写字母/数字/连字符，以字母开头');
    }

    const users = await this.loadUsers();
    if (users[username]) {
      throw new Error(`用户 ${username} 已存在`);
    }

    const userDir = path.join(this.usersDir, username);
    await fs.ensureDir(userDir);

    // P1: 生成认证密钥
    const secrets = generateAuthSecrets();

    const userConfig = {
      username,
      displayName: options.displayName || username,
      createdAt: new Date().toISOString(),
      nodeCount: 0,
      totalQuota: 0,
      usedSpace: 0,
      authSecret: secrets.authSecret
    };

    await fs.writeJson(path.join(userDir, 'user.json'), userConfig, { spaces: 2 });

    users[username] = {
      createdAt: userConfig.createdAt,
      displayName: userConfig.displayName
    };
    await this.saveUsers(users);

    return userConfig;
  }

  /**
   * P1: 用户登录，颁发 token
   * @param {string} username - 用户名
   * @returns {object} { token, expiresAt }
   */
  async login(username) {
    const user = await this.getUser(username);
    if (!user) throw new Error(`用户 ${username} 不存在`);
    if (!user.authSecret) throw new Error(`用户 ${username} 未启用认证（旧版用户），请重新注册`);
    return generateToken(username, user.authSecret);
  }

  /**
   * P1: 验证用户 token
   * @param {string} username - 用户名
   * @param {string} token - 认证 token
   * @returns {object} { valid, error }
   */
  async authenticate(username, token) {
    const user = await this.getUser(username);
    if (!user) return { valid: false, error: `用户 ${username} 不存在` };
    if (!user.authSecret) return { valid: false, error: '用户未启用认证' };
    return verifyToken(token, user.authSecret);
  }

  /**
   * 获取用户信息
   */
  async getUser(username) {
    const userDir = path.join(this.usersDir, username);
    const configPath = path.join(userDir, 'user.json');
    if (!await fs.pathExists(configPath)) return null;
    return await fs.readJson(configPath);
  }

  /**
   * 列出所有用户
   */
  async listUsers() {
    const users = await this.loadUsers();
    const result = [];

    for (const [username, info] of Object.entries(users)) {
      const userConfig = await this.getUser(username);
      if (userConfig) {
        result.push(userConfig);
      }
    }

    return result;
  }

  /**
   * 为用户启动节点
   * @param {string} username - 用户名
   * @param {number} count - 节点数量
   * @param {object} options - { quotaPerNode }
   */
  async startUserNodes(username, count = 3, options = {}) {
    const user = await this.getUser(username);
    if (!user) throw new Error(`用户 ${username} 不存在`);

    const userDir = path.join(this.usersDir, username);
    const registry = await this.loadRegistry();

    // 计算端口：基于全局注册表中已有节点数
    const existingPorts = Object.values(registry).map(n => n.port);
    let nextPort = BASE_P2P_PORT;
    while (existingPorts.includes(nextPort)) nextPort++;

    const quotaPerNode = options.quotaPerNode || MAX_QUOTA_PER_NODE;
    const nodes = [];

    for (let i = 0; i < count; i++) {
      const nodeId = `${username}-node-${i}`;
      const nodeDir = path.join(userDir, nodeId);
      await fs.ensureDir(nodeDir);
      await fs.ensureDir(path.join(nodeDir, 'blocks'));

      // 创建节点身份（复用 NodeManager 的密钥生成逻辑）
      const nodeManager = new NodeManager(userDir);
      const identity = await nodeManager.createIdentity(nodeId);

      const port = nextPort + i;
      const nodeConfig = {
        nodeId,
        owner: username,
        peerId: identity.peerId,
        status: 'running',
        startedAt: new Date().toISOString(),
        quota: quotaPerNode,
        usedSpace: 0,
        port,
        p2pEnabled: false,
        multiaddr: `/ip4/127.0.0.1/tcp/${port}/ws/p2p/${identity.peerId}`
      };

      await fs.writeJson(path.join(nodeDir, 'config.json'), nodeConfig, { spaces: 2 });

      // 注册到全局注册表
      registry[nodeId] = {
        owner: username,
        peerId: identity.peerId,
        port,
        multiaddr: nodeConfig.multiaddr,
        status: 'running',
        registeredAt: new Date().toISOString()
      };

      nodes.push(nodeConfig);
    }

    await this.saveRegistry(registry);

    // 更新用户配置
    user.nodeCount = (user.nodeCount || 0) + count;
    user.totalQuota = (user.totalQuota || 0) + quotaPerNode * count;
    await fs.writeJson(path.join(userDir, 'user.json'), user, { spaces: 2 });

    return nodes;
  }

  /**
   * 获取用户的所有节点
   */
  async getUserNodes(username) {
    const userDir = path.join(this.usersDir, username);
    if (!await fs.pathExists(userDir)) return [];

    const dirs = await fs.readdir(userDir);
    const nodes = [];

    for (const dir of dirs) {
      if (!dir.startsWith(`${username}-node-`)) continue;
      const configPath = path.join(userDir, dir, 'config.json');
      if (await fs.pathExists(configPath)) {
        nodes.push(await fs.readJson(configPath));
      }
    }

    return nodes;
  }

  /**
   * 获取全局节点注册表
   */
  async loadRegistry() {
    if (await fs.pathExists(this.registryFile)) {
      return await fs.readJson(this.registryFile);
    }
    return {};
  }

  /**
   * 保存全局节点注册表
   */
  async saveRegistry(registry) {
    await fs.ensureDir(this.baseDir);
    const tmpPath = this.registryFile + `.tmp.${process.pid}`;
    await fs.writeJson(tmpPath, registry, { spaces: 2 });
    await fs.rename(tmpPath, this.registryFile);
  }

  /**
   * 获取其他用户的节点（用于跨用户互联）
   * @param {string} excludeUser - 排除的用户
   */
  async getOtherUsersNodes(excludeUser) {
    const registry = await this.loadRegistry();
    return Object.entries(registry)
      .filter(([nodeId, info]) => info.owner !== excludeUser && info.status === 'running')
      .map(([nodeId, info]) => ({ nodeId, ...info }));
  }

  /**
   * 获取网络统计
   */
  async getNetworkStats() {
    const users = await this.loadUsers();
    const registry = await this.loadRegistry();

    const userStats = [];
    for (const username of Object.keys(users)) {
      const userConfig = await this.getUser(username);
      const nodes = await this.getUserNodes(username);
      userStats.push({
        username,
        displayName: userConfig?.displayName || username,
        nodeCount: nodes.length,
        runningNodes: nodes.filter(n => n.status === 'running').length,
        totalQuota: nodes.reduce((s, n) => s + (n.quota || 0), 0),
        usedSpace: nodes.reduce((s, n) => s + (n.usedSpace || 0), 0)
      });
    }

    return {
      totalUsers: Object.keys(users).length,
      totalNodes: Object.keys(registry).length,
      runningNodes: Object.values(registry).filter(n => n.status === 'running').length,
      users: userStats
    };
  }

  /**
   * 获取用户的 NodeManager 实例（用于文件操作）
   */
  getUserNodeManager(username) {
    const userDir = path.join(this.usersDir, username);
    return new NodeManager(userDir);
  }

  // ==================== 内部方法 ====================

  async loadUsers() {
    if (await fs.pathExists(this.usersFile)) {
      return await fs.readJson(this.usersFile);
    }
    return {};
  }

  async saveUsers(users) {
    await fs.ensureDir(this.baseDir);
    const tmpPath = this.usersFile + `.tmp.${process.pid}`;
    await fs.writeJson(tmpPath, users, { spaces: 2 });
    await fs.rename(tmpPath, this.usersFile);
  }
}

export default UserManager;
