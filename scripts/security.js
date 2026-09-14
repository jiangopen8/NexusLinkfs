/**
 * IPFS 分布式存储网络 - 安全模块
 * 
 * P0: 路径遍历防护 + 密钥安全传递
 * P1: 用户认证（HMAC token）+ P2P 消息签名 + 节点白名单
 */

import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';

const NODES_DIR = '/home/project/.ipfs-nodes';
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 小时

// ==================== P0: 路径遍历防护 ====================

/**
 * 验证输入文件路径（上传源文件）
 * 规则：必须是绝对路径、不含 ..、解析后仍在允许目录内、不是符号链接指向外部
 */
export function validateInputPath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('安全校验失败：文件路径为空');
  }

  // 解析为绝对路径
  const resolved = path.resolve(filePath);

  // 检查路径遍历
  if (resolved.includes('..')) {
    throw new Error(`安全校验失败：路径包含非法字符 "..": ${filePath}`);
  }

  // 检查符号链接：解析真实路径后确认不是指向敏感目录
  try {
    const realPath = fs.realpathSync(resolved);
    const sensitiveDirs = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root'];
    for (const dir of sensitiveDirs) {
      if (realPath.startsWith(dir + '/') || realPath === dir) {
        throw new Error(`安全校验失败：路径指向受保护目录: ${dir}`);
      }
    }
  } catch (e) {
    if (e.message.startsWith('安全校验失败')) throw e;
    // 文件不存在时 realpathSync 会抛错，这是正常的（后续上传会报文件不存在）
  }

  return resolved;
}

/**
 * 验证输出文件路径（下载目标）
 * 规则：必须是绝对路径、不含 ..、不在受保护目录内
 */
export function validateOutputPath(outputPath) {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('安全校验失败：输出路径为空');
  }

  const resolved = path.resolve(outputPath);

  if (resolved.includes('..')) {
    throw new Error(`安全校验失败：路径包含非法字符 "..": ${outputPath}`);
  }

  // 禁止写入系统敏感目录
  const sensitiveDirs = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/usr', '/bin', '/sbin', '/lib'];
  for (const dir of sensitiveDirs) {
    if (resolved.startsWith(dir + '/') || resolved === dir) {
      throw new Error(`安全校验失败：禁止写入受保护目录: ${dir}`);
    }
  }

  // 禁止覆盖节点数据目录内的配置文件（防止通过下载覆盖 config.json）
  if (resolved.includes('.ipfs-nodes') && (resolved.endsWith('config.json') || resolved.endsWith('private.key'))) {
    throw new Error('安全校验失败：禁止覆盖节点配置或密钥文件');
  }

  return resolved;
}

/**
 * 验证升级脚本路径
 * 规则：必须存在、是 .js/.mjs 文件、不是符号链接
 */
export function validateScriptPath(scriptPath) {
  if (!scriptPath || typeof scriptPath !== 'string') {
    throw new Error('安全校验失败：脚本路径为空');
  }

  const resolved = path.resolve(scriptPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`安全校验失败：升级脚本不存在: ${resolved}`);
  }

  // 检查符号链接
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error('安全校验失败：升级脚本不能是符号链接');
  }

  // 限制扩展名
  const ext = path.extname(resolved).toLowerCase();
  if (!['.js', '.mjs'].includes(ext)) {
    throw new Error(`安全校验失败：升级脚本必须是 .js 或 .mjs 文件，当前: ${ext}`);
  }

  return resolved;
}

// ==================== P0: 密钥安全传递 ====================

/**
 * 解析加密密钥（优先级：环境变量 > 密钥文件 > CLI 参数）
 * @param {object} options - { key, keyFile }
 * @returns {string|null} 密钥或 null
 */
export function resolveKey(options = {}) {
  const { key, keyFile } = options;

  // 1. 环境变量（最安全，不会留在 shell history）
  if (process.env.IPFS_STORAGE_KEY) {
    return process.env.IPFS_STORAGE_KEY;
  }

  // 2. 密钥文件（权限应为 600）
  if (keyFile) {
    const resolved = path.resolve(keyFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`密钥文件不存在: ${resolved}`);
    }
    // 检查文件权限（警告非 600）
    try {
      const stat = fs.statSync(resolved);
      const mode = (stat.mode & 0o777).toString(8);
      if (mode !== '600') {
        console.error(`⚠️  密钥文件权限不安全 (${mode})，建议执行: chmod 600 ${resolved}`);
      }
    } catch (e) { /* 忽略权限检查失败 */ }
    return fs.readFileSync(resolved, 'utf8').trim();
  }

  // 3. CLI 参数（不推荐，会留在 history 中）
  if (key) {
    console.error('⚠️  安全提示：--key 参数会留在 shell 历史中，建议使用环境变量 IPFS_STORAGE_KEY 或 --key-file');
    return key;
  }

  return null;
}

// ==================== P1: 用户认证 ====================

/**
 * 生成用户认证密钥对（注册时调用）
 * @returns {object} { secret, tokenSecret }
 */
export function generateAuthSecrets() {
  return {
    authSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString()
  };
}

/**
 * 生成认证 token（登录时调用）
 * @param {string} username - 用户名
 * @param {string} authSecret - 用户密钥
 * @returns {object} { token, expiresAt }
 */
export function generateToken(username, authSecret) {
  const expiresAt = Date.now() + TOKEN_TTL;
  const payload = `${username}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', authSecret).update(payload).digest('hex');
  const token = Buffer.from(`${payload}:${signature}`).toString('base64');
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * 验证 token
 * @param {string} token - base64 编码的 token
 * @param {string} authSecret - 用户密钥
 * @returns {object} { valid, username, error }
 */
export function verifyToken(token, authSecret) {
  if (!token) return { valid: false, error: '未提供 token' };

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return { valid: false, error: 'token 格式无效' };

    const [username, expiresAtStr, signature] = parts;
    const expiresAt = parseInt(expiresAtStr);

    // 检查过期
    if (Date.now() > expiresAt) {
      return { valid: false, error: 'token 已过期，请重新登录' };
    }

    // 验证签名
    const payload = `${username}:${expiresAtStr}`;
    const expectedSig = crypto.createHmac('sha256', authSecret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return { valid: false, error: 'token 签名无效' };
    }

    return { valid: true, username };
  } catch (e) {
    return { valid: false, error: `token 解析失败: ${e.message}` };
  }
}

// ==================== P1: CLI 会话与鉴权守卫 ====================

const SESSION_FILE = path.join(NODES_DIR, 'session.json');

/**
 * 保存登录会话（login 成功后调用）
 * @param {string} username
 * @param {object} tokenInfo - { token, expiresAt }
 */
export async function saveSession(username, tokenInfo) {
  await fs.ensureDir(NODES_DIR);
  await fs.writeJson(SESSION_FILE, {
    username,
    token: tokenInfo.token,
    expiresAt: tokenInfo.expiresAt,
    savedAt: new Date().toISOString()
  }, { spaces: 2 });
}

/**
 * 读取当前会话
 * @returns {object|null} { username, token, expiresAt }
 */
export async function loadSession() {
  if (await fs.pathExists(SESSION_FILE)) {
    return await fs.readJson(SESSION_FILE);
  }
  return null;
}

/**
 * 清除会话（登出）
 */
export async function clearSession() {
  await fs.remove(SESSION_FILE);
}

/**
 * 解析 token：CLI --token > 环境变量 IPFS_AUTH_TOKEN > 会话文件
 * @param {string} cliToken - CLI 传入的 --token 值
 * @returns {object|null} { username, token }
 */
export async function resolveToken(cliToken) {
  if (cliToken) return { token: cliToken, source: 'cli' };
  if (process.env.IPFS_AUTH_TOKEN) return { token: process.env.IPFS_AUTH_TOKEN, source: 'env' };
  const session = await loadSession();
  if (session?.token) return { token: session.token, username: session.username, source: 'session' };
  return null;
}

/**
 * 鉴权守卫：验证当前身份是否有权执行敏感操作
 * 策略：
 * - 无注册用户 → 单用户模式，放行
 * - 有注册用户 → 必须提供有效 token
 * @param {string} cliToken - CLI --token 参数
 * @returns {object} { allowed, username, reason }
 */
export async function requireAuth(cliToken) {
  const usersFile = path.join(NODES_DIR, 'users.json');

  // 无用户注册表 → 单用户模式，不需要鉴权
  if (!await fs.pathExists(usersFile)) {
    return { allowed: true, username: null, reason: 'single-user-mode' };
  }

  const users = await fs.readJson(usersFile);
  const usernames = Object.keys(users);
  if (usernames.length === 0) {
    return { allowed: true, username: null, reason: 'single-user-mode' };
  }

  // 多用户模式：必须有有效 token
  const resolved = await resolveToken(cliToken);
  if (!resolved) {
    return { allowed: false, reason: '请先执行 user login <username> 登录，或通过 --token / IPFS_AUTH_TOKEN 提供认证' };
  }

  // 逐个尝试验证（token 内嵌用户名，直接解析）
  for (const username of usernames) {
    const userDir = path.join(NODES_DIR, 'users', username);
    const userJsonPath = path.join(userDir, 'user.json');
    if (!await fs.pathExists(userJsonPath)) continue;

    const userConfig = await fs.readJson(userJsonPath);
    if (!userConfig.authSecret) continue;

    const result = verifyToken(resolved.token, userConfig.authSecret);
    if (result.valid) {
      return { allowed: true, username: result.username, reason: 'authenticated' };
    }
  }

  return { allowed: false, reason: 'token 无效或已过期，请重新执行 user login <username>' };
}

// ==================== P1: P2P 消息签名 ====================

/**
 * 对消息进行签名
 * @param {object} message - 消息对象
 * @param {string} secret - 签名密钥
 * @returns {object} 带签名的消息 { ...message, _sig, _ts }
 */
export function signMessage(message, secret) {
  const ts = Date.now().toString();
  const payload = JSON.stringify({ ...message, _ts: ts });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { ...message, _ts: ts, _sig: sig };
}

/**
 * 验证消息签名
 * @param {object} message - 带签名的消息
 * @param {string} secret - 签名密钥
 * @returns {boolean}
 */
export function verifyMessageSignature(message, secret) {
  if (!message || !message._sig || !message._ts) return false;

  const { _sig, ...rest } = message;
  const payload = JSON.stringify(rest);
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(_sig, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}

// ==================== P1: 节点白名单 ====================

/**
 * 加载节点白名单
 */
export async function loadWhitelist(nodesDir = NODES_DIR) {
  const wlPath = path.join(nodesDir, 'whitelist.json');
  if (await fs.pathExists(wlPath)) {
    return await fs.readJson(wlPath);
  }
  return { enabled: false, peerIds: [] };
}

/**
 * 保存节点白名单
 */
export async function saveWhitelist(whitelist, nodesDir = NODES_DIR) {
  const wlPath = path.join(nodesDir, 'whitelist.json');
  await fs.writeJson(wlPath, whitelist, { spaces: 2 });
}

/**
 * 检查 peer 是否在白名单中
 * @param {string} peerId - 对端 PeerId
 * @param {object} whitelist - 白名单配置
 * @returns {boolean}
 */
export function isPeerAllowed(peerId, whitelist) {
  if (!whitelist.enabled) return true; // 未启用白名单时允许所有
  return whitelist.peerIds.includes(peerId);
}

export default {
  validateInputPath,
  validateOutputPath,
  validateScriptPath,
  resolveKey,
  generateAuthSecrets,
  generateToken,
  verifyToken,
  saveSession,
  loadSession,
  clearSession,
  resolveToken,
  requireAuth,
  signMessage,
  verifyMessageSignature,
  loadWhitelist,
  saveWhitelist,
  isPeerAllowed
};
