/**
 * IPFS 分布式存储网络 - 插件市场（PluginMarket）
 * 
 * 提供插件市场的完整生命周期管理：
 * - 市场源管理（本地目录 / 远程注册表）
 * - 插件发现（列表 / 搜索 / 详情）
 * - 插件安装 / 卸载（集成 PluginResolver 加载）
 * - 插件发布（生成清单 + 签名）
 * 
 * 数据存储：.ipfs-nodes/plugin-market.json
 * 本地市场目录：.ipfs-nodes/marketplace/
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'fs';
import { join, resolve, basename, extname } from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { PluginResolver } from './plugin-resolver.js';
import { PluginSignature } from './plugin-signature.js';

const NODES_DIR = resolve('/home/project/.ipfs-nodes');
const MARKET_FILE = join(NODES_DIR, 'plugin-market.json');
const MARKETPLACE_DIR = join(NODES_DIR, 'marketplace');

export class PluginMarket {
  constructor(options = {}) {
    this.marketFile = options.marketFile || MARKET_FILE;
    this.marketplaceDir = options.marketplaceDir || MARKETPLACE_DIR;
    this.resolver = new PluginResolver({ verbose: false });
    this.signature = new PluginSignature();
    this._data = this._load();
  }

  // ==================== 数据持久化 ====================

  _load() {
    if (existsSync(this.marketFile)) {
      try {
        return JSON.parse(readFileSync(this.marketFile, 'utf-8'));
      } catch { /* 损坏时重建 */ }
    }
    return {
      sources: [{ name: 'local', type: 'local', path: this.marketplaceDir }],
      installed: [],
      updatedAt: new Date().toISOString()
    };
  }

  _save() {
    this._data.updatedAt = new Date().toISOString();
    mkdirSync(NODES_DIR, { recursive: true });
    writeFileSync(this.marketFile, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  // ==================== 市场源管理 ====================

  /**
   * 列出所有市场源
   */
  getSources() {
    return this._data.sources;
  }

  /**
   * 添加市场源
   * @param {string} name - 源名称
   * @param {object} config - { type: 'local'|'remote', path?: string, url?: string }
   */
  addSource(name, config) {
    if (this._data.sources.some(s => s.name === name)) {
      return { success: false, error: `源 "${name}" 已存在` };
    }
    if (config.type === 'local' && !config.path) {
      return { success: false, error: '本地源需要指定 path' };
    }
    if (config.type === 'remote' && !config.url) {
      return { success: false, error: '远程源需要指定 url' };
    }
    if (config.type === 'remote' && !config.url.startsWith('https://')) {
      return { success: false, error: '安全限制：远程源仅支持 https://' };
    }
    this._data.sources.push({ name, ...config, addedAt: new Date().toISOString() });
    this._save();
    return { success: true, name };
  }

  /**
   * 移除市场源
   */
  removeSource(name) {
    const idx = this._data.sources.findIndex(s => s.name === name);
    if (idx === -1) {
      return { success: false, error: `源 "${name}" 不存在` };
    }
    if (name === 'local') {
      return { success: false, error: '不能移除默认本地源' };
    }
    this._data.sources.splice(idx, 1);
    this._save();
    return { success: true, name };
  }

  // ==================== 插件发现 ====================

  /**
   * 获取市场中所有可用插件
   * @returns {object[]} 插件清单列表
   */
  async listAvailable() {
    const plugins = [];

    for (const source of this._data.sources) {
      if (source.type === 'local') {
        const localPlugins = this._scanLocalSource(source.path || this.marketplaceDir);
        plugins.push(...localPlugins.map(p => ({ ...p, source: source.name })));
      } else if (source.type === 'remote') {
        const remotePlugins = await this._fetchRemoteSource(source.url);
        plugins.push(...remotePlugins.map(p => ({ ...p, source: source.name })));
      }
    }

    return plugins;
  }

  /**
   * 扫描本地市场目录
   */
  _scanLocalSource(dir) {
    if (!existsSync(dir)) return [];
    const results = [];

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // 目录型插件：读取 plugin.json 清单
        const manifestPath = join(dir, entry.name, 'plugin.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            results.push({
              name: manifest.name || entry.name,
              version: manifest.version || '0.0.0',
              description: manifest.description || '',
              author: manifest.author || 'unknown',
              entry: join(dir, entry.name, manifest.entry || 'index.js'),
              tags: manifest.tags || [],
              provides: manifest.provides || [],
              dependencies: manifest.dependencies || [],
              type: 'directory'
            });
          } catch { /* 清单损坏，跳过 */ }
        }
      } else if (entry.isFile() && ['.js', '.mjs'].includes(extname(entry.name))) {
        // 单文件型插件：从文件名推断
        const name = basename(entry.name, extname(entry.name));
        results.push({
          name,
          version: '0.0.0',
          description: `单文件插件: ${entry.name}`,
          author: 'unknown',
          entry: join(dir, entry.name),
          tags: [],
          provides: [],
          dependencies: [],
          type: 'file'
        });
      }
    }

    return results;
  }

  /**
   * 从远程注册表获取插件列表
   * 注册表格式：JSON 数组，每项含 { name, version, description, url, ... }
   */
  async _fetchRemoteSource(url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return [];
      const data = await response.json();
      if (!Array.isArray(data)) return [];
      return data.map(item => ({
        name: item.name || 'unknown',
        version: item.version || '0.0.0',
        description: item.description || '',
        author: item.author || 'unknown',
        entry: item.url || item.entry || '',
        tags: item.tags || [],
        provides: item.provides || [],
        dependencies: item.dependencies || [],
        type: 'remote'
      }));
    } catch {
      return [];
    }
  }

  /**
   * 搜索插件（按名称/描述/标签模糊匹配）
   */
  async search(keyword) {
    const all = await this.listAvailable();
    const kw = keyword.toLowerCase();
    return all.filter(p =>
      p.name.toLowerCase().includes(kw) ||
      p.description.toLowerCase().includes(kw) ||
      p.tags.some(t => t.toLowerCase().includes(kw))
    );
  }

  /**
   * 获取插件详情
   */
  async getPluginInfo(name) {
    const all = await this.listAvailable();
    return all.find(p => p.name === name) || null;
  }

  // ==================== 插件安装/卸载 ====================

  /**
   * 从市场安装插件
   * @param {string} name - 插件名
   * @param {object} options - { force, skipVerify, verifyPolicy }
   * @returns {object} { success, name, error?, plugin? }
   */
  async install(name, options = {}) {
    // 1. 查找插件
    const info = await this.getPluginInfo(name);
    if (!info) {
      return { success: false, error: `市场中未找到插件 "${name}"` };
    }

    // 2. 检查是否已安装
    if (this._data.installed.some(p => p.name === name)) {
      if (!options.force) {
        return { success: false, error: `插件 "${name}" 已安装，使用 --force 覆盖` };
      }
      // 覆盖安装：先卸载
      await this.uninstall(name);
    }

    // 3. 通过 Resolver 加载插件
    const resolveResult = await this.resolver.resolve(info.entry, {
      force: options.force,
      skipVerify: options.skipVerify,
      verifyPolicy: options.verifyPolicy
    });

    if (!resolveResult.success) {
      return { success: false, error: `加载失败: ${resolveResult.error}` };
    }

    // 4. 记录安装信息
    const record = {
      name,
      version: info.version,
      description: info.description,
      author: info.author,
      source: info.source,
      entry: info.entry,
      tags: info.tags,
      provides: info.provides,
      dependencies: info.dependencies,
      installedAt: new Date().toISOString(),
      signature: resolveResult.signature || null
    };
    this._data.installed.push(record);
    this._save();

    return {
      success: true,
      name,
      plugin: resolveResult.plugin,
      record,
      signature: resolveResult.signature
    };
  }

  /**
   * 卸载市场插件
   */
  async uninstall(name) {
    const idx = this._data.installed.findIndex(p => p.name === name);
    if (idx === -1) {
      return { success: false, error: `插件 "${name}" 未安装` };
    }
    this._data.installed.splice(idx, 1);
    this._save();
    return { success: true, name };
  }

  /**
   * 获取已安装的市场插件列表
   */
  getInstalled() {
    return this._data.installed;
  }

  /**
   * 检查插件是否已安装
   */
  isInstalled(name) {
    return this._data.installed.some(p => p.name === name);
  }

  // ==================== 插件发布 ====================

  /**
   * 发布插件到本地市场
   * @param {string} filePath - 插件文件路径（.js）或目录
   * @param {object} manifest - 清单信息 { name, version, description, author, tags }
   * @returns {object} { success, name?, path?, error? }
   */
  async publish(filePath, manifest = {}) {
    const absolutePath = resolve(filePath);

    // 验证文件存在
    if (!existsSync(absolutePath)) {
      return { success: false, error: `文件不存在: ${absolutePath}` };
    }

    const isDir = existsSync(join(absolutePath, 'plugin.json')) ||
      (manifest.name && existsSync(join(absolutePath, manifest.entry || 'index.js')));

    let pluginName = manifest.name;
    let targetDir;

    if (isDir || extname(absolutePath) === '') {
      // 目录型发布
      pluginName = pluginName || basename(absolutePath);
      targetDir = join(this.marketplaceDir, pluginName);
      mkdirSync(targetDir, { recursive: true });

      // 复制入口文件
      const entryFile = manifest.entry || 'index.js';
      const srcEntry = join(absolutePath, entryFile);
      if (existsSync(srcEntry)) {
        copyFileSync(srcEntry, join(targetDir, entryFile));
      }

      // 生成/更新清单
      const pluginManifest = {
        name: pluginName,
        version: manifest.version || '1.0.0',
        description: manifest.description || '',
        author: manifest.author || 'unknown',
        entry: entryFile,
        tags: manifest.tags || [],
        provides: manifest.provides || [],
        dependencies: manifest.dependencies || [],
        publishedAt: new Date().toISOString()
      };
      writeFileSync(join(targetDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf-8');
    } else {
      // 单文件发布
      const ext = extname(absolutePath);
      if (!['.js', '.mjs'].includes(ext)) {
        return { success: false, error: `不支持的文件类型: ${ext}` };
      }
      pluginName = pluginName || basename(absolutePath, ext);
      targetDir = join(this.marketplaceDir, pluginName);
      mkdirSync(targetDir, { recursive: true });

      // 复制文件
      copyFileSync(absolutePath, join(targetDir, 'index.js'));

      // 生成清单
      const pluginManifest = {
        name: pluginName,
        version: manifest.version || '1.0.0',
        description: manifest.description || '',
        author: manifest.author || 'unknown',
        entry: 'index.js',
        tags: manifest.tags || [],
        provides: manifest.provides || [],
        dependencies: manifest.dependencies || [],
        publishedAt: new Date().toISOString()
      };
      writeFileSync(join(targetDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf-8');
    }

    // 可选：签名
    const entryPath = join(targetDir, manifest.entry || 'index.js');
    if (existsSync(entryPath)) {
      await this.signature.sign(entryPath);
    }

    return { success: true, name: pluginName, path: targetDir };
  }

  /**
   * 从市场移除已发布的插件
   */
  unpublish(name) {
    const targetDir = join(this.marketplaceDir, name);
    if (!existsSync(targetDir)) {
      return { success: false, error: `市场中未找到 "${name}"` };
    }
    // 删除目录内容
    const entries = readdirSync(targetDir);
    for (const f of entries) {
      unlinkSync(join(targetDir, f));
    }
    // 注意：不删除目录本身（避免递归删除风险）
    return { success: true, name };
  }

  // ==================== 统计 ====================

  /**
   * 获取市场统计信息
   */
  getStats() {
    return {
      sourceCount: this._data.sources.length,
      installedCount: this._data.installed.length,
      sources: this._data.sources.map(s => s.name),
      updatedAt: this._data.updatedAt
    };
  }
}

export default PluginMarket;
