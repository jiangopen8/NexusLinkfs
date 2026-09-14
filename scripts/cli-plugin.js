#!/usr/bin/env node
/**
 * IPFS 分布式存储网络 - 插件驱动 CLI 入口
 * 
 * "Everything is a Plugin" 架构：
 * - 所有命令由插件注册，CLI 仅负责解析参数并分发
 * - 通过 --profile 选择插件组合（默认 full）
 * - 支持运行时动态加载/卸载插件（plugin mount/unmount/reload）
 * 
 * 用法：
 *   node scripts/cli-plugin.js <command> [args...] [--options]
 *   node scripts/cli-plugin.js --profile storage-only upload file.txt
 *   node scripts/cli-plugin.js plugin mount monitor
 *   node scripts/cli-plugin.js plugin unmount monitor
 *   node scripts/cli-plugin.js plugin reload storage
 */

import { createLoader } from './plugins/index.js';
import { PluginWatcher } from './core/plugin-watcher.js';
import { PluginState } from './core/plugin-state.js';
import { PluginMarket } from './core/plugin-market.js';
import { PluginPermission } from './core/plugin-permission.js';

const args = process.argv.slice(2);

// 解析 --profile 参数
let profile = 'full';
const profileIdx = args.indexOf('--profile');
if (profileIdx >= 0 && args[profileIdx + 1]) {
  profile = args[profileIdx + 1];
  args.splice(profileIdx, 2);
}

// 解析 --restore（恢复上次插件状态）
const shouldRestore = args.includes('--restore');
if (shouldRestore) {
  args.splice(args.indexOf('--restore'), 1);
}

// 解析 --help
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  printHelp();
  process.exit(0);
}

// 解析 --list-plugins
if (args.includes('--list-plugins')) {
  await listPlugins(profile);
  process.exit(0);
}

// 一键激活命令（在插件加载前处理）
if (args[0] === 'activate') {
  await handleActivate(profile, args.slice(1));
  process.exit(0);
}

// 提取命令名和参数
const commandName = args[0];
const commandArgs = args.slice(1);

try {
  // 加载插件组合
  const loader = createLoader();
  const ctx = await loader.load(profile, { cli: true });

  // 恢复上次状态（--restore 或自动检测）
  if (shouldRestore && loader.hasSavedState()) {
    const restoreResult = await loader.restoreState(ctx);
    if (restoreResult.restored) {
      const actions = restoreResult.actions.filter(a => !a.success === false);
      if (actions.length > 0) {
        console.log(`[State] 已恢复 ${actions.length} 项插件状态变更`);
      }
    }
  }

  // 处理插件市场命令
  if (commandName === 'market') {
    await handleMarketCommand(ctx, loader, commandArgs);
    await ctx.dispose();
    process.exit(0);
  }

  // 处理插件管理命令
  if (commandName === 'plugin') {
    await handlePluginCommand(ctx, loader, commandArgs);
    // 插件管理操作后自动保存状态
    loader.saveState(ctx, profile);
    await ctx.dispose();
    process.exit(0);
  }

  // 查找并执行命令
  const commands = ctx.getCommands();
  if (!commands.has(commandName)) {
    console.error(`未知命令: ${commandName}`);
    console.error(`可用命令: ${[...commands.keys()].join(', ')}`);
    process.exit(1);
  }

  await ctx.executeCommand(commandName, ...commandArgs);

  // 清理
  await ctx.dispose();
} catch (err) {
  console.error(`执行失败: ${err.message}`);
  process.exit(1);
}

// ==================== 插件管理命令 ====================

async function handlePluginCommand(ctx, loader, args) {
  const subCommand = args[0];
  const target = args[1];
  const permission = new PluginPermission();

  // 系统插件列表（注册表中的内置插件）
  const systemPlugins = loader.getRegistryInfo().map(p => p.name);

  // 权限守卫：系统插件的 mount/unmount/reload/upgrade 仅管理员可操作
  // --all 包含系统插件，也需管理员权限
  if (['mount', 'unmount', 'reload', 'load', 'unload', 'upgrade'].includes(subCommand) && target) {
    const isAll = target === '--all';
    const isSystem = isAll || permission.isSystemPlugin(target, systemPlugins);
    const guard = permission.guardPluginCommand(subCommand, target, isSystem);
    if (!guard.allowed) {
      console.error(`⛔ ${guard.reason}`);
      console.error('提示: 普通用户仅可通过 market install 申请扩展插件');
      process.exit(1);
    }
  }

  switch (subCommand) {
    case 'list': {
      const plugins = ctx.getPlugins();
      console.log(`\n已挂载插件 (${plugins.length}):\n`);
      for (const p of plugins) {
        const deps = p.dependencies.length > 0 ? ` ← 依赖 [${p.dependencies.join(', ')}]` : '';
        const provides = p.provides.length > 0 ? ` → 提供 [${p.provides.join(', ')}]` : '';
        // 健康状态图标
        const healthIcon = p.errorCount > 0 ? '⚠️' : '✅';
        const errorInfo = p.errorCount > 0 ? ` (${p.errorCount} 错误)` : '';
        console.log(`  ${healthIcon} ${p.name.padEnd(14)} [${p.status}]${provides}${deps}${errorInfo}`);
      }

      const available = loader.getAvailablePlugins(ctx);
      if (available.length > 0) {
        console.log(`\n可挂载插件 (${available.length}):`);
        for (const name of available) {
          console.log(`  ${name}`);
        }
      }

      console.log(`\n依赖图:`);
      const graph = ctx.getDependencyGraph();
      for (const [name, info] of Object.entries(graph)) {
        const arrow = info.dependsOn.length > 0 ? ` → [${info.dependsOn.join(', ')}]` : ' (无依赖)';
        console.log(`  ${name}${arrow}`);
      }
      break;
    }

    case 'mount':
    case 'load': {
      if (!target) {
        console.error('用法: plugin mount <plugin-name>');
        process.exit(1);
      }
      const result = await loader.mountPlugin(ctx, target);
      if (result.success) {
        console.log(`✅ 插件 "${result.name}" 已挂载`);
        // 显示新增的命令
        const plugin = ctx.getPlugins().find(p => p.name === result.name);
        if (plugin) {
          console.log(`   状态: ${plugin.status}`);
          console.log(`   提供服务: ${plugin.provides.join(', ') || '无'}`);
        }
      } else {
        console.error(`❌ 挂载失败: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'unmount':
    case 'unload': {
      if (!target) {
        console.error('用法: plugin unmount <plugin-name>');
        process.exit(1);
      }
      const result = await loader.unmountPlugin(ctx, target);
      if (result.success) {
        console.log(`✅ 插件 "${result.name}" 已卸载`);
      } else {
        console.error(`❌ 卸载失败: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'reload': {
      if (!target) {
        console.error('用法: plugin reload <plugin-name>');
        process.exit(1);
      }
      const result = await loader.reloadPlugin(ctx, target);
      if (result.success) {
        console.log(`✅ 插件 "${result.name}" 已重载`);
      } else {
        console.error(`❌ 重载失败: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'upgrade': {
      // 批量升级模式
      const isUpgradeAll = target === '--all' || args.includes('--all');
      if (isUpgradeAll) {
        await handleUpgradeAll(ctx, loader);
        break;
      }

      if (!target) {
        console.error('用法: plugin upgrade <plugin-name> --from <path>');
        console.error('       plugin upgrade --all  (批量升级所有已挂载插件)');
        process.exit(1);
      }
      // 解析 --from 参数
      const fromIdx = args.indexOf('--from');
      if (fromIdx < 0 || !args[fromIdx + 1]) {
        console.error('用法: plugin upgrade <plugin-name> --from <path>');
        console.error('  --from <path>  新版本插件文件路径（本地 .js 文件或 https:// URL）');
        process.exit(1);
      }
      const upgradeSource = args[fromIdx + 1];

      // 1. 获取当前已挂载的旧插件信息
      const currentPlugins = ctx.getPlugins();
      const oldPluginInfo = currentPlugins.find(p => p.name === target);
      if (!oldPluginInfo) {
        console.error(`❌ 插件 "${target}" 未挂载，无法升级。请先确认插件已加载。`);
        process.exit(1);
      }
      const oldVersion = oldPluginInfo.status === 'started' ? '1.0.0' : '1.0.0';
      // 尝试从注册表获取旧版本信息
      const registryInfo = loader.getRegistryInfo();
      const oldRegEntry = registryInfo.find(p => p.name === target);

      console.log(`\n🔄 升级插件: ${target}`);
      console.log(`   来源: ${upgradeSource}`);

      // 2. 加载新版本插件
      let newPluginClass;
      try {
        const { resolve } = await import('path');
        const { pathToFileURL } = await import('url');
        const resolvedPath = resolve(upgradeSource);
        const module = await import(pathToFileURL(resolvedPath).href);
        newPluginClass = module.default || module;
      } catch (e) {
        console.error(`❌ 加载新版本失败: ${e.message}`);
        process.exit(1);
      }

      // 3. 实例化新版本获取版本信息
      let newPluginInstance;
      try {
        newPluginInstance = typeof newPluginClass === 'function'
          ? (newPluginClass.prototype?.install ? new newPluginClass() : newPluginClass())
          : newPluginClass;
      } catch (e) {
        console.error(`❌ 新版本实例化失败: ${e.message}`);
        process.exit(1);
      }

      const newVersion = newPluginInstance.meta?.version || '1.0.0';
      // 从注册表获取旧版本（getRegistryInfo 返回的 meta 中可能有 version）
      const oldMeta = oldRegEntry ? (oldRegEntry.meta || {}) : {};
      const oldVersionFromMeta = oldMeta.version || '1.0.0';

      // 4. 版本对比
      console.log(`\n📋 版本对比:`);
      console.log(`   当前版本: ${oldVersionFromMeta}`);
      console.log(`   目标版本: ${newVersion}`);

      if (newVersion === oldVersionFromMeta) {
        console.log(`\n⚠️ 版本相同，无需升级。如需强制覆盖请使用 --force`);
        if (!args.includes('--force')) {
          process.exit(0);
        }
        console.log('   --force 已指定，继续执行...');
      }

      // 5. 执行升级（利用 reload 的快照回退机制）
      console.log(`\n⏳ 执行升级（内置回退保护）...`);
      const upgradeResult = await ctx.reload(newPluginClass, target);

      if (upgradeResult.success) {
        console.log(`\n✅ 升级成功！`);
        console.log(`   插件: ${target}`);
        console.log(`   版本: ${oldVersionFromMeta} → ${newVersion}`);
        // 更新注册表中的插件类
        loader._registry.set(target, newPluginClass);
      } else if (upgradeResult.rolledBack) {
        console.error(`\n⚠️ 升级失败，已自动回退到旧版本`);
        console.error(`   原因: ${upgradeResult.error}`);
        console.error(`   当前运行版本: ${oldVersionFromMeta}（未变更）`);
        process.exit(1);
      } else {
        console.error(`\n❌ 升级失败: ${upgradeResult.error}`);
        process.exit(1);
      }
      break;
    }

    case 'info': {
      const registryInfo = loader.getRegistryInfo();
      console.log(`\n插件注册表 (${registryInfo.length} 个插件):\n`);
      for (const info of registryInfo) {
        const mounted = ctx.getPlugins().some(p => p.name === info.name);
        const status = mounted ? '🟢 已挂载' : '⚪ 未挂载';
        console.log(`  ${info.name.padEnd(14)} ${status}`);
        if (info.description) console.log(`    描述: ${info.description}`);
        if (info.dependencies.length > 0) console.log(`    依赖: ${info.dependencies.join(', ')}`);
        if (info.provides.length > 0) console.log(`    提供: ${info.provides.join(', ')}`);
        console.log('');
      }
      break;
    }

    case 'install': {
      if (!target) {
        console.error('用法: plugin install <local-path | https://url> [--force] [--skip-verify] [--policy strict|warn|skip]');
        process.exit(1);
      }
      const force = args.includes('--force');
      const skipVerify = args.includes('--skip-verify');
      const policyIdx = args.indexOf('--policy');
      const policy = policyIdx >= 0 ? args[policyIdx + 1] : undefined;
      const result = await loader.installAndMount(ctx, target, { force, skipVerify, verifyPolicy: policy });
      if (result.success) {
        console.log(`✅ 第三方插件 "${result.name}" 安装成功`);
        console.log(`   来源: ${result.source}`);
        console.log(`   类型: ${result.type}`);
        if (result.signature) {
          console.log(`   签名: ✅ 已验证 (key: ${result.signature.keyId || 'default'})`);
        }
        console.log(`   挂载: ${result.mounted ? '已挂载' : `失败 (${result.mountError})`}`);
      } else {
        console.error(`❌ 安装失败: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'sign': {
      if (!target) {
        console.error('用法: plugin sign <file-path> [--key-id <id>]');
        process.exit(1);
      }
      const { PluginSignature } = await import('./core/plugin-signature.js');
      const signer = new PluginSignature();
      const keyIdIdx = args.indexOf('--key-id');
      const keyId = keyIdIdx >= 0 ? args[keyIdIdx + 1] : undefined;
      const signResult = await signer.sign(target, keyId);
      if (signResult.success) {
        console.log(`✅ 签名成功`);
        console.log(`   文件: ${target}`);
        console.log(`   HMAC: ${signResult.hmac}`);
        console.log(`   密钥: ${signResult.keyId}`);
        console.log(`   签名文件: ${signResult.sigPath}`);
      } else {
        console.error(`❌ 签名失败: ${signResult.error}`);
        process.exit(1);
      }
      break;
    }

    case 'verify': {
      if (!target) {
        console.error('用法: plugin verify <file-path>');
        process.exit(1);
      }
      const { PluginSignature } = await import('./core/plugin-signature.js');
      const verifier = new PluginSignature();
      const verifyResult = await verifier.verify(target);
      if (verifyResult.valid) {
        console.log(`✅ 签名验证通过`);
        console.log(`   文件: ${target}`);
        console.log(`   密钥: ${verifyResult.keyId}`);
        console.log(`   签名时间: ${verifyResult.signedAt}`);
      } else {
        console.error(`❌ 签名验证失败: ${verifyResult.reason}`);
        process.exit(1);
      }
      break;
    }

    case 'watch': {
      const debounceMs = args[2] ? parseInt(args[2]) : 300;
      const watcher = new PluginWatcher(ctx, loader, { debounceMs, verbose: true });
      watcher.start();

      console.log('\n按 Ctrl+C 停止监听...\n');

      // 优雅退出
      const cleanup = async () => {
        watcher.stop();
        await ctx.dispose();
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      // 保持进程活跃
      await new Promise(() => {});
      break;
    }

    case 'watch-status': {
      // 此命令仅在 watch 进程内有意义，这里展示说明
      console.log('watch-status 需要在 plugin watch 运行期间使用');
      console.log('当前监听状态可通过 watcher.getStatus() 获取');
      break;
    }

    case 'health': {
      const results = await ctx.healthCheckAll();
      const healthyCount = results.filter(r => r.healthy).length;
      const unhealthyCount = results.length - healthyCount;

      console.log(`\n插件健康检查 (${results.length} 个插件, ${healthyCount} 健康, ${unhealthyCount} 异常):\n`);
      for (const r of results) {
        const icon = r.healthy ? '✅' : '❌';
        console.log(`  ${icon} ${r.name.padEnd(14)} [${r.status}] ${r.message || ''}`);
        if (r.details) {
          for (const [k, v] of Object.entries(r.details)) {
            console.log(`      ${k}: ${v}`);
          }
        }
        if (r.recentErrors.length > 0) {
          console.log(`      最近错误 (${r.errorCount} 条):`);
          for (const err of r.recentErrors) {
            console.log(`        [${err.timestamp}] ${err.message}`);
          }
        }
      }
      break;
    }

    case 'config': {
      const configAction = args[1] || 'list'; // get | set | list | delete
      const pluginName = args[2];
      const configKey = args[3];
      const configValue = args[4];

      if (!configAction || configAction === 'list') {
        // 列出所有配置
        const allConfig = ctx.config.getAll();
        const pluginNames = Object.keys(allConfig);
        if (pluginNames.length === 0) {
          console.log('暂无插件配置');
          console.log('设置方式: plugin config set <plugin> <key> <value>');
        } else {
          console.log('\n插件配置:');
          for (const name of pluginNames) {
            const entries = Object.entries(allConfig[name]);
            console.log(`  ${name}:`);
            for (const [k, v] of entries) {
              console.log(`    ${k} = ${JSON.stringify(v)}`);
            }
          }
        }
      } else if (configAction === 'get') {
        if (!pluginName) { console.error('用法: plugin config get <plugin> [key]'); process.exit(1); }
        if (configKey) {
          const val = ctx.config.get(pluginName, configKey);
          console.log(val !== undefined ? `${pluginName}.${configKey} = ${JSON.stringify(val)}` : `${pluginName}.${configKey} 未设置`);
        } else {
          const pluginConfig = ctx.config.get(pluginName);
          console.log(`${pluginName} 配置:`, JSON.stringify(pluginConfig, null, 2));
        }
      } else if (configAction === 'set') {
        if (!pluginName || !configKey || configValue === undefined) {
          console.error('用法: plugin config set <plugin> <key> <value>');
          process.exit(1);
        }
        // 尝试解析 JSON 值
        let parsedValue = configValue;
        try { parsedValue = JSON.parse(configValue); } catch { /* 保持字符串 */ }
        const result = ctx.config.set(pluginName, configKey, parsedValue);
        console.log(`✅ 配置已更新: ${pluginName}.${configKey} = ${JSON.stringify(parsedValue)}`);
        if (result.oldValue !== undefined) {
          console.log(`   (旧值: ${JSON.stringify(result.oldValue)})`);
        }
      } else if (configAction === 'delete') {
        if (!pluginName || !configKey) {
          console.error('用法: plugin config delete <plugin> <key>');
          process.exit(1);
        }
        const deleted = ctx.config.delete(pluginName, configKey);
        console.log(deleted ? `✅ 已删除: ${pluginName}.${configKey}` : `❌ 配置不存在: ${pluginName}.${configKey}`);
      } else {
        console.error(`未知配置操作: ${configAction}`);
        console.error('可用: get | set | delete | list');
        process.exit(1);
      }
      break;
    }

    case 'state': {
      const savedState = loader.loadSavedState();
      if (!savedState) {
        console.log('无已保存的插件状态');
        console.log('提示: 执行 plugin mount/unmount 后会自动保存状态');
        console.log('      下次启动时使用 --restore 恢复');
      } else {
        console.log(`\n已保存的插件状态:`);
        console.log(`  Profile: ${savedState.profile}`);
        console.log(`  保存时间: ${savedState.savedAt}`);
        console.log(`  已挂载 (${savedState.mounted.length}): ${savedState.mounted.join(', ')}`);
        if (savedState.unmounted.length > 0) {
          console.log(`  已卸载 (${savedState.unmounted.length}): ${savedState.unmounted.join(', ')}`);
        }
        if (savedState.externalPlugins.length > 0) {
          console.log(`  外部插件 (${savedState.externalPlugins.length}):`);
          for (const ext of savedState.externalPlugins) {
            console.log(`    ${ext.name} ← ${ext.source} (${ext.type})`);
          }
        }
        console.log(`\n恢复方式: node scripts/cli-plugin.js --restore <command>`);
      }
      break;
    }

    case 'state-clear': {
      loader.clearState();
      console.log('✅ 已清除保存的插件状态');
      break;
    }

    default:
      console.error(`未知子命令: ${subCommand}`);
      console.error('可用: list | mount | unmount | reload | info | watch | install | sign | verify | config | health | state | state-clear');
      console.error('插件市场请使用: market <sub-command>');
      process.exit(1);
  }
}

// ==================== 插件市场命令 ====================

async function handleMarketCommand(ctx, loader, args) {
  const subCommand = args[0];
  const market = new PluginMarket();
  const permission = new PluginPermission();

  // 权限守卫：管理员专属操作
  const guard = permission.guardMarketCommand(subCommand);
  if (!guard.allowed) {
    console.error(`⛔ ${guard.reason}`);
    console.error('提示: 普通用户可使用 market list/search/install 申请扩展插件');
    process.exit(1);
  }

  switch (subCommand) {
    case 'list': {
      const plugins = await market.listAvailable();
      const installed = market.getInstalled();
      const installedNames = new Set(installed.map(p => p.name));

      if (plugins.length === 0) {
        console.log('\n插件市场为空');
        console.log('提示: 将插件文件放入 .ipfs-nodes/marketplace/ 目录，或使用 market publish 发布');
      } else {
        console.log(`\n插件市场 (${plugins.length} 个可用插件):\n`);
        for (const p of plugins) {
          const status = installedNames.has(p.name) ? '📦 已安装' : '  ';
          const tags = p.tags.length > 0 ? ` [${p.tags.join(', ')}]` : '';
          console.log(`  ${p.name.padEnd(16)} v${p.version.padEnd(8)} ${status} ${p.description}${tags}`);
        }
      }

      if (installed.length > 0) {
        console.log(`\n已安装 (${installed.length}):`);
        for (const p of installed) {
          console.log(`  ${p.name.padEnd(16)} v${p.version.padEnd(8)} 来源: ${p.source}  安装于: ${p.installedAt}`);
        }
      }
      break;
    }

    case 'search': {
      const keyword = args[1];
      if (!keyword) {
        console.error('用法: market search <keyword>');
        process.exit(1);
      }
      const results = await market.search(keyword);
      if (results.length === 0) {
        console.log(`\n未找到匹配 "${keyword}" 的插件`);
      } else {
        console.log(`\n搜索结果 "${keyword}" (${results.length} 个):\n`);
        for (const p of results) {
          const tags = p.tags.length > 0 ? ` [${p.tags.join(', ')}]` : '';
          console.log(`  ${p.name.padEnd(16)} v${p.version.padEnd(8)} ${p.description}${tags}`);
          console.log(`    作者: ${p.author}  来源: ${p.source}`);
        }
      }
      break;
    }

    case 'info': {
      const name = args[1];
      if (!name) {
        console.error('用法: market info <plugin-name>');
        process.exit(1);
      }
      const info = await market.getPluginInfo(name);
      if (!info) {
        console.error(`❌ 市场中未找到插件 "${name}"`);
        process.exit(1);
      }
      console.log(`\n插件详情: ${info.name}`);
      console.log(`  版本: ${info.version}`);
      console.log(`  描述: ${info.description}`);
      console.log(`  作者: ${info.author}`);
      console.log(`  来源: ${info.source}`);
      console.log(`  类型: ${info.type}`);
      console.log(`  入口: ${info.entry}`);
      if (info.provides.length > 0) console.log(`  提供服务: ${info.provides.join(', ')}`);
      if (info.dependencies.length > 0) console.log(`  依赖: ${info.dependencies.join(', ')}`);
      if (info.tags.length > 0) console.log(`  标签: ${info.tags.join(', ')}`);
      console.log(`  已安装: ${market.isInstalled(name) ? '是' : '否'}`);
      break;
    }

    case 'install': {
      const name = args[1];
      if (!name) {
        console.error('用法: market install <plugin-name> [--force] [--skip-verify]');
        process.exit(1);
      }
      const force = args.includes('--force');
      const skipVerify = args.includes('--skip-verify');

      console.log(`\n正在从市场安装 "${name}"...`);
      const result = await market.install(name, { force, skipVerify });

      if (!result.success) {
        console.error(`❌ 安装失败: ${result.error}`);
        process.exit(1);
      }

      console.log(`✅ 插件 "${result.name}" 安装成功`);
      console.log(`   版本: ${result.record.version}`);
      console.log(`   来源: ${result.record.source}`);
      if (result.signature) {
        console.log(`   签名: ✅ 已验证 (key: ${result.signature.keyId || 'default'})`);
      }

      // 尝试挂载到当前上下文
      if (result.plugin) {
        try {
          const plugin = typeof result.plugin === 'function'
            ? (result.plugin.prototype?.install ? new result.plugin() : result.plugin())
            : result.plugin;
          const mountResult = await ctx.mount(plugin);
          if (mountResult.success) {
            console.log(`   挂载: ✅ 已挂载到运行时`);
          } else {
            console.log(`   挂载: ⚠️ ${mountResult.error}（下次启动时自动加载）`);
          }
        } catch (e) {
          console.log(`   挂载: ⚠️ ${e.message}（下次启动时自动加载）`);
        }
      }
      break;
    }

    case 'uninstall': {
      const name = args[1];
      if (!name) {
        console.error('用法: market uninstall <plugin-name>');
        process.exit(1);
      }

      // 先尝试从运行时卸载
      const unmountResult = await ctx.unmount(name);
      if (unmountResult.success) {
        console.log(`  已从运行时卸载`);
      }

      const result = await market.uninstall(name);
      if (result.success) {
        console.log(`✅ 插件 "${name}" 已从市场卸载`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'installed': {
      const installed = market.getInstalled();
      if (installed.length === 0) {
        console.log('\n暂无已安装的市场插件');
        console.log('使用 market install <name> 安装');
      } else {
        console.log(`\n已安装的市场插件 (${installed.length}):\n`);
        for (const p of installed) {
          const mounted = ctx.getPlugins().some(pl => pl.name === p.name);
          const status = mounted ? '🟢 运行中' : '⚪ 未挂载';
          console.log(`  ${p.name.padEnd(16)} v${p.version.padEnd(8)} ${status}`);
          console.log(`    来源: ${p.source}  安装于: ${p.installedAt}`);
          if (p.description) console.log(`    描述: ${p.description}`);
        }
      }
      break;
    }

    case 'sources': {
      const sources = market.getSources();
      console.log(`\n市场源 (${sources.length}):\n`);
      for (const s of sources) {
        const detail = s.type === 'local' ? `路径: ${s.path}` : `URL: ${s.url}`;
        console.log(`  ${s.name.padEnd(12)} [${s.type}] ${detail}`);
      }
      break;
    }

    case 'add-source': {
      const name = args[1];
      const type = args[2]; // local | remote
      const location = args[3]; // path or url
      if (!name || !type || !location) {
        console.error('用法: market add-source <name> <local|remote> <path|url>');
        process.exit(1);
      }
      const result = market.addSource(name, { type, ...(type === 'local' ? { path: location } : { url: location }) });
      if (result.success) {
        console.log(`✅ 市场源 "${name}" 已添加`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'remove-source': {
      const name = args[1];
      if (!name) {
        console.error('用法: market remove-source <name>');
        process.exit(1);
      }
      const result = market.removeSource(name);
      if (result.success) {
        console.log(`✅ 市场源 "${name}" 已移除`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'publish': {
      const filePath = args[1];
      if (!filePath) {
        console.error('用法: market publish <file-or-dir> [--name <name>] [--version <ver>] [--desc <text>] [--author <name>] [--tags <t1,t2>]');
        process.exit(1);
      }
      // 解析可选参数
      const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx >= 0 ? args[idx + 1] : undefined;
      };
      const manifest = {
        name: getArg('--name'),
        version: getArg('--version'),
        description: getArg('--desc'),
        author: getArg('--author'),
        tags: getArg('--tags')?.split(',').map(t => t.trim()) || []
      };

      const result = await market.publish(filePath, manifest);
      if (result.success) {
        console.log(`✅ 插件 "${result.name}" 已发布到本地市场`);
        console.log(`   路径: ${result.path}`);
        console.log(`   使用 market install ${result.name} 安装`);
      } else {
        console.error(`❌ 发布失败: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'unpublish': {
      const name = args[1];
      if (!name) {
        console.error('用法: market unpublish <plugin-name>');
        process.exit(1);
      }
      const result = market.unpublish(name);
      if (result.success) {
        console.log(`✅ 插件 "${name}" 已从市场移除`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'stats': {
      const stats = market.getStats();
      console.log('\n插件市场统计:');
      console.log(`  市场源: ${stats.sourceCount} (${stats.sources.join(', ')})`);
      console.log(`  已安装: ${stats.installedCount}`);
      console.log(`  更新时间: ${stats.updatedAt}`);
      break;
    }

    default:
      console.error(`未知市场子命令: ${subCommand}`);
      console.error('可用: list | search | info | install | uninstall | installed | sources | add-source | remove-source | publish | unpublish | stats');
      process.exit(1);
  }
}

// ==================== 辅助函数 ====================

async function listPlugins(profile) {
  const loader = createLoader();
  const ctx = await loader.load(profile);
  const plugins = ctx.getPlugins();
  console.log(`Profile: ${profile}`);
  console.log(`已加载插件 (${plugins.length}):`);
  for (const p of plugins) {
    console.log(`  ${p.name} [${p.status}]`);
  }
  const summary = loader.getLoadSummary(ctx);
  if (summary.failed.length > 0) {
    console.log(`\n失败插件:`);
    summary.failed.forEach(f => console.log(`  ${f.name}: ${f.error}`));
  }
  await ctx.dispose();
}

// ==================== 批量升级 ====================

async function handleUpgradeAll(ctx, loader) {
  console.log('\n🔄 批量升级：重载所有已挂载插件到最新版本');
  console.log('='.repeat(50));

  const plugins = ctx.getPlugins();
  if (plugins.length === 0) {
    console.log('  ℹ️ 当前无已挂载插件，无需升级');
    return;
  }

  // 1. 拓扑排序（依赖在前），保证卸载/挂载顺序安全
  const names = plugins.map(p => p.name);
  const depsOf = (name) => {
    const info = plugins.find(p => p.name === name);
    return (info?.dependencies || []).filter(d => names.includes(d));
  };

  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`插件循环依赖: ${name}`);
    visiting.add(name);
    for (const dep of depsOf(name)) visit(dep);
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  };
  try {
    for (const name of names) visit(name);
  } catch (e) {
    console.error(`❌ 依赖解析失败: ${e.message}`);
    process.exit(1);
  }

  const unmountOrder = [...ordered].reverse(); // 卸载时先卸载依赖者（反向）

  console.log(`\n  检测到 ${plugins.length} 个已挂载插件`);
  console.log(`  升级顺序: ${ordered.join(' → ')}\n`);

  const results = { success: [], failed: [] };
  const broken = new Set(); // 升级失败的插件集合（级联跳过其依赖者）

  // 2. 阶段一：按逆依赖顺序卸载所有旧版本
  console.log('  [1/2] 卸载旧版本...');
  for (const name of unmountOrder) {
    process.stdout.write(`    卸载 ${name.padEnd(16)} ... `);
    try {
      const r = await ctx.unmount(name);
      if (r.success) {
        console.log('✅');
      } else {
        console.log(`❌ ${r.error}`);
        broken.add(name);
        results.failed.push({ name, phase: '卸载', reason: r.error });
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      broken.add(name);
      results.failed.push({ name, phase: '卸载', reason: e.message });
    }
  }

  // 3. 阶段二：按依赖顺序从注册表重新挂载（注册表即最新版本）
  console.log('  [2/2] 挂载最新版本...');
  for (const name of ordered) {
    const brokenDeps = depsOf(name).filter(d => broken.has(d));
    if (brokenDeps.length > 0) {
      console.log(`    挂载 ${name.padEnd(16)} ... ⏭️ 跳过（依赖 ${brokenDeps.join(', ')} 升级失败）`);
      broken.add(name);
      results.failed.push({ name, phase: '挂载', reason: `依赖插件升级失败: ${brokenDeps.join(', ')}` });
      continue;
    }
    process.stdout.write(`    挂载 ${name.padEnd(16)} ... `);
    try {
      const r = await loader.mountPlugin(ctx, name);
      if (r.success) {
        console.log('✅');
        results.success.push(name);
      } else {
        console.log(`❌ ${r.error}`);
        broken.add(name);
        results.failed.push({ name, phase: '挂载', reason: r.error });
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      broken.add(name);
      results.failed.push({ name, phase: '挂载', reason: e.message });
    }
  }

  // 4. 汇总
  console.log('\n' + '='.repeat(50));
  console.log(`📊 批量升级结果:`);
  console.log(`   ✅ 成功: ${results.success.length}/${plugins.length}`);
  if (results.failed.length > 0) {
    console.log(`   ❌ 失败: ${results.failed.length}`);
    for (const f of results.failed) {
      console.log(`      ${f.name}（${f.phase}）: ${f.reason}`);
    }
    console.log('\n   ⚠️ 存在失败项，请检查后重新执行升级或重启系统');
    process.exitCode = 1;
  } else {
    console.log('   🎉 所有插件已重载到最新版本');
  }
  console.log('');
}

// ==================== 一键激活 ====================

async function handleActivate(profile, activateArgs) {
  const { execSync } = await import('child_process');
  const { existsSync } = await import('fs');
  const { resolve } = await import('path');

  const CWD = resolve(import.meta.dirname || '.');
  const NODES_DIR = '/home/project/.ipfs-nodes';

  console.log('\n🚀 IPFS 分布式存储网络 - 一键激活');
  console.log('='.repeat(50));

  // 步骤 1: 检查依赖
  console.log('\n[1/5] 检查依赖...');
  if (!existsSync(resolve(CWD, 'node_modules'))) {
    console.log('  安装依赖中...');
    try {
      execSync('pnpm install', { cwd: CWD, stdio: 'pipe', timeout: 120000 });
      console.log('  ✅ 依赖安装完成');
    } catch (e) {
      console.error('  ❌ 依赖安装失败:', e.message);
      process.exit(1);
    }
  } else {
    console.log('  ✅ 依赖已就绪');
  }

  // 步骤 2: 初始化节点（如果尚未初始化）
  console.log('\n[2/5] 初始化存储节点...');
  const hasNodes = existsSync(NODES_DIR) &&
    execSync(`ls ${NODES_DIR} 2>/dev/null | grep -c "node-" || true`, { encoding: 'utf-8' }).trim() !== '0';

  if (!hasNodes) {
    try {
      const loader = createLoader();
      const ctx = await loader.load(profile, { cli: true });
      const commands = ctx.getCommands();
      if (commands.has('init')) {
        await ctx.executeCommand('init');
        console.log('  ✅ 节点初始化完成');
      } else {
        console.log('  ⚠️ init 命令不可用，跳过初始化');
      }
      await ctx.dispose();
    } catch (e) {
      console.error('  ❌ 初始化失败:', e.message);
      process.exit(1);
    }
  } else {
    console.log('  ✅ 节点已存在，跳过初始化');
  }

  // 步骤 3: 加载插件 Profile
  console.log(`\n[3/5] 加载插件 Profile: ${profile}...`);
  let ctx, loader;
  try {
    loader = createLoader();
    ctx = await loader.load(profile, { cli: true });
    const plugins = ctx.getPlugins();
    console.log(`  ✅ 已加载 ${plugins.length} 个插件: ${plugins.map(p => p.name).join(', ')}`);
  } catch (e) {
    console.error('  ❌ 插件加载失败:', e.message);
    process.exit(1);
  }

  // 步骤 4: 恢复上次状态
  console.log('\n[4/5] 恢复插件状态...');
  if (loader.hasSavedState()) {
    const restoreResult = await loader.restoreState(ctx);
    if (restoreResult.restored) {
      const actions = restoreResult.actions || [];
      console.log(`  ✅ 已恢复 ${actions.length} 项状态变更`);
    } else {
      console.log('  ℹ️ 无需恢复');
    }
  } else {
    console.log('  ℹ️ 无历史状态，使用默认配置');
  }

  // 步骤 5: 健康检查
  console.log('\n[5/5] 执行健康检查...');
  try {
    const healthResults = await ctx.healthCheckAll();
    const healthy = healthResults.filter(h => h.healthy);
    const unhealthy = healthResults.filter(h => !h.healthy);

    if (unhealthy.length === 0) {
      console.log(`  ✅ 全部 ${healthy.length} 个插件健康`);
    } else {
      console.log(`  ⚠️ ${healthy.length} 健康, ${unhealthy.length} 异常:`);
      for (const h of unhealthy) {
        console.log(`    ❌ ${h.name}: ${h.message}`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️ 健康检查异常: ${e.message}`);
  }

  // 激活完成摘要
  console.log('\n' + '='.repeat(50));
  console.log('🎉 分布式存储网络已激活！');
  console.log(`   Profile: ${profile}`);
  console.log(`   插件数: ${ctx.getPlugins().length}`);
  console.log(`   数据目录: ${NODES_DIR}`);
  console.log('\n可用命令:');
  console.log('   node scripts/cli-plugin.js status        查看网络状态');
  console.log('   node scripts/cli-plugin.js upload <file>  上传文件');
  console.log('   node scripts/cli-plugin.js plugin list    查看插件');
  console.log('   node scripts/cli-plugin.js market list    浏览插件市场');
  console.log('');

  await ctx.dispose();
}

function printHelp() {
  console.log(`
IPFS 分布式存储网络 - 插件驱动 CLI

用法: node scripts/cli-plugin.js [--profile <name>] <command> [args...]

Profiles:
  full          完整功能（默认）
  storage-only  仅存储 + 安全
  admin         管理命令（监控 + 升级）

核心命令:
  activate              一键激活（依赖检查→初始化→加载→恢复→健康检查）
  init                  初始化存储网络
  node-start            启动节点
  node-list             列出节点
  upload <file>         上传文件
  download <cid>        下载文件
  delete <cid>          删除文件
  info <cid>            查看文件信息
  files                 列出所有文件

管理命令:
  upgrade               滚动升级管理
  capacity              容量报告
  dashboard             可视化面板
  network-status        网络状态
  network-health        健康检查

用户命令:
  user-register <name>  注册用户
  user-login <name>     登录
  user-logout           登出
  user-list             列出用户

插件管理（运行时动态操作）:
  plugin list           查看已挂载/可挂载插件及依赖图
  plugin mount <name>   运行时挂载插件
  plugin unmount <name> 运行时卸载插件
  plugin reload <name>  运行时重载插件
  plugin upgrade <name> --from <path>  升级插件（版本对比+回退保护）
  plugin upgrade --all          批量升级所有已挂载插件
  plugin info           查看注册表所有插件详情
  plugin watch [ms]     监听插件文件变更，自动热重载（默认 300ms 防抖）
  plugin install <src>  从本地路径或 https:// URL 安装第三方插件
  plugin sign <file>    为插件文件生成 HMAC-SHA256 签名
  plugin verify <file>  验证插件文件签名完整性

插件市场:
  market list           浏览市场中所有可用插件
  market search <kw>    搜索插件（名称/描述/标签）
  market info <name>    查看插件详情
  market install <name> 从市场安装插件到运行时
  market uninstall <n>  卸载市场插件
  market installed      查看已安装的市场插件
  market sources        查看市场源配置
  market add-source     添加市场源（本地目录/远程注册表）
  market remove-source  移除市场源
  market publish <path> 发布插件到本地市场
  market unpublish <n>  从市场移除已发布插件
  market stats          市场统计信息

安全命令:
  whitelist             P2P 白名单管理

健康管理:
  plugin health           执行所有插件健康检查，展示状态和最近错误

配置管理（运行时热更新）:
  plugin config list              列出所有插件配置
  plugin config get <p> [key]     获取插件配置
  plugin config set <p> <k> <v>   设置插件配置（立即生效）
  plugin config delete <p> <k>    删除配置项

状态管理:
  plugin state          查看已保存的插件状态
  plugin state-clear    清除保存的插件状态

选项:
  --profile <name>      选择插件组合
  --restore             启动时恢复上次保存的插件状态
  --list-plugins        列出当前 profile 的插件
  --help, -h            显示帮助
`);
}
