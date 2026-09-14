/**
 * IPFS 分布式存储网络 - 插件加载器（PluginLoader）
 * 
 * 借鉴 deepseek-harness 的 Profile + Bundle 组合模式：
 * - Profile 定义插件组合（哪些插件、什么顺序）
 * - 依赖解析：拓扑排序确保依赖先加载
 * - 生命周期编排：install → start 按序执行
 * - 优雅降级：单个插件失败不影响其他插件
 */

import { PluginContext } from './plugin-context.js';
import { PluginResolver } from './plugin-resolver.js';
import { PluginState } from './plugin-state.js';

export class PluginLoader {
  constructor() {
    this._registry = new Map();  // name → plugin class/factory
    this._profiles = new Map();  // profileName → [pluginNames]
    this._resolver = new PluginResolver({ verbose: false });
    this._externalPlugins = new Map();  // name → { source, type }
    this._state = new PluginState();    // 状态持久化
  }

  /**
   * 注册插件类/工厂
   * @param {string} name - 插件名
   * @param {function|object} pluginOrFactory - 插件类或工厂函数
   */
  register(name, pluginOrFactory) {
    this._registry.set(name, pluginOrFactory);
    return this;
  }

  /**
   * 定义 Profile（插件组合）
   * @param {string} profileName - 配置名（如 'full', 'minimal', 'storage-only'）
   * @param {string[]} pluginNames - 插件名列表（按优先级排序）
   */
  defineProfile(profileName, pluginNames) {
    this._profiles.set(profileName, pluginNames);
    return this;
  }

  /**
   * 解析依赖顺序（拓扑排序）
   * @param {string[]} pluginNames - 要加载的插件名
   * @returns {string[]} 排序后的插件名
   */
  _resolveOrder(pluginNames) {
    const resolved = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (name) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`插件循环依赖: ${name}`);
      }
      visiting.add(name);

      const entry = this._registry.get(name);
      if (entry) {
        // 获取依赖列表
        const deps = entry.dependencies || entry.meta?.dependencies || [];
        for (const dep of deps) {
          if (pluginNames.includes(dep)) {
            visit(dep);
          }
        }
      }

      visiting.delete(name);
      visited.add(name);
      resolved.push(name);
    };

    for (const name of pluginNames) {
      visit(name);
    }
    return resolved;
  }

  /**
   * 加载并启动插件组合
   * @param {string} profileName - Profile 名称
   * @param {object} options - 传递给 PluginContext 的选项
   * @returns {PluginContext} 已启动的上下文
   */
  async load(profileName, options = {}) {
    const pluginNames = this._profiles.get(profileName);
    if (!pluginNames) {
      throw new Error(`未知 Profile: "${profileName}"。可用: ${[...this._profiles.keys()].join(', ')}`);
    }

    const ctx = new PluginContext(options);
    const ordered = this._resolveOrder(pluginNames);
    const loaded = [];
    const failed = [];

    // Phase 1: Install（按依赖顺序）
    for (const name of ordered) {
      const entry = this._registry.get(name);
      if (!entry) {
        failed.push({ name, error: '插件未注册' });
        continue;
      }

      try {
        // 支持类或工厂函数
        const plugin = typeof entry === 'function'
          ? (entry.prototype?.install ? new entry() : entry())
          : entry;

        await plugin.install(ctx);
        loaded.push(plugin);
      } catch (e) {
        failed.push({ name, error: e.message });
        console.error(`[PluginLoader] 插件 "${name}" 安装失败: ${e.message}`);
      }
    }

    // Phase 2: Start（按加载顺序）
    for (const plugin of loaded) {
      try {
        await plugin.start();
      } catch (e) {
        console.error(`[PluginLoader] 插件 "${plugin.name}" 启动失败: ${e.message}`);
      }
    }

    ctx._loadResult = { loaded: loaded.map(p => p.name), failed };
    return ctx;
  }

  /**
   * 获取加载结果摘要
   */
  getLoadSummary(ctx) {
    return ctx._loadResult || { loaded: [], failed: [] };
  }

  // ==================== 运行时动态操作 ====================

  /**
   * 运行时动态挂载单个插件到已有上下文
   * @param {PluginContext} ctx - 已启动的上下文
   * @param {string} name - 插件名（必须已在 registry 中注册）
   * @returns {object} { success, name, error? }
   */
  async mountPlugin(ctx, name) {
    const entry = this._registry.get(name);
    if (!entry) {
      return { success: false, name, error: `插件 "${name}" 未在注册表中` };
    }

    const plugin = typeof entry === 'function'
      ? (entry.prototype?.install ? new entry() : entry())
      : entry;

    return ctx.mount(plugin);
  }

  /**
   * 运行时动态卸载单个插件
   * @param {PluginContext} ctx - 已启动的上下文
   * @param {string} name - 插件名
   * @returns {object} { success, name, error? }
   */
  async unmountPlugin(ctx, name) {
    return ctx.unmount(name);
  }

  /**
   * 运行时重载单个插件
   * @param {PluginContext} ctx - 已启动的上下文
   * @param {string} name - 插件名
   * @returns {object} { success, name, error? }
   */
  async reloadPlugin(ctx, name) {
    const entry = this._registry.get(name);
    if (!entry) {
      return { success: false, name, error: `插件 "${name}" 未在注册表中` };
    }
    return ctx.reload(entry, name);
  }

  /**
   * 获取所有可挂载的插件名（注册表中但未在当前 ctx 中挂载的）
   * @param {PluginContext} ctx
   * @returns {string[]}
   */
  getAvailablePlugins(ctx) {
    const mounted = new Set(ctx.getPlugins().map(p => p.name));
    return [...this._registry.keys()].filter(name => !mounted.has(name));
  }

  /**
   * 获取注册表中所有插件的元信息
   */
  getRegistryInfo() {
    return [...this._registry.entries()].map(([name, entry]) => {
      // 尝试获取元信息（不实例化）
      const meta = entry.meta || entry.prototype?.meta || {};
      const external = this._externalPlugins.get(name);
      return {
        name,
        description: meta.description || '',
        dependencies: meta.dependencies || [],
        provides: meta.provides || [],
        external: external ? { source: external.source, type: external.type } : null
      };
    });
  }

  // ==================== 第三方插件加载 ====================

  /**
   * 从本地路径或远程 URL 安装第三方插件
   * @param {string} source - 本地文件路径或 https:// URL
   * @param {object} options - { force, skipVerify, verifyPolicy }
   * @returns {object} { success, name?, error?, signature? }
   */
  async installExternal(source, options = {}) {
    // 1. 解析插件（传递签名验证选项）
    const resolveOptions = { ...options };
    if (options.verifyPolicy) {
      this._resolver.verifyPolicy = options.verifyPolicy;
    }
    const resolved = await this._resolver.resolve(source, resolveOptions);
    if (!resolved.success) {
      return { success: false, error: resolved.error };
    }

    // 2. 实例化以获取插件名
    const pluginOrClass = resolved.plugin;
    let plugin;
    try {
      plugin = typeof pluginOrClass === 'function'
        ? (pluginOrClass.prototype?.install ? new pluginOrClass() : pluginOrClass())
        : pluginOrClass;
    } catch (e) {
      return { success: false, error: `插件实例化失败: ${e.message}` };
    }

    // 3. 校验插件有效性
    if (!plugin || typeof plugin.install !== 'function') {
      return { success: false, error: '无效的插件：缺少 install 方法' };
    }

    const name = plugin.name;
    if (!name) {
      return { success: false, error: '插件缺少 name 属性' };
    }

    // 4. 注册到 registry
    this._registry.set(name, pluginOrClass);
    this._externalPlugins.set(name, { source, type: resolved.type });

    const result = { success: true, name, source, type: resolved.type };
    // 附带签名信息（如有）
    if (resolved.signature) {
      result.signature = resolved.signature;
    }
    return result;
  }

  /**
   * 安装外部插件并挂载到已有上下文
   * @param {PluginContext} ctx - 已启动的上下文
   * @param {string} source - 本地路径或 URL
   * @param {object} options - { force }
   * @returns {object} { success, name?, error? }
   */
  async installAndMount(ctx, source, options = {}) {
    const installResult = await this.installExternal(source, options);
    if (!installResult.success) return installResult;

    // 挂载到上下文
    const mountResult = await this.mountPlugin(ctx, installResult.name);
    if (!mountResult.success) {
      return { ...installResult, mounted: false, mountError: mountResult.error };
    }

    return { ...installResult, mounted: true };
  }

  /**
   * 获取外部插件列表
   */
  getExternalPlugins() {
    return [...this._externalPlugins.entries()].map(([name, info]) => ({
      name,
      source: info.source,
      type: info.type
    }));
  }

  /**
   * 获取 Profile 中定义的插件名列表
   */
  getProfilePlugins(profileName) {
    return this._profiles.get(profileName) || [];
  }

  // ==================== 状态持久化 ====================

  /**
   * 保存当前插件状态到文件（写入前自动验证）
   * @param {PluginContext} ctx - 当前上下文
   * @param {string} profile - 当前 profile
   * @returns {object} { success, data?, error? }
   */
  saveState(ctx, profile) {
    const state = this._state.extractState(ctx, this, profile);
    try {
      const data = this._state.save(state);
      return { success: true, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 检查是否有已保存的状态
   */
  hasSavedState() {
    return this._state.hasSavedState();
  }

  /**
   * 加载已保存的状态
   */
  loadSavedState() {
    return this._state.load();
  }

  /**
   * 恢复已保存的状态到上下文
   * @param {PluginContext} ctx - 已加载基础 profile 的上下文
   * @param {object} savedState - 已保存的状态（可选，不传则自动加载）
   * @returns {object} { restored, actions }
   */
  async restoreState(ctx, savedState) {
    const state = savedState || this._state.load();
    if (!state) {
      return { restored: false, reason: '无已保存的状态' };
    }
    return this._state.restore(ctx, this, state);
  }

  /**
   * 清除已保存的状态
   */
  clearState() {
    this._state.clear();
  }
}

export default PluginLoader;
