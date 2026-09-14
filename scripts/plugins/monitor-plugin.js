/**
 * IPFS 分布式存储网络 - 监控插件（MonitorPlugin）
 *
 * 插件架构：包装 network-monitor.js，注册为 'monitor' 服务
 * 提供命令：network-status / network-health / network-forecast / dashboard / capacity
 * 依赖：node-manager（节点数据）、storage（容量报告、文件列表）
 */

import { PluginBase } from '../core/plugin-base.js';
import NetworkMonitor from '../network-monitor.js';
import fs from 'fs-extra';
import path from 'path';

export class MonitorPlugin extends PluginBase {
  constructor() {
    super('monitor', {
      description: '网络状态监控、健康检查、容量预测、可视化面板',
      provides: ['monitor'],
      dependencies: ['node-manager', 'storage']
    });
    this.networkMonitor = null;
  }

  async install(ctx) {
    await super.install(ctx);
    this.networkMonitor = new NetworkMonitor();
    this.provide('monitor', this.networkMonitor);

    this.command('network-status', {
      description: '查看网络状态',
      handler: async () => {
        const status = await this.networkMonitor.getNetworkStatus();
        console.log('═══ 网络状态 ═══');
        console.log(`  版本: ${status.network.version}`);
        console.log(`  节点总数: ${status.network.nodeCount}`);
        console.log(`  运行中: ${status.network.runningNodes}`);
        console.log(`  已停止: ${status.network.stoppedNodes}`);
        console.log('\n═══ 存储容量 ═══');
        console.log(`  总配额: ${status.storage.totalQuotaHuman}`);
        console.log(`  已使用: ${status.storage.totalUsedHuman}`);
        console.log(`  使用率: ${status.storage.usagePercent}%`);
        console.log('\n═══ 文件统计 ═══');
        console.log(`  文件数: ${status.files.count}`);
        console.log(`  总大小: ${status.files.totalSizeHuman}`);
        if (status.nodes?.length > 0) {
          console.log('\n═══ 节点详情 ═══');
          status.nodes.forEach(node => {
            const icon = node.status === 'running' ? '🟢' : '🔴';
            console.log(`  ${icon} ${node.nodeId} | 配额: ${node.quota} | 已用: ${node.used} (${node.usagePercent}%)`);
          });
        }
      }
    });

    this.command('network-health', {
      description: '网络健康检查',
      handler: async () => {
        const health = await this.networkMonitor.healthCheck();
        console.log('网络健康检查:');
        console.log(`  总节点数: ${health.totalNodes}`);
        console.log(`  健康节点: ${health.healthyNodes}`);
        console.log(`  异常节点: ${health.totalNodes - health.healthyNodes}`);
        health.nodes.forEach(node => {
          const icon = node.healthy ? '✅' : '❌';
          console.log(`  ${icon} ${node.nodeId} | 状态: ${node.status} | 块数: ${node.blockCount}`);
        });
      }
    });

    this.command('network-forecast', {
      description: '容量预测',
      handler: async () => {
        const forecast = await this.networkMonitor.capacityForecast();
        console.log('容量预测:');
        console.log(`  当前使用: ${forecast.currentUsage}`);
        console.log(`  剩余空间: ${forecast.remaining}`);
        console.log(`  使用率: ${forecast.usageRate}`);
        console.log(`  建议: ${forecast.recommendation}`);
      }
    });

    this.command('capacity', {
      description: '查看集群容量状态（使用率、剩余空间、各节点分布）',
      handler: async () => {
        const storage = this.use('storage');
        const report = await storage.getCapacityReport();
        if (report.nodeCount === 0) {
          console.log('无在线存储节点，请先运行 node start');
          return;
        }
        const pct = (report.usageRate * 100).toFixed(1);
        const levelMap = { healthy: '🟢 健康', caution: '🟡 注意', warning: '🟠 预警', critical: '🔴 危险' };
        console.log('\n集群容量概览');
        console.log(`  状态: ${levelMap[report.level] || '🟢 健康'}`);
        console.log(`  节点数: ${report.nodeCount}`);
        console.log(`  总容量: ${storage.formatBytes(report.totalQuota)}`);
        console.log(`  已使用: ${storage.formatBytes(report.totalUsed)} (${pct}%)`);
        console.log(`  剩余:   ${storage.formatBytes(report.availableBytes)}`);
        const barLen = 30;
        const filled = Math.round(report.usageRate * barLen);
        console.log(`  ${'█'.repeat(filled)}${'░'.repeat(barLen - filled)} ${pct}%`);
        console.log('\n节点容量分布');
        for (const node of report.nodes) {
          const nodePct = (node.usageRate * 100).toFixed(1);
          const nf = Math.round(node.usageRate * 20);
          console.log(`  ${node.nodeId.padEnd(10)} ${storage.formatBytes(node.usedSpace).padStart(10)} / ${storage.formatBytes(node.freeSpace).padStart(10)}  ${'█'.repeat(nf)}${'░'.repeat(20 - nf)} ${nodePct}%`);
        }
        if (report.level === 'critical') {
          console.log('\n⚠️  集群使用率超过 90%，建议删除不需要的文件或扩容节点。');
        } else if (report.level === 'warning') {
          console.log('\n⚠️  集群使用率超过 80%，建议关注容量增长趋势。');
        }
      }
    });

    this.command('dashboard', {
      description: '文件存储状态可视化面板',
      handler: async () => {
        const storage = this.use('storage');
        const status = await this.networkMonitor.getNetworkStatus();
        const files = await storage.listFiles();

        const W = 56;
        const line = '═'.repeat(W);
        const thin = '─'.repeat(W);
        console.log(`╔${line}╗`);
        console.log('║' + '  IPFS 分布式存储网络 · 状态面板'.padEnd(W - 2) + '║');
        console.log(`╚${line}╝`);

        console.log(`\n┌${thin}┐`);
        console.log('│' + ' 网络概览'.padEnd(W - 2) + '│');
        console.log(`├${thin}┤`);
        const rows = [
          ['节点总数', `${status.network.nodeCount}`],
          ['运行中', `${status.network.runningNodes}`],
          ['已停止', `${status.network.stoppedNodes}`],
          ['文件总数', `${status.files.count}`],
          ['数据总量', status.files.totalSizeHuman]
        ];
        for (const [label, value] of rows) {
          const pad = W - 4 - label.length * 2 - value.length;
          console.log('│' + `  ${label}` + ' '.repeat(Math.max(1, pad)) + `${value} ` + '│');
        }
        console.log(`└${thin}┘`);

        console.log(`\n┌${thin}┐`);
        console.log('│' + ' 节点存储状态'.padEnd(W - 2) + '│');
        console.log(`├${thin}┤`);
        for (const node of status.nodes) {
          const icon = node.status === 'running' ? '●' : '○';
          const pct = parseFloat(node.usagePercent);
          const filled = Math.round((pct / 100) * 20);
          const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
          console.log(`│  ${icon} ${node.nodeId}  ${bar} ${node.usagePercent}%` + ' '.repeat(Math.max(1, W - 4 - node.nodeId.length - 30)) + '│');
        }
        console.log(`└${thin}┘`);

        if (files?.length > 0) {
          console.log(`\n┌${thin}┐`);
          console.log('│' + ' 文件列表'.padEnd(W - 2) + '│');
          console.log(`├${thin}┤`);
          for (const file of files.slice(0, 8)) {
            const name = file.fileName.length > 14 ? file.fileName.slice(0, 12) + '..' : file.fileName;
            const row = `  ${name.padEnd(16)}${file.sizeHuman.padEnd(10)}${file.encrypted ? '🔒' : ''}`;
            console.log('│' + row + ' '.repeat(Math.max(1, W - 2 - 30)) + '│');
          }
          if (files.length > 8) {
            console.log('│' + `  ... 还有 ${files.length - 8} 个文件`.padEnd(W - 2) + '│');
          }
          console.log(`└${thin}┘`);
        }

        const forecast = await this.networkMonitor.capacityForecast();
        console.log(`\n┌${thin}┐`);
        console.log('│' + ' 容量预测'.padEnd(W - 2) + '│');
        console.log(`├${thin}┤`);
        console.log(`│  已使用: ${forecast.currentUsage}  剩余: ${forecast.remaining}  使用率: ${forecast.usageRate}` + ' '.repeat(Math.max(1, W - 2 - 46)) + '│');
        console.log(`│  建议: ${forecast.recommendation}` + ' '.repeat(Math.max(1, W - 2 - forecast.recommendation.length * 2 - 6)) + '│');
        console.log(`└${thin}┘`);
        console.log('');
      }
    });
  }

  async healthCheck() {
    const details = {};
    try {
      if (!this.networkMonitor) {
        return { healthy: false, message: 'NetworkMonitor 未初始化', details };
      }
      details.serviceReady = true;

      // 尝试获取网络状态
      const nodesDir = path.resolve('.ipfs-nodes');
      const exists = await fs.pathExists(nodesDir);
      details.nodesDirExists = exists;

      if (exists) {
        const status = await this.networkMonitor.getNetworkStatus();
        details.nodeCount = status.network?.nodeCount || 0;
        details.runningNodes = status.network?.runningNodes || 0;
        details.usagePercent = status.storage?.usagePercent || '0';
      }

      const healthy = details.serviceReady && details.nodesDirExists;
      return {
        healthy,
        message: healthy
          ? `监控就绪 (${details.runningNodes}/${details.nodeCount} 节点运行中, 使用率 ${details.usagePercent}%)`
          : '网络未初始化',
        details
      };
    } catch (e) {
      this.recordError(e);
      return { healthy: false, message: `检查失败: ${e.message}`, details };
    }
  }
}

export default MonitorPlugin;
