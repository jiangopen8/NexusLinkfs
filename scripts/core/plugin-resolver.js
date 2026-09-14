/**
 * IPFS 分布式存储网络 - 插件解析器（PluginResolver）
 * 
 * 支持从本地路径或远程 URL 动态加载第三方插件包。
 * 
 * 插件包格式约定：
 * - 单个 .js 文件，默认导出一个继承 PluginBase 的类或工厂函数
 * - 或包含 plugin.json 清单 + 入口文件的目录
 * 
 * 安全机制：
 * - 本地路径：校验文件存在 + 扩展名白名单
 * - 远程 URL：仅允许 https://，下载到本地缓存后加载
 * - 加载前校验：导出必须包含 install 方法或为有效工厂函数
 * 
 * 缓存策略：
 * - 远程插件缓存到 .ipfs-nodes/plugin-cache/<hash>.js
 * - 支持 --force 强制重新下载
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, resolve, extname } from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { PluginSignature } from './plugin-signature.js';

const NODES_DIR = resolve('/home/project/.ipfs-nodes');
const CACHE_DIR = join(NODES_DIR, 'plugin-cache');

// 允许的文件扩展名
const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs']);

export class PluginResolver {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || CACHE_DIR;
    this.verbose = options.verbose !== false;
    this.signature = new PluginSignature();
    // 签名验证策略：'strict'（远程必须验签）| 'warn'（验签失败仅警告）| 'skip'（跳过）
    this.verifyPolicy = options.verifyPolicy || 'strict';
  }

  /**
   * 解析插件来源，返回插件类/工厂
   * @param {string} source - 本地路径或远程 URL
   * @param {object} options - { force: 强制重新下载, skipVerify: 跳过签名验证 }
   * @returns {object} { success, plugin, name?, error?, signature? }
   */
  async resolve(source, options = {}) {
    // 判断来源类型
    if (this._isRemoteUrl(source)) {
      return this._resolveRemote(source, options);
    } else {
      return this._resolveLocal(source, options);
    }
  }

  /**
   * 判断是否为远程 URL
   */
  _isRemoteUrl(source) {
    return source.startsWith('https://') || source.startsWith('http://');
  }

  /**
   * 从本地路径加载插件
   */
  async _resolveLocal(filePath, options = {}) {
    // 1. 路径解析
    const absolutePath = resolve(filePath);

    // 2. 安全校验：扩展名白名单
    const ext = extname(absolutePath);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { success: false, error: `不支持的文件类型: ${ext}（仅支持 .js/.mjs）` };
    }

    // 3. 文件存在性检查
    if (!existsSync(absolutePath)) {
      return { success: false, error: `文件不存在: ${absolutePath}` };
    }

    // 4. 动态导入
    try {
      const module = await import(pathToFileURL(absolutePath).href);
      const plugin = this._extractPlugin(module);
      if (!plugin) {
        return { success: false, error: '模块未导出有效的插件（需默认导出含 install 方法的类或工厂函数）' };
      }
      return { success: true, plugin, source: absolutePath, type: 'local' };
    } catch (e) {
      return { success: false, error: `加载失败: ${e.message}` };
    }
  }

  /**
   * 从远程 URL 加载插件（含 HMAC 签名验证）
   */
  async _resolveRemote(url, options = {}) {
    // 1. 安全校验：仅允许 https
    if (!url.startsWith('https://')) {
      return { success: false, error: '安全限制：仅允许 https:// 远程插件源' };
    }

    // 2. 计算缓存路径
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const cachePath = join(this.cacheDir, `${hash}.js`);

    // 3. 检查缓存（非 force 模式）
    if (!options.force && existsSync(cachePath)) {
      if (this.verbose) {
        console.log(`[Resolver] 使用缓存: ${cachePath}`);
      }
      // 缓存命中时仍需验签（防缓存投毒）
      if (!options.skipVerify && this.verifyPolicy !== 'skip') {
        const sigResult = await this._verifyCachedSignature(cachePath, url);
        if (!sigResult.valid) {
          if (this.verifyPolicy === 'strict') {
            return { success: false, error: `签名验证失败: ${sigResult.reason}` };
          }
          if (this.verbose) console.log(`[Resolver] ⚠️ 签名警告: ${sigResult.reason}`);
        }
      }
      return this._resolveLocal(cachePath, options);
    }

    // 4. 下载
    try {
      if (this.verbose) {
        console.log(`[Resolver] 下载中: ${url}`);
      }
      const response = await fetch(url);
      if (!response.ok) {
        return { success: false, error: `下载失败: HTTP ${response.status}` };
      }
      const content = await response.text();

      // 5. 基本内容校验
      if (!content || content.length < 10) {
        return { success: false, error: '下载内容无效（过短）' };
      }

      // 6. 签名验证（下载后立即验签）
      let signatureInfo = null;
      if (!options.skipVerify && this.verifyPolicy !== 'skip') {
        // 尝试从 URL + '.sig' 获取签名
        const sigUrl = url + '.sig';
        try {
          const sigResponse = await fetch(sigUrl);
          if (sigResponse.ok) {
            const sigContent = await sigResponse.text();
            signatureInfo = this.signature.verifyContent(content, sigContent);
            if (!signatureInfo.valid) {
              if (this.verifyPolicy === 'strict') {
                return { success: false, error: `签名验证失败: ${signatureInfo.reason}` };
              }
              if (this.verbose) console.log(`[Resolver] ⚠️ 签名警告: ${signatureInfo.reason}`);
            } else if (this.verbose) {
              console.log(`[Resolver] ✅ 签名验证通过 (key: ${signatureInfo.keyId || 'default'})`);
            }
          } else {
            // 无 .sig 文件
            if (this.verifyPolicy === 'strict') {
              return { success: false, error: '远程插件缺少签名文件（.sig），严格模式下拒绝加载。使用 --skip-verify 跳过或 --policy warn 降级' };
            }
            if (this.verbose) console.log('[Resolver] ⚠️ 远程插件无签名文件，已跳过验证');
          }
        } catch (sigErr) {
          if (this.verifyPolicy === 'strict') {
            return { success: false, error: `签名获取失败: ${sigErr.message}` };
          }
          if (this.verbose) console.log(`[Resolver] ⚠️ 签名获取异常: ${sigErr.message}`);
        }
      }

      // 7. 写入缓存
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(cachePath, content, 'utf-8');
      // 同时缓存签名（如有）
      if (signatureInfo?.valid) {
        writeFileSync(cachePath + '.sig', JSON.stringify(signatureInfo), 'utf-8');
      }
      if (this.verbose) {
        console.log(`[Resolver] 已缓存到: ${cachePath}`);
      }

      // 8. 从缓存加载
      const result = await this._resolveLocal(cachePath, options);
      if (result.success && signatureInfo) {
        result.signature = signatureInfo;
      }
      return result;
    } catch (e) {
      return { success: false, error: `远程加载失败: ${e.message}` };
    }
  }

  /**
   * 验证缓存文件的签名
   */
  async _verifyCachedSignature(cachePath, url) {
    const sigPath = cachePath + '.sig';
    if (!existsSync(sigPath)) {
      return { valid: false, reason: '缓存无签名记录' };
    }
    try {
      const content = readFileSync(cachePath, 'utf-8');
      const sigData = JSON.parse(readFileSync(sigPath, 'utf-8'));
      // 重新计算 HMAC 并比对
      const expectedHmac = this.signature.signContent(content, sigData.keyId);
      if (expectedHmac.success && expectedHmac.hmac === sigData.hmac) {
        return { valid: true, keyId: sigData.keyId };
      }
      return { valid: false, reason: '缓存内容与签名不匹配（可能被篡改）' };
    } catch (e) {
      return { valid: false, reason: `签名验证异常: ${e.message}` };
    }
  }

  /**
   * 从模块导出中提取插件
   * 支持：默认导出类 / 默认导出工厂函数 / 命名导出 Plugin
   */
  _extractPlugin(module) {
    // 优先：默认导出
    if (module.default) {
      const def = module.default;
      if (typeof def === 'function') {
        // 类（有 prototype.install）或工厂函数
        return def;
      }
      if (typeof def === 'object' && typeof def.install === 'function') {
        return def;
      }
    }

    // 次选：命名导出 Plugin
    if (module.Plugin && typeof module.Plugin === 'function') {
      return module.Plugin;
    }

    // 兜底：遍历所有导出找含 install 的
    for (const [key, value] of Object.entries(module)) {
      if (typeof value === 'function' && value.prototype?.install) {
        return value;
      }
    }

    return null;
  }

  /**
   * 获取插件元信息（不实例化）
   */
  getPluginInfo(pluginOrClass) {
    if (typeof pluginOrClass === 'function') {
      // 类：检查 prototype
      const proto = pluginOrClass.prototype;
      if (proto?.constructor?.name) {
        return {
          type: 'class',
          className: pluginOrClass.name || 'Anonymous',
          hasInstall: typeof proto.install === 'function'
        };
      }
      return { type: 'factory', name: pluginOrClass.name || 'anonymous' };
    }
    if (typeof pluginOrClass === 'object') {
      return {
        type: 'instance',
        name: pluginOrClass.name || 'unknown',
        hasInstall: typeof pluginOrClass.install === 'function'
      };
    }
    return { type: 'unknown' };
  }

  /**
   * 列出缓存中的远程插件
   */
  listCached() {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir)
      .filter(f => f.endsWith('.js'))
      .map(f => ({
        file: f,
        path: join(this.cacheDir, f),
        size: readFileSync(join(this.cacheDir, f)).length
      }));
  }

  /**
   * 清除缓存
   */
  clearCache() {
    if (!existsSync(this.cacheDir)) return 0;
    const files = readdirSync(this.cacheDir).filter(f => f.endsWith('.js'));
    for (const f of files) {
      unlinkSync(join(this.cacheDir, f));
    }
    return files.length;
  }
}

export default PluginResolver;
