/**
 * IPFS 分布式存储网络 - 插件签名验证模块（PluginSignature）
 * 
 * 为远程/本地插件提供 HMAC-SHA256 签名与验签能力，防止加载被篡改的恶意插件。
 * 
 * 签名流程：
 * 1. 读取插件文件内容
 * 2. 使用密钥计算 HMAC-SHA256
 * 3. 生成 .sig 签名文件（JSON 格式，含 hmac、keyId、signedAt）
 * 
 * 验签流程：
 * 1. 读取插件文件内容和对应 .sig 文件
 * 2. 重新计算 HMAC 并与签名文件中的值比对
 * 3. 使用 timingSafeEqual 防止时序攻击
 * 
 * 密钥管理：
 * - 密钥存储在 .ipfs-nodes/plugin-keys.json
 * - 支持多密钥（keyId 标识）
 * - 首次使用自动生成默认密钥
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const NODES_DIR = resolve('/home/project/.ipfs-nodes');
const KEYS_FILE = join(NODES_DIR, 'plugin-keys.json');

export class PluginSignature {
  constructor(options = {}) {
    this.keysFile = options.keysFile || KEYS_FILE;
    this._keys = null;
  }

  /**
   * 加载密钥库（懒加载）
   */
  _loadKeys() {
    if (this._keys) return this._keys;
    if (existsSync(this.keysFile)) {
      try {
        this._keys = JSON.parse(readFileSync(this.keysFile, 'utf-8'));
      } catch {
        this._keys = { keys: {} };
      }
    } else {
      this._keys = { keys: {} };
    }
    return this._keys;
  }

  /**
   * 保存密钥库
   */
  _saveKeys() {
    mkdirSync(NODES_DIR, { recursive: true });
    writeFileSync(this.keysFile, JSON.stringify(this._keys, null, 2), 'utf-8');
  }

  /**
   * 获取或创建密钥
   * @param {string} keyId - 密钥标识（默认 'default'）
   * @returns {string} 密钥值
   */
  getKey(keyId = 'default') {
    const store = this._loadKeys();
    if (!store.keys[keyId]) {
      // 自动生成新密钥
      store.keys[keyId] = randomBytes(32).toString('hex');
      this._saveKeys();
    }
    return store.keys[keyId];
  }

  /**
   * 列出所有密钥 ID
   */
  listKeys() {
    const store = this._loadKeys();
    return Object.keys(store.keys);
  }

  /**
   * 为文件内容计算 HMAC-SHA256
   * @param {string} content - 文件内容
   * @param {string} keyId - 密钥标识
   * @returns {object} { success, hmac, keyId }
   */
  signContent(content, keyId = 'default') {
    try {
      const key = this.getKey(keyId);
      const hmac = createHmac('sha256', key).update(content, 'utf-8').digest('hex');
      return { success: true, hmac, keyId };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 验证文件内容的签名
   * @param {string} content - 文件内容
   * @param {string|object} signature - 签名内容（JSON 字符串或对象）
   * @returns {object} { valid, reason?, keyId? }
   */
  verifyContent(content, signature) {
    try {
      const sigData = typeof signature === 'string' ? JSON.parse(signature) : signature;
      if (!sigData.hmac) {
        return { valid: false, reason: '签名格式无效：缺少 hmac 字段' };
      }

      const keyId = sigData.keyId || 'default';
      const expected = this.signContent(content, keyId);
      if (!expected.success) {
        return { valid: false, reason: `密钥不可用: ${keyId}` };
      }

      // 使用 timingSafeEqual 防止时序攻击
      const expectedBuf = Buffer.from(expected.hmac, 'hex');
      const actualBuf = Buffer.from(sigData.hmac, 'hex');
      if (expectedBuf.length !== actualBuf.length) {
        return { valid: false, reason: '签名长度不匹配' };
      }

      const match = timingSafeEqual(expectedBuf, actualBuf);
      if (!match) {
        return { valid: false, reason: 'HMAC 不匹配（文件可能被篡改）' };
      }

      return { valid: true, keyId, signedAt: sigData.signedAt };
    } catch (e) {
      return { valid: false, reason: `验签异常: ${e.message}` };
    }
  }

  /**
   * 为文件生成签名
   * @param {string} filePath - 文件路径
   * @param {string} keyId - 密钥标识
   * @returns {object} { success, hmac?, sigPath?, error? }
   */
  async sign(filePath, keyId = 'default') {
    const absolutePath = resolve(filePath);
    if (!existsSync(absolutePath)) {
      return { success: false, error: `文件不存在: ${absolutePath}` };
    }

    const content = readFileSync(absolutePath, 'utf-8');
    const result = this.signContent(content, keyId);
    if (!result.success) {
      return result;
    }

    // 生成签名文件
    const sigData = {
      hmac: result.hmac,
      keyId: result.keyId,
      algorithm: 'HMAC-SHA256',
      signedAt: new Date().toISOString(),
      file: absolutePath
    };

    const sigPath = absolutePath + '.sig';
    writeFileSync(sigPath, JSON.stringify(sigData, null, 2), 'utf-8');

    return { success: true, hmac: result.hmac, keyId: result.keyId, sigPath };
  }

  /**
   * 验证文件签名
   * @param {string} filePath - 文件路径
   * @returns {object} { valid, reason?, keyId?, signedAt? }
   */
  async verify(filePath) {
    const absolutePath = resolve(filePath);
    const sigPath = absolutePath + '.sig';

    if (!existsSync(absolutePath)) {
      return { valid: false, reason: `文件不存在: ${absolutePath}` };
    }
    if (!existsSync(sigPath)) {
      return { valid: false, reason: `签名文件不存在: ${sigPath}` };
    }

    const content = readFileSync(absolutePath, 'utf-8');
    const sigContent = readFileSync(sigPath, 'utf-8');

    return this.verifyContent(content, sigContent);
  }

  /**
   * 删除密钥
   * @param {string} keyId - 密钥标识
   */
  removeKey(keyId) {
    const store = this._loadKeys();
    if (store.keys[keyId]) {
      delete store.keys[keyId];
      this._saveKeys();
      return true;
    }
    return false;
  }
}

export default PluginSignature;
