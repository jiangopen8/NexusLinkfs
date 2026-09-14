/**
 * IPFS 分布式存储网络 - 插件基类（PluginBase）
 * 
 * 借鉴 deepseek-harness 的插件设计：
 * - 每个插件声明 name、dependencies、提供的服务
 * - 生命周期：install → start → stop → dispose
 * - 注册即效果：install 中的所有注册在 dispose 时自动回滚
 */

export class PluginBase {
  /**
   * @param {string} name - 插件唯一名称
   * @param {object} meta - 插件元信息
   */
  constructor(name, meta = {}) {
    this.name = name;
    this.meta = {
      description: meta.description || '',
      version: meta.version || '1.0.0',
      dependencies: meta.dependencies || [],  // 依赖的其他插件名
      provides: meta.provides || [],           // 提供的服务名
      ...meta
    };
    this._status = 'created';  // created → installed → started → stopped → disposed
    this._disposers = [];      // 本插件的局部 disposer 栈
    this.ctx = null;           // install 后绑定的 PluginContext
  }

  /**
   * 安装插件：注册服务、事件、命令
   * 子类必须实现此方法
   * @param {PluginContext} ctx - 插件上下文
   */
  async install(ctx) {
    this.ctx = ctx;
    this._status = 'installed';
    ctx._registerPlugin(this.name, this);
  }

  /**
   * 启动插件（可选）：执行需要异步初始化的逻辑
   */
  async start() {
    this._status = 'started';
  }

  /**
   * 停止插件（可选）：暂停活动但保留状态
   */
  async stop() {
    this._status = 'stopped';
  }

  /**
   * 销毁插件：清理所有注册
   */
  async dispose() {
    for (const disposer of this._disposers.reverse()) {
      try { disposer(); } catch (e) { /* 静默 */ }
    }
    this._disposers = [];
    this._status = 'disposed';
  }

  /**
   * 追踪 disposer（插件卸载时自动执行）
   * @param {function} disposer
   */
  track(disposer) {
    this._disposers.push(disposer);
    return disposer;
  }

  /**
   * 快捷方法：注册服务并追踪
   */
  provide(name, instance) {
    return this.track(this.ctx.provide(name, instance));
  }

  /**
   * 快捷方法：订阅事件并追踪
   */
  on(event, listener) {
    return this.track(this.ctx.on(event, listener));
  }

  /**
   * 快捷方法：注册命令并追踪
   */
  command(name, definition) {
    return this.track(this.ctx.command(name, definition));
  }

  /**
   * 快捷方法：消费服务
   */
  use(name) {
    return this.ctx.use(name);
  }

  /**
   * 快捷方法：发射事件
   */
  emit(event, payload) {
    this.ctx.emit(event, payload);
  }

  // ==================== 运行时配置 ====================

  /**
   * 获取本插件的配置值
   * @param {string} key - 配置键
   * @param {*} defaultValue - 默认值
   */
  getConfig(key, defaultValue = undefined) {
    return this.ctx.config.get(this.name, key, defaultValue);
  }

  /**
   * 设置本插件的配置值（立即生效，触发 onConfig 监听器）
   * @param {string} key - 配置键
   * @param {*} value - 配置值
   */
  setConfig(key, value) {
    return this.ctx.config.set(this.name, key, value);
  }

  /**
   * 注册配置变更监听器（配置修改时自动回调）
   * @param {string} key - 配置键（'*' 监听所有）
   * @param {function} listener - (newValue, oldValue, key) => {}
   * @returns {function} disposer
   */
  onConfig(key, listener) {
    const disposer = this.ctx.config.onChange(this.name, key, listener);
    this.track(disposer);
    return disposer;
  }

  /**
   * 获取本插件的所有配置
   */
  getAllConfig() {
    return this.ctx.config.get(this.name);
  }

  // ==================== 健康检查 ====================

  /**
   * 健康检查（子类可覆盖提供自定义检查逻辑）
   * @returns {object} { healthy: boolean, message?: string, details?: object }
   */
  async healthCheck() {
    return { healthy: true, message: 'ok' };
  }

  /**
   * 记录插件错误（自动追踪最近错误）
   * @param {Error|string} error - 错误信息
   */
  recordError(error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (!this._errors) this._errors = [];
    this._errors.push({
      message: errMsg,
      timestamp: new Date().toISOString()
    });
    // 只保留最近 10 条
    if (this._errors.length > 10) {
      this._errors = this._errors.slice(-10);
    }
  }

  /**
   * 获取最近的错误列表
   */
  getRecentErrors() {
    return this._errors || [];
  }

  /**
   * 获取最近一条错误
   */
  getLastError() {
    const errors = this._errors || [];
    return errors.length > 0 ? errors[errors.length - 1] : null;
  }
}

export default PluginBase;
