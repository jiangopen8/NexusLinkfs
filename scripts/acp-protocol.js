/**
 * ACP (Agent Communication Protocol) 协议封装模块
 * 基于 AgentUnion ACP 规范，实现 Agent 身份标识(AID)、接入点(AP)、
 * 会话管理、消息通信、能力发现等核心功能
 * 
 * 协议栈：
 *   应用层：ACP JSON 消息格式
 *   会话层：会话创建/管理/关闭
 *   传输层：HTTPS / WSS / SSE
 *   网络层：TCP/IP (libp2p)
 */

import fs from 'fs-extra';
import path from 'path';
import CryptoJS from 'crypto-js';

const NODES_DIR = '/home/project/.ipfs-nodes';
const ACP_DIR = path.join(NODES_DIR, '.acp');

// 延迟导入 libp2p 网络模块（避免不需要真实网络时的加载开销）
let libp2pNetwork = null;
async function getLibp2pNetwork() {
  if (!libp2pNetwork) {
    libp2pNetwork = await import('./libp2p-network.js');
  }
  return libp2pNetwork;
}

/**
 * ACP 消息类型枚举
 */
export const MessageType = {
  HELLO: 'hello',           // 上线广播
  DISCOVER: 'discover',     // 能力发现
  SESSION_CREATE: 'session.create',
  SESSION_CLOSE: 'session.close',
  MESSAGE: 'message',       // 普通消息
  TASK: 'task',             // 任务委派
  TASK_RESULT: 'task.result',
  STORAGE_REQUEST: 'storage.request',   // 存储请求
  STORAGE_RESPONSE: 'storage.response', // 存储响应
  HEARTBEAT: 'heartbeat',   // 心跳
  BYE: 'bye'                // 下线通知
};

/**
 * ACP 协议封装类
 */
export class ACPProtocol {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.acpDir = ACP_DIR;
    this.sessions = new Map();
    this.messageQueue = [];
  }

  /**
   * 初始化 ACP 协议层
   */
  async init() {
    await fs.ensureDir(this.acpDir);
    await fs.ensureDir(path.join(this.acpDir, 'sessions'));
    await fs.ensureDir(path.join(this.acpDir, 'messages'));
    await fs.ensureDir(path.join(this.acpDir, 'profiles'));

    const acpConfig = {
      version: '1.0.0',
      protocol: 'ACP',
      specVersion: '2025.05',
      createdAt: new Date().toISOString(),
      transport: ['local-ipc', 'libp2p-websocket', 'libp2p-floodsub'],
      messageFormat: 'json',
      encryption: 'AES-256'
    };

    await fs.writeJson(path.join(this.acpDir, 'config.json'), acpConfig, { spaces: 2 });
    return acpConfig;
  }

  /**
   * 注册 Agent 身份（AID）
   * AID 格式: {agent-name}.{ap-domain}
   * 在本地网络中，使用 PeerID 作为 AID 的基础
   */
  async registerAgent(nodeId, agentName, capabilities = []) {
    const identityPath = path.join(this.nodesDir, nodeId, 'identity.json');
    let identity = null;

    if (await fs.pathExists(identityPath)) {
      identity = await fs.readJson(identityPath);
    }

    const aid = {
      aid: `${agentName}.local.acp`,
      agentName,
      nodeId,
      peerId: identity?.peerId || null,
      capabilities,
      registeredAt: new Date().toISOString(),
      status: 'active'
    };

    // 生成 AgentProfile（Agent 的"名片"）
    const profile = this.createAgentProfile(agentName, capabilities);

    // 持久化
    await fs.writeJson(
      path.join(this.acpDir, 'profiles', `${agentName}.json`),
      { aid, profile },
      { spaces: 2 }
    );

    return { aid, profile };
  }

  /**
   * 创建 AgentProfile（能力描述）
   */
  createAgentProfile(name, capabilities) {
    return {
      publisherInfo: {
        name: 'ipfs-storage-network',
        contact: 'local@acp.network'
      },
      name,
      description: `IPFS 分布式存储网络节点 - ${name}`,
      version: '1.0.0',
      capabilities: {
        core: ['storage', 'retrieval', ...capabilities],
        extended: ['encrypted-storage', 'replicated-storage']
      },
      input: {
        types: ['application/octet-stream', 'text/plain', 'application/json'],
        maxLength: 100 * 1024 * 1024 // 100MB 上限
      },
      output: {
        types: ['application/octet-stream', 'application/json'],
        streaming: true
      },
      authorization: {
        mode: 'free',
        description: '本地网络免费使用'
      }
    };
  }

  /**
   * 创建通信会话
   */
  async createSession(fromAid, toAid, options = {}) {
    const sessionId = this.generateSessionId();
    const session = {
      sessionId,
      from: fromAid,
      to: toAid,
      status: 'active',
      createdAt: new Date().toISOString(),
      messageCount: 0,
      encrypted: options.encrypted || false,
      messages: []
    };

    this.sessions.set(sessionId, session);

    // 持久化会话
    await fs.writeJson(
      path.join(this.acpDir, 'sessions', `${sessionId}.json`),
      session,
      { spaces: 2 }
    );

    return session;
  }

  /**
   * 发送 ACP 消息
   */
  async sendMessage(sessionId, content, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // 尝试从磁盘加载
      const loaded = await this.loadSession(sessionId);
      if (!loaded) {
        throw new Error(`会话不存在: ${sessionId}`);
      }
      this.sessions.set(sessionId, loaded);
    }

    const activeSession = this.sessions.get(sessionId);

    const message = {
      id: this.generateMessageId(),
      sessionId,
      type: options.type || MessageType.MESSAGE,
      from: activeSession.from,
      to: activeSession.to,
      timestamp: new Date().toISOString(),
      content: this.wrapContent(content, options),
      metadata: {
        contentType: options.contentType || 'application/json',
        priority: options.priority || 'normal',
        ttl: options.ttl || 3600
      }
    };

    // 加密（如果会话要求）
    if (activeSession.encrypted && options.key) {
      message.content = this.encryptPayload(message.content, options.key);
      message.metadata.encrypted = true;
    }

    activeSession.messages.push(message);
    activeSession.messageCount++;

    // 持久化消息
    await fs.writeJson(
      path.join(this.acpDir, 'messages', `${message.id}.json`),
      message,
      { spaces: 2 }
    );

    // 更新会话
    await fs.writeJson(
      path.join(this.acpDir, 'sessions', `${sessionId}.json`),
      activeSession,
      { spaces: 2 }
    );

    // 通过 libp2p floodsub 真实广播（如果 P2P 网络已启动）
    try {
      const network = await getLibp2pNetwork();
      const activeNodeIds = network.getActiveNodes();
      if (activeNodeIds.length > 0) {
        // 使用第一个活跃节点广播
        const result = await network.broadcastGossip(activeNodeIds[0], {
          acp: true,
          type: message.type,
          sessionId,
          messageId: message.id,
          from: message.from,
          to: message.to,
          content: message.content,
          timestamp: message.timestamp
        });
        message.metadata.p2pBroadcast = { recipients: result.recipients };
      }
    } catch (e) {
      // P2P 广播失败不影响本地持久化
      message.metadata.p2pBroadcast = { error: e.message };
    }

    return message;
  }

  /**
   * 接收消息（从队列中获取）
   */
  async receiveMessages(sessionId, limit = 10) {
    const session = this.sessions.get(sessionId) || await this.loadSession(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    return session.messages.slice(-limit);
  }

  /**
   * 关闭会话
   */
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId) || await this.loadSession(sessionId);
    if (!session) {
      return { success: false, error: `会话不存在: ${sessionId}` };
    }

    session.status = 'closed';
    session.closedAt = new Date().toISOString();

    await fs.writeJson(
      path.join(this.acpDir, 'sessions', `${sessionId}.json`),
      session,
      { spaces: 2 }
    );

    this.sessions.delete(sessionId);
    return { success: true, sessionId, messageCount: session.messageCount };
  }

  /**
   * 能力发现 - 查找网络中具有特定能力的 Agent
   */
  async discoverAgents(requiredCapabilities = []) {
    const profilesDir = path.join(this.acpDir, 'profiles');
    if (!await fs.pathExists(profilesDir)) {
      return [];
    }

    const files = await fs.readdir(profilesDir);
    const agents = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readJson(path.join(profilesDir, file));
        const caps = data.profile?.capabilities?.core || [];
        
        // 检查是否满足所有必需能力
        const hasAllCaps = requiredCapabilities.every(cap => caps.includes(cap));
        if (hasAllCaps || requiredCapabilities.length === 0) {
          agents.push({
            aid: data.aid.aid,
            name: data.profile.name,
            capabilities: caps,
            status: data.aid.status
          });
        }
      }
    }

    return agents;
  }

  /**
   * 广播消息（发送到所有活跃 Agent）
   */
  async broadcast(fromAid, content, options = {}) {
    const agents = await this.discoverAgents();
    const results = [];

    for (const agent of agents) {
      if (agent.aid !== fromAid) {
        const session = await this.createSession(fromAid, agent.aid);
        const message = await this.sendMessage(session.sessionId, content, {
          ...options,
          type: options.type || MessageType.HELLO
        });
        results.push({ to: agent.aid, messageId: message.id });
        await this.closeSession(session.sessionId);
      }
    }

    return { broadcastCount: results.length, results };
  }

  /**
   * 存储请求协议 - 通过 ACP 协议发起存储操作
   */
  async storageRequest(fromAid, operation, payload) {
    const agents = await this.discoverAgents(['storage']);
    if (agents.length === 0) {
      throw new Error('网络中没有可用的存储节点');
    }

    // 选择第一个可用的存储 Agent
    const targetAgent = agents[0];
    const session = await this.createSession(fromAid, targetAgent.aid);

    const message = await this.sendMessage(session.sessionId, {
      operation, // 'upload' | 'download' | 'delete' | 'query'
      ...payload
    }, {
      type: MessageType.STORAGE_REQUEST,
      contentType: 'application/json'
    });

    return {
      sessionId: session.sessionId,
      messageId: message.id,
      targetAgent: targetAgent.aid
    };
  }

  /**
   * 获取 ACP 网络状态
   */
  async getNetworkStatus() {
    const agents = await this.discoverAgents();
    const sessionsDir = path.join(this.acpDir, 'sessions');
    let activeSessions = 0;
    let totalMessages = 0;

    if (await fs.pathExists(sessionsDir)) {
      const files = await fs.readdir(sessionsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const session = await fs.readJson(path.join(sessionsDir, file));
          if (session.status === 'active') activeSessions++;
          totalMessages += session.messageCount || 0;
        }
      }
    }

    return {
      protocol: 'ACP',
      version: '1.0.0',
      registeredAgents: agents.length,
      agents,
      activeSessions,
      totalMessages,
      transport: ['local-ipc', 'libp2p-websocket', 'libp2p-floodsub']
    };
  }

  // ==================== 内部工具方法 ====================

  wrapContent(content, options) {
    if (typeof content === 'string') {
      return { type: 'text/plain', data: content };
    }
    return { type: options.contentType || 'application/json', data: content };
  }

  encryptPayload(content, key) {
    const jsonStr = JSON.stringify(content);
    const encrypted = CryptoJS.AES.encrypt(jsonStr, key).toString();
    return { type: 'encrypted', data: encrypted };
  }

  decryptPayload(encryptedContent, key) {
    const decrypted = CryptoJS.AES.decrypt(encryptedContent.data, key);
    const jsonStr = decrypted.toString(CryptoJS.enc.Utf8);
    return JSON.parse(jsonStr);
  }

  generateSessionId() {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  generateMessageId() {
    return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  async loadSession(sessionId) {
    const sessionPath = path.join(this.acpDir, 'sessions', `${sessionId}.json`);
    if (!await fs.pathExists(sessionPath)) {
      return null;
    }
    return await fs.readJson(sessionPath);
  }
}

export default ACPProtocol;
