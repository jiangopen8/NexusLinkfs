/**
 * IPFS 分布式存储网络 - 插件注册表与 Profile 定义
 * 
 * 借鉴 deepseek-harness 的 Profile + Bundle 组合模式：
 * - 'full' Profile：加载所有插件（完整功能）
 * - 'storage-only' Profile：仅存储 + 安全（最小化）
 * - 'admin' Profile：管理命令（监控 + 升级 + 再平衡）
 */

import { PluginLoader } from '../core/plugin-loader.js';
import { NodePlugin } from './node-plugin.js';
import { SecurityPlugin } from './security-plugin.js';
import { StoragePlugin } from './storage-plugin.js';
import { UpgradePlugin } from './upgrade-plugin.js';
import { MonitorPlugin } from './monitor-plugin.js';
import { UserPlugin } from './user-plugin.js';

/**
 * 创建并配置 PluginLoader
 * @returns {PluginLoader} 已注册所有插件和 Profile 的加载器
 */
export function createLoader() {
  const loader = new PluginLoader();

  // 注册所有插件
  loader
    .register('node-manager', NodePlugin)
    .register('security', SecurityPlugin)
    .register('storage', StoragePlugin)
    .register('upgrade', UpgradePlugin)
    .register('monitor', MonitorPlugin)
    .register('multi-user', UserPlugin);

  // 定义 Profiles（插件组合）
  loader.defineProfile('full', [
    'security',
    'node-manager',
    'storage',
    'upgrade',
    'monitor',
    'multi-user'
  ]);

  loader.defineProfile('storage-only', [
    'security',
    'node-manager',
    'storage'
  ]);

  loader.defineProfile('admin', [
    'security',
    'node-manager',
    'storage',
    'upgrade',
    'monitor'
  ]);

  return loader;
}

export { PluginLoader };
