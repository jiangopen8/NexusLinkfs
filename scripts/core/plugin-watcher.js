/**
 * IPFS 分布式存储网络 - 插件热更新监听器（PluginWatcher）
 * 
 * 监听 plugins/ 目录下的文件变更，自动触发对应插件的 reload。
 * 特性：
 * - 防抖处理（300ms 内多次变更只触发一次 reload）
 * - 文件→插件名映射（基于文件名约定：xxx-plugin.js → xxx）
 * - 变更日志输出
 * - 优雅停止
 */

import { watch } from 'fs';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// plugins/ 目录路径
const PLUGINS_DIR = join(__dirname, '..', 'plugins');

export class PluginWatcher {
  /**
   * @param {PluginContext} ctx - 插件上下文
   * @param {PluginLoader} loader - 插件加载器
   * @param {object} options - 配置
   * @param {number} options.debounceMs - 防抖延迟（默认 300ms）
   * @param {boolean} options.verbose - 是否输出详细日志
   */
  constructor(ctx, loader, options = {}) {
    this.ctx = ctx;
    this.loader = loader;
    this.debounceMs = options.debounceMs || 300;
    this.verbose = options.verbose !== false;
    this._watcher = null;
    this._timers = new Map();  // pluginName → debounce timer
    this._running = false;
    this._changeCount = 0;
    this._reloadCount = 0;
  }

  /**
   * 从文件名推断插件名
   * 约定：xxx-plugin.js → xxx，index.js → 忽略
   */
  _fileToPluginName(filename) {
    if (!filename || !filename.endsWith('.js')) return null;
    if (filename === 'index.js') return null;
    // xxx-plugin.js → xxx
    const match = filename.match(/^(.+)-plugin\.js$/);
    if (match) return match[1];
    // 兜底：去掉 .js 后缀
    return filename.replace(/\.js$/, '');
  }

  /**
   * 开始监听
   */
  start() {
    if (this._running) return;
    this._running = true;

    this._watcher = watch(PLUGINS_DIR, { recursive: false }, (eventType, filename) => {
      if (!filename) return;

      const pluginName = this._fileToPluginName(filename);
      if (!pluginName) return;

      this._changeCount++;
      if (this.verbose) {
        console.log(`[Watcher] 检测到变更: ${filename} → 插件 "${pluginName}"`);
      }

      // 防抖：清除之前的 timer，重新计时
      if (this._timers.has(pluginName)) {
        clearTimeout(this._timers.get(pluginName));
      }

      this._timers.set(pluginName, setTimeout(async () => {
        this._timers.delete(pluginName);
        await this._reloadPlugin(pluginName, filename);
      }, this.debounceMs));
    });

    if (this.verbose) {
      console.log(`[Watcher] 开始监听 ${PLUGINS_DIR}`);
      console.log(`[Watcher] 防抖延迟: ${this.debounceMs}ms`);
    }
  }

  /**
   * 执行插件重载
   */
  async _reloadPlugin(pluginName, filename) {
    // 检查插件是否已挂载（未挂载的不自动重载）
    const mounted = this.ctx.getPlugins().some(p => p.name === pluginName);
    if (!mounted) {
      if (this.verbose) {
        console.log(`[Watcher] 插件 "${pluginName}" 未挂载，跳过自动重载`);
      }
      return;
    }

    try {
      const result = await this.loader.reloadPlugin(this.ctx, pluginName);
      this._reloadCount++;

      if (result.success) {
        console.log(`[Watcher] ✅ 插件 "${pluginName}" 热重载成功 (${filename})`);
        this.ctx.emit('plugin/hot-reloaded', { name: pluginName, file: filename });
      } else {
        console.error(`[Watcher] ❌ 插件 "${pluginName}" 热重载失败: ${result.error}`);
      }
    } catch (e) {
      console.error(`[Watcher] ❌ 插件 "${pluginName}" 热重载异常: ${e.message}`);
    }
  }

  /**
   * 停止监听
   */
  stop() {
    if (!this._running) return;
    this._running = false;

    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }

    // 清理所有 pending timers
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();

    if (this.verbose) {
      console.log(`[Watcher] 已停止。共检测 ${this._changeCount} 次变更，执行 ${this._reloadCount} 次重载`);
    }
  }

  /**
   * 获取监听状态
   */
  getStatus() {
    return {
      running: this._running,
      watchDir: PLUGINS_DIR,
      debounceMs: this.debounceMs,
      changeCount: this._changeCount,
      reloadCount: this._reloadCount,
      pendingReloads: this._timers.size
    };
  }
}

export default PluginWatcher;
