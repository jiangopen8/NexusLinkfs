/**
 * IPFS 分布式存储网络 - 插件运行时配置（PluginConfig）
 * 
 * 支持插件运行时修改配置项，无需卸载重载即可生效。
 * 
 * 核心能力：
 * - 按插件名命名空间的配置存储
 * - 响应式更新：配置变更时发射 'config/changed' 事件
 * - 持久化：配置保存到 .ipfs-nodes/plugin-config.json
 * - 插件可注册配置变更监听器（onConfig）
 * 
 * 配置格式：
 * {
 *   "storage": { "replicas": 3, "chunkSize": 262144 },
 *   "monitor": { "refreshInterval": 5000 },
 *   ...
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const NODES_DIR = resolve('/home/project/.ipfs-nodes');
const CONFIG_FILE = join(NODES_DIR, 'plugin-config.json');

export class PluginConfig {
  constructor(options = {}) {
    this.configFile = options.configFile || CONFIG_FILE;
    this._data = null;       // 内存中的配置数据
    this._listeners = new Map(); // pluginName → Map<key, Set<listener>>
    this._ctx = null;        // 绑定的 PluginContext（用于发射事件）
  }

  /**
   * 绑定 PluginContext（用于发射配置变更事件）
   */
  bindContext(ctx) {
    this._ctx = ctx;
    return this;
  }

  /**
   * 加载配置（懒加载）
   */
  _load() {
    if (this._data) return this._data;
    if (existsSync(this.configFile)) {
      try {
        this._data = JSON.parse(readFileSync(this.configFile, 'utf-8'));
      } catch {
        this._data = {};
      }
    } else {
      this._data = {};
    }
    return this._data;
  }

  /**
   * 持久化配置到文件
   */
  _persist() {
    mkdirSync(NODES_DIR, { recursive: true });
    writeFileSync(this.configFile, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  /**
   * 获取插件配置
   * @param {string} pluginName - 插件名
   * @param {string} key - 配置键（可选，不传返回整个插件配置）
   * @param {*} defaultValue - 默认值
   */
  get(pluginName, key, defaultValue = undefined) {
    const data = this._load();
    const pluginConfig = data[pluginName] || {};
    if (key === undefined) return pluginConfig;
    return pluginConfig[key] !== undefined ? pluginConfig[key] : defaultValue;
  }

  /**
   * 设置插件配置（触发响应式更新）
   * @param {string} pluginName - 插件名
   * @param {string} key - 配置键
   * @param {*} value - 配置值
   * @param {object} options - { persist: 是否持久化（默认 true）, silent: 是否静默（默认 false） }
   */
  set(pluginName, key, value, options = {}) {
    const data = this._load();
    if (!data[pluginName]) {
      data[pluginName] = {};
    }

    const oldValue = data[pluginName][key];
    data[pluginName][key] = value;

    // 持久化
    if (options.persist !== false) {
      this._persist();
    }

    // 触发响应式更新
    if (!options.silent) {
      this._notifyChange(pluginName, key, value, oldValue);
    }

    return { success: true, pluginName, key, value, oldValue };
  }

  /**
   * 批量设置插件配置
   * @param {string} pluginName - 插件名
   * @param {object} configs - { key: value, ... }
   */
  setMany(pluginName, configs, options = {}) {
    const results = [];
    for (const [key, value] of Object.entries(configs)) {
      results.push(this.set(pluginName, key, value, { ...options, persist: false }));
    }
    // 批量操作只持久化一次
    if (options.persist !== false) {
      this._persist();
    }
    return results;
  }

  /**
   * 删除插件配置项
   */
  delete(pluginName, key) {
    const data = this._load();
    if (data[pluginName] && key in data[pluginName]) {
      const oldValue = data[pluginName][key];
      delete data[pluginName][key];
      this._persist();
      this._notifyChange(pluginName, key, undefined, oldValue);
      return true;
    }
    return false;
  }

  /**
   * 获取插件所有配置键
   */
  keys(pluginName) {
    const data = this._load();
    return Object.keys(data[pluginName] || {});
  }

  /**
   * 获取所有插件的配置概览
   */
  getAll() {
    return this._load();
  }

  /**
   * 注册配置变更监听器
   * @param {string} pluginName - 插件名
   * @param {string} key - 配置键（'*' 表示监听所有键）
   * @param {function} listener - (newValue, oldValue, key) => {}
   * @returns {function} disposer
   */
  onChange(pluginName, key, listener) {
    if (!this._listeners.has(pluginName)) {
      this._listeners.set(pluginName, new Map());
    }
    const pluginListeners = this._listeners.get(pluginName);
    if (!pluginListeners.has(key)) {
      pluginListeners.set(key, new Set());
    }
    pluginListeners.get(key).add(listener);

    // 返回 disposer
    return () => {
      pluginListeners.get(key)?.delete(listener);
    };
  }

  /**
   * 触发配置变更通知
   */
  _notifyChange(pluginName, key, newValue, oldValue) {
    // 1. 通知精确匹配的监听器
    const pluginListeners = this._listeners.get(pluginName);
    if (pluginListeners) {
      const exactListeners = pluginListeners.get(key);
      if (exactListeners) {
        for (const listener of exactListeners) {
          try { listener(newValue, oldValue, key); } catch (e) { /* 静默 */ }
        }
      }
      // 2. 通知通配符监听器
      const wildcardListeners = pluginListeners.get('*');
      if (wildcardListeners) {
        for (const listener of wildcardListeners) {
          try { listener(newValue, oldValue, key); } catch (e) { /* 静默 */ }
        }
      }
    }

    // 3. 发射全局事件（如果绑定了 ctx）
    if (this._ctx) {
      this._ctx.emit('config/changed', {
        plugin: pluginName,
        key,
        newValue,
        oldValue,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 清除插件的所有配置
   */
  clearPlugin(pluginName) {
    const data = this._load();
    if (data[pluginName]) {
      delete data[pluginName];
      this._persist();
      return true;
    }
    return false;
  }

  /**
   * 清除所有配置
   */
  clearAll() {
    this._data = {};
    this._persist();
  }
}

export default PluginConfig;
