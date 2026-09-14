/**
 * libp2p 真实网络模块
 * 基于 WebSocket transport 实现节点间真实 P2P 互联
 * 支持：节点创建、连接管理、协议流通信、gossipsub 广播
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
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { encode, decode } from 'it-length-prefixed';
import fs from 'fs-extra';
import path from 'path';
import { loadWhitelist, isPeerAllowed, signMessage, verifyMessageSignature } from './security.js';

const NODES_DIR = '/home/project/.ipfs-nodes';
const ACP_PROTOCOL_ID = '/acp/1.0.0';
const GOSSIPSUB_TOPIC = 'ipfs-storage-network';

// 活跃节点实例注册表（进程内）
const activeNodes = new Map();

/**
 * 创建并启动一个真实的 libp2p 节点
 * @param {string} nodeId - 节点 ID (如 node-0)
 * @param {object} options - { port, privateKeyBase64 }
 * @returns {object} libp2p 实例
 */
export async function startLibp2pNode(nodeId, options = {}) {
  const { port = 9500 } = options;

  // 加载或生成密钥对
  let privateKey;
  const keyPath = path.join(NODES_DIR, nodeId, 'private.key');

  if (options.privateKeyBase64) {
    privateKey = keys.privateKeyFromProtobuf(Buffer.from(options.privateKeyBase64, 'base64'));
  } else if (await fs.pathExists(keyPath)) {
    const keyData = await fs.readFile(keyPath);
    privateKey = keys.privateKeyFromProtobuf(keyData);
  } else {
    privateKey = await keys.generateKeyPair('Ed25519');
    await fs.ensureDir(path.join(NODES_DIR, nodeId));
    await fs.writeFile(keyPath, keys.privateKeyToProtobuf(privateKey));
  }

  const peerId = peerIdFromPrivateKey(privateKey);

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

  // 注册 ACP 协议处理器
  node.handle(ACP_PROTOCOL_ID, ({ stream, connection }) => {
    handleIncomingStream(nodeId, stream, connection);
  });

  // 启动时即订阅 gossipsub topic，确保 mesh 有足够时间建立
  node.services.pubsub.subscribe(GOSSIPSUB_TOPIC);

  // P1: 节点白名单 - 连接时验证对端身份
  node.addEventListener('peer:connect', async (evt) => {
    const remotePeerId = evt.detail.toString();
    const whitelist = await loadWhitelist(NODES_DIR);
    if (!isPeerAllowed(remotePeerId, whitelist)) {
      log(nodeId, `BLOCKED peer (not in whitelist): ${remotePeerId.slice(0, 20)}...`);
      // 断开不在白名单中的连接
      const connections = node.getConnections(evt.detail);
      for (const conn of connections) {
        await conn.close();
      }
      return;
    }
    log(nodeId, `peer connected: ${remotePeerId.slice(0, 20)}...`);
  });

  node.addEventListener('peer:disconnect', (evt) => {
    log(nodeId, `peer disconnected: ${evt.detail.toString().slice(0, 20)}...`);
  });

  activeNodes.set(nodeId, node);

  return {
    nodeId,
    peerId: peerId.toString(),
    libp2p: node,
    multiaddrs: node.getMultiaddrs().map(a => a.toString()),
    port
  };
}

/**
 * 连接到另一个节点
 */
export async function connectToPeer(nodeId, targetMultiaddr) {
  const node = activeNodes.get(nodeId);
  if (!node) throw new Error(`节点 ${nodeId} 未启动`);

  const addr = multiaddr(targetMultiaddr);
  const connection = await node.dial(addr);
  return {
    success: true,
    remotePeer: connection.remotePeer.toString(),
    status: connection.status
  };
}

/**
 * 获取节点的 peers 列表
 */
export function getPeers(nodeId) {
  const node = activeNodes.get(nodeId);
  if (!node) return [];

  return node.getPeers().map(peerId => ({
    peerId: peerId.toString(),
    connections: node.getConnections(peerId).length
  }));
}

/**
 * 通过 libp2p 流发送 ACP 消息
 * 使用 it-length-prefixed 编解码器进行消息帧处理
 */
export async function sendP2PMessage(fromNodeId, toPeerId, message) {
  const node = activeNodes.get(fromNodeId);
  if (!node) throw new Error(`节点 ${fromNodeId} 未启动`);

  const targetPeerId = typeof toPeerId === 'string' ? peerIdFromString(toPeerId) : toPeerId;

  // 优先通过已有连接打开流（全网格拓扑下节点间已有连接）
  let stream;
  const connections = node.getConnections(targetPeerId);
  if (connections.length > 0) {
    stream = await connections[0].newStream(ACP_PROTOCOL_ID);
  } else {
    // 无已有连接：从同进程 activeNodes 查找地址后拨号
    let targetAddr = null;
    for (const [, n] of activeNodes) {
      if (n.peerId.toString() === targetPeerId.toString()) {
        targetAddr = n.getMultiaddrs()[0];
        break;
      }
    }
    if (!targetAddr) {
      throw new Error(`peer ${toPeerId} 无连接且不在同进程内，请先通过 connectToPeer 建立连接`);
    }
    stream = await node.dialProtocol(targetAddr, ACP_PROTOCOL_ID);
  }

  // 使用 it-length-prefixed 编码发送消息
  const payload = Buffer.from(JSON.stringify(message));

  await stream.sink(encode([payload]));

  // 读取响应（使用 it-length-prefixed 解码）
  let response = null;
  for await (const msg of decode(stream.source)) {
    try {
      response = JSON.parse(Buffer.from(msg.subarray ? msg.subarray() : msg).toString());
    } catch (e) {
      // 忽略解析错误
    }
    break;
  }

  await stream.close();
  return response;
}

/**
 * 通过 gossipsub 广播消息
 */
export async function broadcastGossip(nodeId, message, options = {}) {
  const node = activeNodes.get(nodeId);
  if (!node) throw new Error(`节点 ${nodeId} 未启动`);

  const pubsub = node.services.pubsub;
  // 确保已订阅（启动时已订阅，此处为防御性检查）
  if (!pubsub.getTopics().includes(GOSSIPSUB_TOPIC)) {
    await pubsub.subscribe(GOSSIPSUB_TOPIC);
  }

  // P1: 消息签名（如果提供了签名密钥）
  let finalMessage = message;
  if (options.signSecret) {
    finalMessage = signMessage(message, options.signSecret);
  }

  const payload = Buffer.from(JSON.stringify(finalMessage));
  const result = await pubsub.publish(GOSSIPSUB_TOPIC, payload);

  return {
    topic: GOSSIPSUB_TOPIC,
    recipients: result.recipients?.length ?? 0,
    messageId: result.messageId
  };
}

/**
 * 订阅 gossipsub 消息
 */
export function subscribeGossip(nodeId, callback, options = {}) {
  const node = activeNodes.get(nodeId);
  if (!node) throw new Error(`节点 ${nodeId} 未启动`);

  const pubsub = node.services.pubsub;
  pubsub.subscribe(GOSSIPSUB_TOPIC);

  const handler = (evt) => {
    try {
      const message = JSON.parse(Buffer.from(evt.detail.data).toString());

      // P1: 验证消息签名（如果配置了验证密钥）
      if (options.verifySecret && message._sig) {
        if (!verifyMessageSignature(message, options.verifySecret)) {
          log(nodeId, `DROPPED message with invalid signature from ${evt.detail.from?.toString().slice(0, 20)}...`);
          return; // 丢弃签名无效的消息
        }
      }

      callback(message, evt.detail.from?.toString());
    } catch (e) {
      // 忽略解析错误
    }
  };

  pubsub.addEventListener('message', handler);
  return () => pubsub.removeEventListener('message', handler);
}

/**
 * 停止节点
 */
export async function stopLibp2pNode(nodeId) {
  const node = activeNodes.get(nodeId);
  if (!node) return { success: false, error: `节点 ${nodeId} 未运行` };

  await node.stop();
  activeNodes.delete(nodeId);
  return { success: true, nodeId };
}

/**
 * 获取活跃节点列表
 */
export function getActiveNodes() {
  return Array.from(activeNodes.keys());
}

// ==================== 内部函数 ====================

/**
 * 处理入站协议流
 * 使用 it-length-prefixed 解码消息帧
 */
async function handleIncomingStream(nodeId, stream, connection) {
  const remotePeer = connection.remotePeer.toString();

  try {
    for await (const msg of decode(stream.source)) {
      const data = msg.subarray ? Buffer.from(msg.subarray()) : Buffer.from(msg);
      try {
        const message = JSON.parse(data.toString());
        log(nodeId, `received message from ${remotePeer.slice(0, 20)}...: ${message.type}`);

        // 发送确认响应（使用 it-length-prefixed 编码）
        const ack = JSON.stringify({
          type: 'ack',
          receivedType: message.type,
          timestamp: new Date().toISOString()
        });

        await stream.sink(encode([Buffer.from(ack)]));
      } catch (e) {
        log(nodeId, `failed to parse message: ${e.message}`);
      }
    }
  } catch (e) {
    log(nodeId, `stream error: ${e.message}`);
  }
}

function log(nodeId, msg) {
  // 静默日志，避免干扰 CLI 输出
  // console.error(`[${nodeId}] ${msg}`);
}

export default {
  startLibp2pNode,
  connectToPeer,
  getPeers,
  sendP2PMessage,
  broadcastGossip,
  subscribeGossip,
  stopLibp2pNode,
  getActiveNodes
};
