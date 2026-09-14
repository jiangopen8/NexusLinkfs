/**
 * IPFS 分布式存储网络 - 多用户 P2P 网络模块
 * 
 * 跨用户节点互联：
 * - 启动指定用户的所有节点为真实 libp2p 实例
 * - 通过全局注册表发现其他用户的节点
 * - 建立跨用户全网格连接（同用户内 + 跨用户）
 * - 共享 floodsub 广播通道，所有用户节点可互相通信
 * 
 * 使用方式：
 *   const network = new MultiUserNetwork();
 *   await network.startUserNetwork('alice');  // 启动 alice 的节点
 *   await network.startUserNetwork('bob');    // 启动 bob 的节点
 *   await network.connectAllUsers();          // 跨用户互联
 */

import './polyfills.js';
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { floodsub } from '@libp2p/floodsub';
import { multiaddr } from '@multiformats/multiaddr';
import { keys } from '@libp2p/crypto';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import fs from 'fs-extra';
import path from 'path';
import UserManager from './user-manager.js';

const BASE_DIR = '/home/project/.ipfs-nodes';
const FLOODSUB_TOPIC = 'ipfs-multi-user-network';

// 活跃节点实例（进程内）
const activeNodes = new Map(); // nodeId -> libp2p instance

export class MultiUserNetwork {
  constructor(baseDir = BASE_DIR) {
    this.baseDir = baseDir;
    this.userManager = new UserManager(baseDir);
  }

  /**
   * 启动指定用户的所有节点为真实 libp2p 实例
   * @param {string} username - 用户名
   * @returns {object} 启动结果
   */
  async startUserNetwork(username) {
    const userNodes = await this.userManager.getUserNodes(username);
    if (userNodes.length === 0) {
      throw new Error(`用户 ${username} 没有节点，请先运行 user start`);
    }

    const startedNodes = [];

    for (const nodeConfig of userNodes) {
      if (nodeConfig.status !== 'running') continue;

      const { nodeId, port } = nodeConfig;
      const userDir = path.join(this.baseDir, 'users', username);
      const keyPath = path.join(userDir, nodeId, 'private.key');

      // 加载密钥
      let privateKey;
      if (await fs.pathExists(keyPath)) {
        const keyData = await fs.readFile(keyPath);
        privateKey = keys.privateKeyFromProtobuf(keyData);
      } else {
        privateKey = await keys.generateKeyPair('Ed25519');
        await fs.writeFile(keyPath, keys.privateKeyToProtobuf(privateKey));
      }

      const peerId = peerIdFromPrivateKey(privateKey);

      // 创建 libp2p 节点
      const node = await createLibp2p({
        peerId,
        addresses: {
          listen: [`/ip4/127.0.0.1/tcp/${port}/ws`]
        },
        transports: [webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
          identify: identify(),
          pubsub: floodsub()
        }
      });

      // 订阅共享广播通道
      node.services.pubsub.subscribe(FLOODSUB_TOPIC);

      activeNodes.set(nodeId, node);

      const multiaddrs = node.getMultiaddrs().map(a => a.toString());
      startedNodes.push({
        nodeId,
        owner: username,
        peerId: peerId.toString(),
        multiaddr: multiaddrs[0],
        port
      });

      // 更新注册表中的 multiaddr（实际监听地址）
      const registry = await this.userManager.loadRegistry();
      if (registry[nodeId]) {
        registry[nodeId].multiaddr = multiaddrs[0];
        registry[nodeId].p2pActive = true;
        await this.userManager.saveRegistry(registry);
      }
    }

    // 同用户内节点互联（全网格）
    for (let i = 0; i < startedNodes.length; i++) {
      for (let j = i + 1; j < startedNodes.length; j++) {
        try {
          await this.connectNodes(startedNodes[i].nodeId, startedNodes[j].multiaddr);
        } catch (err) {
          // 连接失败不阻断
        }
      }
    }

    return {
      username,
      nodes: startedNodes,
      nodeCount: startedNodes.length
    };
  }

  /**
   * 跨用户互联：将所有活跃用户节点连接为全网格
   * @returns {object} 互联结果
   */
  async connectAllUsers() {
    const allNodeIds = Array.from(activeNodes.keys());
    let connections = 0;
    let failures = 0;

    // 全网格连接（跨用户）
    for (let i = 0; i < allNodeIds.length; i++) {
      for (let j = i + 1; j < allNodeIds.length; j++) {
        const nodeA = activeNodes.get(allNodeIds[i]);
        const nodeB = activeNodes.get(allNodeIds[j]);

        if (!nodeA || !nodeB) continue;

        // 检查是否已连接
        const alreadyConnected = nodeA.getPeers().some(
          p => p.toString() === nodeB.peerId.toString()
        );
        if (alreadyConnected) continue;

        try {
          const addrB = nodeB.getMultiaddrs()[0];
          if (addrB) {
            await nodeA.dial(addrB);
            connections++;
          }
        } catch (err) {
          failures++;
        }
      }
    }

    // 等待连接稳定
    await new Promise(r => setTimeout(r, 500));

    return {
      totalNodes: allNodeIds.length,
      newConnections: connections,
      failures,
      topology: 'full-mesh'
    };
  }

  /**
   * 启动多用户网络（一键启动所有用户节点并互联）
   * @param {string[]} usernames - 要启动的用户列表（空则全部）
   */
  async startMultiUserNetwork(usernames = []) {
    const allUsers = await this.userManager.listUsers();
    const targetUsers = usernames.length > 0
      ? allUsers.filter(u => usernames.includes(u.username))
      : allUsers;

    if (targetUsers.length === 0) {
      throw new Error('没有可启动的用户，请先注册用户');
    }

    const results = [];

    // 逐用户启动节点
    for (const user of targetUsers) {
      try {
        const result = await this.startUserNetwork(user.username);
        results.push(result);
      } catch (err) {
        results.push({ username: user.username, error: err.message });
      }
    }

    // 跨用户互联
    const meshResult = await this.connectAllUsers();

    // 统计每个节点的 peers
    const nodeStatus = [];
    for (const [nodeId, node] of activeNodes) {
      nodeStatus.push({
        nodeId,
        peers: node.getPeers().length
      });
    }

    return {
      users: results,
      mesh: meshResult,
      nodeStatus,
      totalActiveNodes: activeNodes.size
    };
  }

  /**
   * 广播消息到所有用户节点
   */
  async broadcast(fromNodeId, message) {
    const node = activeNodes.get(fromNodeId);
    if (!node) throw new Error(`节点 ${fromNodeId} 未启动`);

    const payload = Buffer.from(JSON.stringify({
      ...message,
      from: fromNodeId,
      timestamp: new Date().toISOString()
    }));

    const result = await node.services.pubsub.publish(FLOODSUB_TOPIC, payload);
    return {
      topic: FLOODSUB_TOPIC,
      recipients: result.recipients?.length ?? 0
    };
  }

  /**
   * 订阅广播消息
   */
  subscribe(nodeId, callback) {
    const node = activeNodes.get(nodeId);
    if (!node) throw new Error(`节点 ${nodeId} 未启动`);

    const handler = (evt) => {
      try {
        const message = JSON.parse(Buffer.from(evt.detail.data).toString());
        callback(message, evt.detail.from?.toString());
      } catch (e) { /* ignore */ }
    };

    node.services.pubsub.addEventListener('message', handler);
    return () => node.services.pubsub.removeEventListener('message', handler);
  }

  /**
   * 获取节点 peers
   */
  getPeers(nodeId) {
    const node = activeNodes.get(nodeId);
    if (!node) return [];
    return node.getPeers().map(p => p.toString());
  }

  /**
   * 停止所有节点
   */
  async stopAll() {
    for (const [nodeId, node] of activeNodes) {
      try {
        await node.stop();
      } catch (e) { /* ignore */ }
    }
    activeNodes.clear();
  }

  /**
   * 停止指定用户的节点
   */
  async stopUserNodes(username) {
    const stopped = [];
    for (const [nodeId, node] of activeNodes) {
      if (nodeId.startsWith(`${username}-node-`)) {
        try {
          await node.stop();
          stopped.push(nodeId);
        } catch (e) { /* ignore */ }
        activeNodes.delete(nodeId);
      }
    }
    return stopped;
  }

  /**
   * 获取活跃节点列表
   */
  getActiveNodes() {
    return Array.from(activeNodes.keys());
  }

  // ==================== 内部方法 ====================

  async connectNodes(fromNodeId, targetMultiaddr) {
    const node = activeNodes.get(fromNodeId);
    if (!node) throw new Error(`节点 ${fromNodeId} 未启动`);

    const addr = multiaddr(targetMultiaddr);
    await node.dial(addr);
    return { success: true };
  }
}

export default MultiUserNetwork;
