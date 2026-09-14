/**
 * IPFS 分布式存储网络 - 插件状态持久化（PluginState）
 * 
 * 将运行时插件挂载/卸载状态持久化到文件，下次启动自动恢复上次的插件组合。
 * 
 * 状态文件：.ipfs-nodes/plugin-state.json
 * 格式：
 * {
 *   "version": 1,
 *   "profile": "full",
 *   "mounted": ["security", "node-manager", "storage", ...],
 *   "unmounted": ["monitor"],
 *   "externalPlugins": [{ "name": "stats", "source": "/path/to/plugin.js", "type": "local" }],
 *   "savedAt": "2026-08-28T10:00:00.000Z"
 * }
 * 
 * 恢复策略：
 * - 先按 profile 加载基础插件
 * - 再根据 unmounted 列表卸载不需要的
 * - 最后挂载 externalPlugins 中的外部插件
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';

const NODES_DIR = resolve('/home/project/.ipfs-nodes');
const STATE_FILE = join(NODES_DIR, 'plugin-state.json');

export class PluginState {
  constructor(options = {}) {
    this.stateFile = options.stateFile || STATE_FILE;
    this.autoSave = options.autoSave !== false;
    // 关键系统插件列表：这些插件不应全部被标记为 unmounted
    this.criticalPlugins = options.criticalPlugins || ['security', 'node-manager', 'storage'];
  }

  /**
   * 验证状态数据完整性（写入前调用）
   * @param {object} state - 待验证的状态对象
   * @returns {object} { valid, errors: string[] }
   */
  validate(state) {
    const errors = [];

    // 1. profile 必须是非空字符串
    if (!state.profile || typeof state.profile !== 'string') {
      errors.push('profile 必须是非空字符串');
    }

    // 2. mounted 和 unmounted 必须是字符串数组
    if (!Array.isArray(state.mounted)) {
      errors.push('mounted 必须是数组');
    } else if (!state.mounted.every(n => typeof n === 'string' && n.length > 0)) {
      errors.push('mounted 中包含无效条目（必须是非空字符串）');
    }

    if (!Array.isArray(state.unmounted)) {
      errors.push('unmounted 必须是数组');
    } else if (!state.unmounted.every(n => typeof n === 'string' && n.length > 0)) {
      errors.push('unmounted 中包含无效条目（必须是非空字符串）');
    }

    // 3. mounted 和 unmounted 不能有交集
    if (Array.isArray(state.mounted) && Array.isArray(state.unmounted)) {
      const overlap = state.mounted.filter(n => state.unmounted.includes(n));
      if (overlap.length > 0) {
        errors.push(`mounted 和 unmounted 存在冲突: ${overlap.join(', ')}`);
      }
    }

    // 4. 关键系统插件不应全部被卸载
    if (Array.isArray(state.mounted) && Array.isArray(state.unmounted)) {
      const criticalUnmounted = this.criticalPlugins.filter(
        name => state.unmounted.includes(name) && !state.mounted.includes(name)
      );
      if (criticalUnmounted.length === this.criticalPlugins.length) {
        errors.push(`所有关键系统插件均被卸载: ${criticalUnmounted.join(', ')}，拒绝写入`);
      }
    }

    // 5. externalPlugins 格式验证
    if (state.externalPlugins && !Array.isArray(state.externalPlugins)) {
      errors.push('externalPlugins 必须是数组');
    } else if (Array.isArray(state.externalPlugins)) {
      for (const ext of state.externalPlugins) {
        if (!ext.name || !ext.source) {
          errors.push(`externalPlugins 条目缺少 name 或 source: ${JSON.stringify(ext)}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 保存当前插件状态（写入前自动验证）
   * @param {object} state - { profile, mounted, unmounted, externalPlugins }
   * @returns {object} 保存的数据，验证失败时抛出错误
   */
  save(state) {
    // 写入前验证
    const validation = this.validate(state);
    if (!validation.valid) {
      throw new Error(`状态验证失败，拒绝写入: ${validation.errors.join('; ')}`);
    }

    const data = {
      version: 1,
      profile: state.profile || 'full',
      mounted: state.mounted || [],
      unmounted: state.unmounted || [],
      externalPlugins: state.externalPlugins || [],
      savedAt: new Date().toISOString()
    };
    mkdirSync(NODES_DIR, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(data, null, 2), 'utf-8');
    return data;
  }

  /**
   * 加载已保存的状态
   * @returns {object|null} 状态数据，无文件时返回 null
   */
  load() {
    if (!existsSync(this.stateFile)) return null;
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      if (data.version !== 1) return null;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 检查是否存在已保存的状态
   */
  hasSavedState() {
    return existsSync(this.stateFile);
  }

  /**
   * 清除已保存的状态
   */
  clear() {
    if (existsSync(this.stateFile)) {
      unlinkSync(this.stateFile);
    }
  }

  /**
   * 从 PluginContext 提取当前状态
   * @param {PluginContext} ctx - 插件上下文
   * @param {PluginLoader} loader - 插件加载器
   * @param {string} profile - 当前 profile
   * @returns {object} 状态对象
   */
  extractState(ctx, loader, profile) {
    const allPlugins = ctx.getPlugins();
    const mounted = allPlugins.map(p => p.name);
    
    // 获取 profile 中定义的所有插件名
    const profilePlugins = loader.getProfilePlugins(profile) || [];
    const unmounted = profilePlugins.filter(name => !mounted.includes(name));

    // 外部插件信息
    const externalPlugins = loader.getExternalPlugins();

    return { profile, mounted, unmounted, externalPlugins };
  }

  /**
   * 恢复状态到 PluginContext
   * @param {PluginContext} ctx - 已加载基础 profile 的上下文
   * @param {PluginLoader} loader - 插件加载器
   * @param {object} savedState - 已保存的状态
   * @returns {object} { restored, actions: [...] }
   */
  async restore(ctx, loader, savedState) {
    const actions = [];

    // 1. 卸载不应存在的插件
    for (const name of savedState.unmounted || []) {
      const isMounted = ctx.getPlugins().some(p => p.name === name);
      if (isMounted) {
        const result = await ctx.unmount(name);
        actions.push({ action: 'unmount', name, success: result.success });
      }
    }

    // 2. 挂载应存在但缺失的插件
    for (const name of savedState.mounted || []) {
      const isMounted = ctx.getPlugins().some(p => p.name === name);
      if (!isMounted) {
        const result = await loader.mountPlugin(ctx, name);
        actions.push({ action: 'mount', name, success: result.success });
      }
    }

    // 3. 恢复外部插件
    for (const ext of savedState.externalPlugins || []) {
      const isMounted = ctx.getPlugins().some(p => p.name === ext.name);
      if (!isMounted) {
        const result = await loader.installAndMount(ctx, ext.source, { skipVerify: true });
        actions.push({ action: 'install-external', name: ext.name, success: result.success });
      }
    }

    return { restored: true, actions };
  }
}

export default PluginState;
