/**
 * IPFS 分布式存储网络 - 插件上下文（PluginContext）
 *
 * 借鉴 deepseek-harness 的 "Everything is a Plugin" 架构：
 * - 插件通过 ctx 注册服务（Service）、事件（Event）、命令（Command）
 * - 注册即效果（Registration as Effect）：每个注册返回 disposer，卸载时自动清理
 * - 无特权核心：所有能力通过插件挂载，可替换、可组合
 * - 能力接缝（Capability Seam）：Service Definition / Provider / Consumer 三角色
 */

import { PluginConfig } from './plugin-config.js';

export class PluginContext {
  constructor(options = {}) {
    this.options = options;
    this._services = new Map();       // name → { provider, instance }
    this._events = new Map();         // eventName → Set<listener>
    this._commands = new Map();       // commandName → { handler, description, options }
    this._plugins = new Map();        // pluginName → plugin instance
    this._disposers = [];             // 全局 disposer 栈
    this._middleware = [];            // 命令中间件链
    this._started = false;
    this.config = new PluginConfig().bindContext(this); // 运行时配置
  }

  // ==================== 服务注册（Capability Seam） ====================

  /**
   * 注册服务提供者（Service Provider）
   * @param {string} name - 服务名（如 'storage', 'security', 'nodeManager'）
   * @param {object} instance - 服务实例
   * @returns {function} disposer - 调用后注销服务
   */
  provide(name, instance) {
    if (this._services.has(name)) {
      throw new Error(`服务 "${name}" 已被注册，不可重复提供（如需替换请先 dispose）`);
    }
    this._services.set(name, { instance, providedAt: Date.now() });
    // 返回 disposer（注册即效果）
    const disposer = () => { this._services.delete(name); };
    this._disposers.push(disposer);
    return disposer;
  }

  /**
   * 消费服务（Service Consumer）
   * @param {string} name - 服务名
   * @returns {object} 服务实例
   */
  use(name) {
    const entry = this._services.get(name);
    if (!entry) {
      throw new Error(`服务 "${name}" 未注册。请确认对应插件已加载。`);
    }
    return entry.instance;
  }

  /**
   * 尝试消费服务（不抛异常）
   */
  tryUse(name) {
    return this._services.get(name)?.instance || null;
  }

  /**
   * 检查服务是否已注册
   */
  has(name) {
    return this._services.has(name);
  }

  // ==================== 事件系统（Typed Events） ====================

  /**
   * 订阅事件
   * @param {string} event - 事件名（如 'file/uploaded', 'node/stopped'）
   * @param {function} listener - 回调
   * @returns {function} disposer
   */
  on(event, listener) {
    if (!this._events.has(event)) {
      this._events.set(event, new Set());
    }
    this._events.get(event).add(listener);
    const disposer = () => { this._events.get(event)?.delete(listener); };
    this._disposers.push(disposer);
    return disposer;
  }

  /**
   * 发射事件
   * @param {string} event - 事件名
   * @param {*} payload - 事件数据
   */
  emit(event, payload) {
    const listeners = this._events.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(payload, this);
      } catch (e) {
        console.error(`[PluginContext] 事件 "${event}" 监听器异常: ${e.message}`);
      }
    }
  }

  /**
   * 瀑布事件（Waterfall）：监听器可修改 payload 并传递给下一个
   * 借鉴 deepseek-harness 的 waterfall 语义：必须调用 next() 才能继续
   * @param {string} event - 事件名
   * @param {*} payload - 初始数据
   * @returns {*} 最终 payload
   */
  async waterfall(event, payload) {
    const listeners = this._events.get(event);
    if (!listeners) return payload;
    let result = payload;
    for (const listener of listeners) {
      result = await listener(result, this);
    }
    return result;
  }

  // ==================== 命令注册（CLI as Plugin） ====================

  /**
   * 注册 CLI 命令
   * @param {string} name - 命令名（如 'upload', 'node start'）
   * @param {object} definition - { description, options, arguments, handler }
   * @returns {function} disposer
   */
  command(name, definition) {
    if (this._commands.has(name)) {
      throw new Error(`命令 "${name}" 已被注册`);
    }
    this._commands.set(name, { ...definition, registeredBy: this._currentPlugin });
    const disposer = () => { this._commands.delete(name); };
    this._disposers.push(disposer);
    return disposer;
  }

  /**
   * 获取所有已注册命令
   */
  getCommands() {
    return this._commands;
  }

  // ==================== 中间件（命令执行管道） ====================

  /**
   * 注册命令中间件（如鉴权、日志）
   * @param {function} middleware - async (ctx, commandName, args, next) => {}
   * @returns {function} disposer
   */
  middleware(middleware) {
    this._middleware.push(middleware);
    const disposer = () => {
      const idx = this._middleware.indexOf(middleware);
      if (idx >= 0) this._middleware.splice(idx, 1);
    };
    this._disposers.push(disposer);
    return disposer;
  }

  /**
   * 执行命令（经过中间件链）
   */
  async executeCommand(name, ...args) {
    const cmd = this._commands.get(name);
    if (!cmd) throw new Error(`未知命令: ${name}`);

    // 构建中间件链
    let index = 0;
    const chain = this._middleware;
    const dispatch = async (i) => {
      if (i < chain.length) {
        return chain[i](this, name, args, () => dispatch(i + 1));
      }
      return cmd.handler(...args);
    };
    return dispatch(0);
  }

  // ==================== 插件生命周期 ====================

  /**
   * 注册插件实例
   */
  _registerPlugin(name, plugin) {
    this._plugins.set(name, plugin);
    this._currentPlugin = name;
  }

  /**
   * 获取已加载插件列表（含健康状态）
   */
  getPlugins() {
    return [...this._plugins.entries()].map(([name, p]) => ({
      name,
      status: p._status || 'unknown',
      provides: p.meta?.provides || [],
      dependencies: p.meta?.dependencies || [],
      lastError: p.getLastError ? p.getLastError() : null,
      errorCount: p.getRecentErrors ? p.getRecentErrors().length : 0
    }));
  }

  /**
   * 执行所有插件的健康检查
   * @returns {object[]} 每个插件的健康状态
   */
  async healthCheckAll() {
    const results = [];
    for (const [name, plugin] of this._plugins.entries()) {
      let health;
      try {
        if (typeof plugin.healthCheck === 'function') {
          health = await plugin.healthCheck();
        } else {
          health = { healthy: true, message: 'ok' };
        }
      } catch (e) {
        health = { healthy: false, message: `检查异常: ${e.message}` };
        if (plugin.recordError) plugin.recordError(e);
      }
      results.push({
        name,
        status: plugin._status || 'unknown',
        ...health,
        recentErrors: plugin.getRecentErrors ? plugin.getRecentErrors().slice(-3) : [],
        errorCount: plugin.getRecentErrors ? plugin.getRecentErrors().length : 0
      });
    }
    return results;
  }

  // ==================== 运行时动态挂载/卸载 ====================

  /**
   * 运行时挂载插件（不重启 CLI）— 原子挂载
   * 如果 install 成功但 start 失败，自动 dispose 清理半初始化状态
   * @param {object} plugin - 插件实例（已 new 但未 install）
   * @returns {object} { success, name, error?, rolledBack? }
   */
  async mount(plugin) {
    const name = plugin.name;

    // 检查是否已挂载
    if (this._plugins.has(name)) {
      return { success: false, name, error: `插件 "${name}" 已挂载` };
    }

    // 检查依赖是否满足
    const deps = plugin.meta?.dependencies || [];
    const missing = deps.filter(d => !this._plugins.has(d));
    if (missing.length > 0) {
      return { success: false, name, error: `缺少依赖插件: ${missing.join(', ')}` };
    }

    let installed = false;
    try {
      await plugin.install(this);
      installed = true;
      await plugin.start();
      this._registerPlugin(name, plugin);
      this.emit('plugin/mounted', { name, provides: plugin.meta?.provides || [] });
      return { success: true, name };
    } catch (e) {
      // 原子挂载回退：install 成功但 start 失败时，清理半初始化状态
      if (installed) {
        // 清理 install 阶段可能已注册的插件引用
        this._plugins.delete(name);
        try {
          await plugin.dispose();
        } catch { /* 静默清理 */ }
      }
      return { success: false, name, error: e.message, rolledBack: installed };
    }
  }

  /**
   * 运行时卸载插件（不重启 CLI）
   * 执行依赖检查 → stop → dispose → 清理注册
   * @param {string} name - 插件名
   * @returns {object} { success, name, error? }
   */
  async unmount(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) {
      return { success: false, name, error: `插件 "${name}" 未挂载` };
    }

    // 依赖检查：不允许卸载被其他活跃插件依赖的插件
    const dependents = [];
    for (const [otherName, otherPlugin] of this._plugins) {
      if (otherName === name) continue;
      const otherDeps = otherPlugin.meta?.dependencies || [];
      if (otherDeps.includes(name)) {
        dependents.push(otherName);
      }
    }
    if (dependents.length > 0) {
      return { success: false, name, error: `被以下插件依赖，无法卸载: ${dependents.join(', ')}` };
    }

    try {
      // 1. 停止插件
      await plugin.stop();

      // 2. 执行插件局部 disposer（清理其注册的服务/事件/命令）
      await plugin.dispose();

      // 3. 从插件注册表移除
      this._plugins.delete(name);

      // 4. 清理全局 disposer 栈中属于该插件的条目
      // （PluginBase.dispose 已执行局部 disposer，全局栈中的对应条目变为空操作）

      this.emit('plugin/unmounted', { name });
      return { success: true, name };
    } catch (e) {
      return { success: false, name, error: e.message };
    }
  }

  /**
   * 运行时重载插件（卸载 → 重新挂载）— 带快照回退
   * 如果新版本挂载失败，自动从旧插件构造器恢复
   * @param {object} pluginFactory - 插件类或工厂函数（新版本）
   * @param {string} name - 插件名
   * @returns {object} { success, name, error?, rolledBack? }
   */
  async reload(pluginFactory, name) {
    // 1. 保存旧插件快照（构造器 + 元信息）
    const oldPlugin = this._plugins.get(name);
    let oldFactory = null;
    if (oldPlugin) {
      oldFactory = oldPlugin.constructor;
    }

    // 2. 卸载旧插件
    const unmountResult = await this.unmount(name);
    if (!unmountResult.success && !unmountResult.error?.includes('未挂载')) {
      return unmountResult;
    }

    // 3. 创建新实例并挂载
    const plugin = typeof pluginFactory === 'function'
      ? (pluginFactory.prototype?.install ? new pluginFactory() : pluginFactory())
      : pluginFactory;

    const mountResult = await this.mount(plugin);

    // 4. 快照回退：新版本挂载失败时，尝试从旧构造器恢复
    if (!mountResult.success && oldFactory) {
      try {
        const rollbackPlugin = new oldFactory();
        const rollbackResult = await this.mount(rollbackPlugin);
        if (rollbackResult.success) {
          return {
            success: false,
            name,
            error: `新版本加载失败: ${mountResult.error}（已回退到旧版本）`,
            rolledBack: true
          };
        }
      } catch { /* 回退也失败 */ }
    }

    return mountResult;
  }

  /**
   * 获取插件依赖图（用于可视化）
   */
  getDependencyGraph() {
    const graph = {};
    for (const [name, plugin] of this._plugins) {
      graph[name] = {
        dependsOn: plugin.meta?.dependencies || [],
        provides: plugin.meta?.provides || [],
        status: plugin._status
      };
    }
    return graph;
  }

  /**
   * 销毁上下文（卸载所有插件，执行所有 disposer）
   */
  async dispose() {
    // 逆序执行 disposer
    for (const disposer of this._disposers.reverse()) {
      try { disposer(); } catch (e) { /* 静默清理 */ }
    }
    this._disposers = [];
    this._services.clear();
    this._events.clear();
    this._commands.clear();
    this._plugins.clear();
    this._middleware = [];
  }
}

export default PluginContext;
