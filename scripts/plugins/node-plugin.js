/**
 * 节点管理插件（Node Plugin）
 * 
 * 插件架构下的节点生命周期管理模块，包装 node-manager.js。
 * 提供：初始化、启动、停止、扩缩容、硬件评估等能力。
 * 注册服务：'nodeManager'
 * 发射事件：'network/initialized', 'node/started', 'node/stopped'
 */

import { PluginBase } from '../core/plugin-base.js';
import NodeManager from '../node-manager.js';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';

export class NodePlugin extends PluginBase {
  constructor() {
    super('node-manager', {
      description: '节点生命周期管理（初始化、启动、停止、扩缩容）',
      provides: ['nodeManager'],
      dependencies: []
    });
    this.nodeManager = null;
  }

  async install(ctx) {
    await super.install(ctx);
    this.nodeManager = new NodeManager();
    this.provide('nodeManager', this.nodeManager);
    this._registerCommands();
  }

  _registerCommands() {
    const nm = this.nodeManager;

    this.command('init', {
      description: '初始化存储网络（自动评估硬件配置）',
      handler: async () => {
        const spinner = ora('初始化存储网络...').start();
        try {
          const result = await nm.init();
          spinner.succeed('存储网络初始化成功');
          console.log(chalk.green('\n磁盘信息:'));
          console.log(`  总容量: ${result.diskInfo.totalHuman}`);
          console.log(`  可用空间: ${result.diskInfo.freeHuman}`);
          console.log(`  可分配空间: ${result.diskInfo.usableHuman}`);
          console.log(chalk.green('\n硬件评估:'));
          console.log(`  推荐节点数: ${result.assessment.recommendedNodes} (范围 ${result.assessment.minNodes}-${result.assessment.maxNodes})`);
          console.log(`  瓶颈维度: ${result.assessment.bottleneck}`);
          console.log(`  单节点配额: ${result.assessment.quotaHuman}`);
          console.log(`  总容量: ${result.assessment.totalCapacityHuman}`);
          console.log(`\n存储目录: ${result.nodesDir}`);
          this.emit('network/initialized', result);
        } catch (err) {
          spinner.fail(`初始化失败: ${err.message}`);
          process.exit(1);
        }
      }
    });

    this.command('node-start', {
      description: '启动存储节点',
      arguments: ['[node-id]'],
      options: [{ flags: '-n, --count <number>', description: '节点数量' }],
      handler: async (nodeId, options) => {
        if (nodeId) {
          const spinner = ora(`启动节点 ${nodeId}...`).start();
          try {
            const config = await nm.startNode(nodeId);
            spinner.succeed(`节点 ${nodeId} 启动成功`);
            console.log(chalk.green('\n节点配置:'));
            console.log(`  PeerID: ${config.peerId}`);
            console.log(`  配额: ${nm.formatBytes(config.quota)}`);
            console.log(`  端口: ${config.port}`);
            this.emit('node/started', { nodeId });
          } catch (err) {
            spinner.fail(`启动失败: ${err.message}`);
            process.exit(1);
          }
        } else {
          const count = options?.count ? parseInt(options.count) : null;
          const assessed = count === null ? await nm.getRecommendedNodeCount() : count;
          const spinner = ora(count === null
            ? `硬件评估推荐 ${assessed} 个节点，启动中...`
            : `启动 ${assessed} 个存储节点...`
          ).start();
          try {
            const result = await nm.startCluster(count);
            spinner.succeed(`${result.nodes.length} 个节点启动成功${count === null ? '（硬件自动评估）' : ''}`);
            console.log(chalk.green('\n节点列表:'));
            result.nodes.forEach(node => {
              console.log(`  ${node.nodeId}: ${node.peerId} (配额: ${nm.formatBytes(node.quota)})`);
            });
            console.log(chalk.green('\n集群配额:'));
            console.log(`  单节点: ${result.quota.quotaHuman}`);
            console.log(`  总计: ${result.quota.totalQuotaHuman}`);
            result.nodes.forEach(n => this.emit('node/started', { nodeId: n.nodeId }));
          } catch (err) {
            spinner.fail(`启动失败: ${err.message}`);
            process.exit(1);
          }
        }
      }
    });

    this.command('node-stop', {
      description: '停止节点',
      arguments: ['<node-id>'],
      handler: async (nodeId) => {
        const spinner = ora(`停止节点 ${nodeId}...`).start();
        try {
          const result = await nm.stopNode(nodeId);
          if (result.success) {
            spinner.succeed(`节点 ${nodeId} 已停止`);
            this.emit('node/stopped', { nodeId });
          } else {
            spinner.fail(result.error);
          }
        } catch (err) {
          spinner.fail(`停止失败: ${err.message}`);
        }
      }
    });

    this.command('node-list', {
      description: '列出所有节点',
      handler: async () => {
        const nodes = await nm.listNodes();
        if (nodes.length === 0) {
          console.log(chalk.yellow('暂无节点，请先运行 init 和 node start'));
          return;
        }
        console.log(chalk.green('节点列表:'));
        nodes.forEach(node => {
          const status = node.status === 'running' ? chalk.green('运行中') : chalk.red('已停止');
          console.log(`  ${node.nodeId}: ${status} | PeerID: ${node.peerId} | 配额: ${nm.formatBytes(node.quota)} | 已用: ${nm.formatBytes(node.usedSpace || 0)}`);
        });
      }
    });

    this.command('node-add', {
      description: '添加新节点（扩容）',
      handler: async () => {
        const spinner = ora('添加新节点...').start();
        try {
          const config = await nm.addNode();
          spinner.succeed(`新节点 ${config.nodeId} 添加成功`);
          console.log(chalk.green('\n节点配置:'));
          console.log(`  PeerID: ${config.peerId}`);
          console.log(`  配额: ${nm.formatBytes(config.quota)}`);
          this.emit('node/started', { nodeId: config.nodeId });
        } catch (err) {
          spinner.fail(`添加失败: ${err.message}`);
        }
      }
    });

    this.command('node-remove', {
      description: '移除节点',
      arguments: ['<node-id>'],
      options: [{ flags: '--migrate', description: '移除前先迁移数据' }],
      handler: async (nodeId, options) => {
        const spinner = ora(options?.migrate
          ? `迁移节点 ${nodeId} 数据并移除...`
          : `移除节点 ${nodeId}...`
        ).start();
        try {
          const result = await nm.removeNode(nodeId, { migrate: options?.migrate });
          if (result.success) {
            spinner.succeed(`节点 ${nodeId} 已移除`);
            console.log(`剩余节点数: ${result.remainingNodes}`);
            this.emit('node/stopped', { nodeId });
          } else {
            spinner.fail(result.error);
          }
        } catch (err) {
          spinner.fail(`移除失败: ${err.message}`);
        }
      }
    });

    this.command('node-status', {
      description: '查看节点状态',
      arguments: ['<node-id>'],
      handler: async (nodeId) => {
        const nodes = await nm.listNodes();
        const node = nodes.find(n => n.nodeId === nodeId);
        if (!node) {
          console.log(chalk.red(`节点 ${nodeId} 不存在`));
          process.exit(1);
        }
        console.log(chalk.green(`节点 ${nodeId} 状态:`));
        console.log(`  PeerID: ${node.peerId}`);
        console.log(`  状态: ${node.status === 'running' ? chalk.green('运行中') : chalk.red('已停止')}`);
        console.log(`  配额: ${nm.formatBytes(node.quota)}`);
        console.log(`  已用: ${nm.formatBytes(node.usedSpace || 0)}`);
      }
    });

    this.command('hardware-assess', {
      description: '评估硬件配置，输出推荐节点数',
      handler: async () => {
        const spinner = ora('评估硬件配置...').start();
        try {
          const assessment = await nm.getHardwareAssessment();
          spinner.succeed('硬件评估完成');
          console.log(chalk.green('\n═══ 硬件评估报告 ═══'));
          console.log(`  推荐节点数: ${chalk.cyan.bold(assessment.recommendedNodes)} (范围 ${assessment.minNodes}-${assessment.maxNodes})`);
          console.log(`  瓶颈维度: ${chalk.yellow(assessment.bottleneck)}`);
          console.log(`  单节点配额: ${assessment.quotaHuman}`);
          console.log(`  集群总容量: ${assessment.totalCapacityHuman}`);
        } catch (err) {
          spinner.fail(`评估失败: ${err.message}`);
          process.exit(1);
        }
      }
    });
  }

  async healthCheck() {
    const details = {};
    try {
      if (!this.nodeManager) {
        return { healthy: false, message: 'NodeManager 未初始化', details };
      }
      details.serviceReady = true;

      // 检查节点目录
      const nodesDir = path.resolve('.ipfs-nodes');
      const exists = await fs.pathExists(nodesDir);
      details.nodesDirExists = exists;

      if (exists) {
        const entries = await fs.readdir(nodesDir);
        const nodeDirs = entries.filter(e => e.startsWith('node-'));
        details.totalNodes = nodeDirs.length;

        // 检查各节点配置完整性
        let configOk = 0;
        for (const dir of nodeDirs) {
          const configPath = path.join(nodesDir, dir, 'config.json');
          if (await fs.pathExists(configPath)) configOk++;
        }
        details.configValid = configOk;
        details.configMissing = nodeDirs.length - configOk;
      }

      const healthy = details.serviceReady && details.nodesDirExists && (details.totalNodes || 0) > 0;
      return {
        healthy,
        message: healthy
          ? `${details.totalNodes} 节点就绪 (${details.configValid} 配置完整)`
          : (details.nodesDirExists ? '无节点' : '网络未初始化'),
        details
      };
    } catch (e) {
      this.recordError(e);
      return { healthy: false, message: `检查失败: ${e.message}`, details };
    }
  }
}

export default NodePlugin;
