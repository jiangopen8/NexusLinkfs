/**
 * PeerID 工具函数
 */

import { peerIdFromString } from '@libp2p/peer-id';

/**
 * 导出 PeerID 为可序列化格式
 */
export function exportPeerId(peerId) {
  return {
    string: peerId.toString(),
    bytes: Buffer.from(peerId.toMultihash().bytes).toString('base64')
  };
}

/**
 * 从序列化格式导入 PeerID
 */
export function importPeerId(data) {
  if (typeof data === 'string') {
    return peerIdFromString(data);
  }
  if (data.bytes) {
    return peerIdFromString(data.string);
  }
  throw new Error('无效的 PeerID 数据格式');
}

/**
 * 生成 CID 风格的节点标识
 */
export function generateNodeCID(peerIdString, timestamp) {
  // 使用 peerId + 时间戳生成唯一标识
  const data = `${peerIdString}:${timestamp}`;
  const hash = simpleHash(data);
  return `bafy${hash}`;
}

/**
 * 简单哈希函数（用于生成 CID 风格标识）
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36) + Date.now().toString(36);
}
