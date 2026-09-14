#!/usr/bin/env node
/**
 * IPFS 分布式存储网络 - CLI 入口
 * 提供面向 Agent 友好的命令行接口
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import NodeManager from './node-manager.js';
import FileOperations from './file-ops.js';
import NetworkMonitor from './network-monitor.js';
import ACPProtocol from './acp-protocol.js';
import UpgradeManager from './upgrade.js';

const program = new Command();
const nodeManager = new NodeManager();
const fileOps = new FileOperations();
const networkMonitor = new NetworkMonitor();
const acpProtocol = new ACPProtocol();
const upgradeManager = new UpgradeManager();

program
  .name('ipfs-dfs')
  .description('IPFS 分布式存储网络 CLI')
  .version('1.0.0');

// ==================== 初始化命令 ====================

program
  .command('init')
  .description('初始化存储网络（自动评估硬件配置）')
  .action(async () => {
    const spinner = ora('初始化存储网络...').start();
    try {
      const result = await nodeManager.init();
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
    } catch (err) {
      spinner.fail(`初始化失败: ${err.message}`);
      process.exit(1);
    }
  });

// ==================== 身份管理命令 ====================

program
  .command('identity')
  .description('节点身份管理')
  .addCommand(
    new Command('create')
      .description('创建节点身份')
      .argument('<node-id>', '节点 ID')
      .action(async (nodeId) => {
        const spinner = ora(`创建节点身份 ${nodeId}...`).start();
        try {
          const identity = await nodeManager.createIdentity(nodeId);
          spinner.succeed('节点身份创建成功');
          console.log(chalk.green('\n身份信息:'));
          console.log(`  节点 ID: ${identity.nodeId}`);
          console.log(`  PeerID: ${identity.peerId}`);
          console.log(`  创建时间: ${identity.createdAt}`);
        } catch (err) {
          spinner.fail(`创建失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('show')
      .description('显示节点身份')
      .argument('<node-id>', '节点 ID')
      .action(async (nodeId) => {
        const identity = await nodeManager.loadIdentity(nodeId);
        if (!identity) {
          console.log(chalk.red(`节点 ${nodeId} 不存在`));
          process.exit(1);
        }
        console.log(chalk.green('身份信息:'));
        console.log(JSON.stringify(identity, null, 2));
      })
  );

// ==================== 节点管理命令 ====================

program
  .command('node')
  .description('节点管理')
  .addCommand(
    new Command('daemon')
      .description('启动 P2P 网络守护进程（节点真实互联 + floodsub 广播 + 定时自动伸缩）')
      .option('-n, --count <number>', '节点数量', '3')
      .option('--duration <seconds>', '运行时长（秒），0 表示永久运行', '0')
      .option('--autoscale-interval <seconds>', '自动伸缩检查间隔（秒），0 禁用', '60')
      .action(async (options) => {
        const count = parseInt(options.count);
        const duration = parseInt(options.duration);
        const autoscaleInterval = parseInt(options.autoscaleInterval);
        const spinner = ora(`启动 ${count} 节点 P2P 网络...`).start();
        try {
          const result = await nodeManager.startP2PNetwork(count);
          spinner.succeed(`P2P 网络启动成功，${result.totalConnections} 条连接`);
          console.log(chalk.green('\n节点状态:'));
          result.nodes.forEach(node => {
            console.log(`  ${node.nodeId}: ${node.peerId.slice(0, 20)}... | peers: ${node.peers} | ${node.multiaddr}`);
          });

          // 显示 floodsub 广播能力
          const network = await import('./libp2p-network.js');
          console.log(chalk.green('\nfloodsub 广播通道:'));
          console.log(`  topic: ipfs-storage-network`);
          console.log(`  订阅节点: ${result.nodes.length}`);
          console.log(`  状态: ${chalk.green('就绪')}（所有节点已订阅，可实时广播）`);

          // 启动文件自动同步监听
          const fileSync = await import('./file-sync.js');
          const syncListener = fileSync.startFileSyncListener(network, {
            onSync: (info) => {
              console.log(chalk.cyan(`  [同步] ${info.nodeId} ← ${info.fromNode}: ${info.cid.slice(0, 20)}...`));
            }
          });
          console.log(chalk.green('\n文件自动同步:'));
          console.log(`  状态: ${chalk.green('已启用')}（上传文件后自动分发到所有在线节点）`);

          // 定时自动伸缩
          let autoscaleTimer = null;
          if (autoscaleInterval > 0) {
            const { AutoScaler } = await import('./auto-scaler.js');
            const scaler = new AutoScaler();
            console.log(chalk.green('\n定时自动伸缩:'));
            console.log(`  状态: ${chalk.green('已启用')}（每 ${autoscaleInterval} 秒检查一次）`);

            autoscaleTimer = setInterval(async () => {
              try {
                const evalResult = await scaler.evaluate(nodeManager);
                const timestamp = new Date().toLocaleTimeString();
                if (evalResult.action === 'scale_down') {
                  console.log(chalk.yellow(`  [${timestamp}] ⬇ 缩容: ${evalResult.reason}`));
                  evalResult.details.forEach(d => {
                    console.log(chalk.yellow(`    ■ ${d.nodeId} 已停止（数据保留）`));
                  });
                } else if (evalResult.action === 'scale_up') {
                  console.log(chalk.green(`  [${timestamp}] ⬆ 扩容: ${evalResult.reason}`));
                  evalResult.details.forEach(d => {
                    const verb = d.action === 'restored' ? '已恢复' : '已新增';
                    console.log(chalk.green(`    ■ ${d.nodeId} ${verb}`));
                  });
                } else {
                  console.log(chalk.gray(`  [${timestamp}] ● 伸缩检查: ${evalResult.reason}`));
                }
              } catch (e) {
                console.log(chalk.red(`  [伸缩检查失败] ${e.message}`));
              }
            }, autoscaleInterval * 1000);
          } else {
            console.log(chalk.gray('\n定时自动伸缩: 已禁用'));
          }

          if (duration > 0) {
            console.log(chalk.yellow(`\n将在 ${duration} 秒后自动停止...`));
            await new Promise(r => setTimeout(r, duration * 1000));
            syncListener.unsubscribe();
            if (autoscaleTimer) clearInterval(autoscaleTimer);
            console.log(chalk.green('P2P 网络已停止'));
            process.exit(0);
          } else {
            console.log(chalk.yellow('\n守护进程运行中，按 Ctrl+C 停止'));
            // 保持进程运行
            await new Promise(() => {});
          }
        } catch (err) {
          spinner.fail(`启动失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('peers')
      .description('查看节点 P2P 对等连接')
      .argument('<node-id>', '节点 ID')
      .action(async (nodeId) => {
        const network = await import('./libp2p-network.js');
        const peers = network.getPeers(nodeId);
        if (peers.length === 0) {
          console.log(chalk.yellow(`节点 ${nodeId} 无活跃连接（可能需要先运行 daemon）`));
          return;
        }
        console.log(chalk.green(`节点 ${nodeId} 的对等连接:`));
        peers.forEach(peer => {
          console.log(`  ${peer.peerId} | 连接数: ${peer.connections}`);
        });
      })
  )
  .addCommand(
    new Command('start')
      .description('启动存储节点（未指定数量时自动根据硬件评估）')
      .argument('[node-id]', '节点 ID')
      .option('-n, --count <number>', '节点数量（不指定则自动评估）')
      .action(async (nodeId, options) => {
        if (nodeId) {
          const spinner = ora(`启动节点 ${nodeId}...`).start();
          try {
            const config = await nodeManager.startNode(nodeId);
            spinner.succeed(`节点 ${nodeId} 启动成功`);
            console.log(chalk.green('\n节点配置:'));
            console.log(`  PeerID: ${config.peerId}`);
            console.log(`  配额: ${nodeManager.formatBytes(config.quota)}`);
            console.log(`  端口: ${config.port}`);
          } catch (err) {
            spinner.fail(`启动失败: ${err.message}`);
            process.exit(1);
          }
        } else {
          const count = options.count ? parseInt(options.count) : null;
          const assessed = count === null ? await nodeManager.getRecommendedNodeCount() : count;
          const spinner = ora(count === null
            ? `硬件评估推荐 ${assessed} 个节点，启动中...`
            : `启动 ${assessed} 个存储节点...`
          ).start();
          try {
            const result = await nodeManager.startCluster(count);
            const actualCount = result.nodes.length;
            spinner.succeed(`${actualCount} 个节点启动成功${count === null ? '（硬件自动评估）' : ''}`);
            console.log(chalk.green('\n节点列表:'));
            result.nodes.forEach(node => {
              console.log(`  ${node.nodeId}: ${node.peerId} (配额: ${nodeManager.formatBytes(node.quota)})`);
            });
            console.log(chalk.green('\n集群配额:'));
            console.log(`  单节点: ${result.quota.quotaHuman}`);
            console.log(`  总计: ${result.quota.totalQuotaHuman}`);
          } catch (err) {
            spinner.fail(`启动失败: ${err.message}`);
            process.exit(1);
          }
        }
      })
  )
  .addCommand(
    new Command('stop')
      .description('停止节点')
      .argument('<node-id>', '节点 ID')
      .action(async (nodeId) => {
        const spinner = ora(`停止节点 ${nodeId}...`).start();
        try {
          const result = await nodeManager.stopNode(nodeId);
          if (result.success) {
            spinner.succeed(`节点 ${nodeId} 已停止`);
          } else {
            spinner.fail(result.error);
          }
        } catch (err) {
          spinner.fail(`停止失败: ${err.message}`);
        }
      })
  )
  .addCommand(
    new Command('list')
      .description('列出所有节点')
      .action(async () => {
        const nodes = await nodeManager.listNodes();
        if (nodes.length === 0) {
          console.log(chalk.yellow('暂无节点，请先运行 init 和 node start'));
          return;
        }
        console.log(chalk.green('节点列表:'));
        nodes.forEach(node => {
          const status = node.status === 'running' 
            ? chalk.green('运行中') 
            : chalk.red('已停止');
          console.log(`  ${node.nodeId}: ${status} | PeerID: ${node.peerId} | 配额: ${nodeManager.formatBytes(node.quota)} | 已用: ${nodeManager.formatBytes(node.usedSpace || 0)}`);
        });
      })
  )
  .addCommand(
    new Command('add')
      .description('添加新节点（扩容）')
      .action(async () => {
        const spinner = ora('添加新节点...').start();
        try {
          const config = await nodeManager.addNode();
          spinner.succeed(`新节点 ${config.nodeId} 添加成功`);
          console.log(chalk.green('\n节点配置:'));
          console.log(`  PeerID: ${config.peerId}`);
          console.log(`  配额: ${nodeManager.formatBytes(config.quota)}`);
        } catch (err) {
          spinner.fail(`添加失败: ${err.message}`);
        }
      })
  )
  .addCommand(
    new Command('remove')
      .description('移除节点（--migrate 先迁移数据再删除）')
      .argument('<node-id>', '节点 ID')
      .option('--migrate', '移除前先将数据迁移到其他节点')
      .action(async (nodeId, options) => {
        const spinner = ora(options.migrate
          ? `迁移节点 ${nodeId} 数据并移除...`
          : `移除节点 ${nodeId}...`
        ).start();
        try {
          const result = await nodeManager.removeNode(nodeId, { migrate: options.migrate });
          if (result.success) {
            spinner.succeed(`节点 ${nodeId} 已移除`);
            console.log(`剩余节点数: ${result.remainingNodes}`);
            if (result.migration) {
              console.log(chalk.green('\n数据迁移结果:'));
              console.log(`  成功迁移: ${result.migration.migrated} 个文件`);
              console.log(`  跳过(已有副本): ${result.migration.skipped} 个`);
              if (result.migration.failed > 0) {
                console.log(chalk.red(`  失败: ${result.migration.failed} 个`));
              }
            }
          } else {
            spinner.fail(result.error);
          }
        } catch (err) {
          spinner.fail(`移除失败: ${err.message}`);
        }
      })
  )
  .addCommand(
    new Command('status')
      .description('查看节点状态')
      .argument('<node-id>', '节点 ID')
      .action(async (nodeId) => {
        const detail = await networkMonitor.getNodeDetail(nodeId);
        if (!detail) {
          console.log(chalk.red(`节点 ${nodeId} 不存在`));
          process.exit(1);
        }
        console.log(chalk.green(`节点 ${nodeId} 状态:`));
        console.log(`  PeerID: ${detail.peerId}`);
        console.log(`  状态: ${detail.status === 'running' ? chalk.green('运行中') : chalk.red('已停止')}`);
        console.log(`  配额: ${detail.quotaHuman}`);
        console.log(`  已用: ${detail.usedHuman}`);
        console.log(`  存储文件数: ${detail.storedFiles.length}`);
      })
  )
  .addCommand(
    new Command('autoscale')
      .description('节点自动伸缩管理')
      .addCommand(
        new Command('run')
          .description('执行一次伸缩决策（根据使用率自动缩容/扩容）')
          .action(async () => {
            const spinner = ora('评估集群负载...').start();
            try {
              const { AutoScaler } = await import('./auto-scaler.js');
              const scaler = new AutoScaler();
              const result = await scaler.evaluate(nodeManager);
              spinner.stop();

              if (result.action === 'scale_down') {
                console.log(chalk.yellow(`⬇ 缩容: ${result.reason}`));
                result.details.forEach(d => {
                  console.log(`  ${chalk.red('■')} ${d.nodeId} 已停止 (已用 ${nodeManager.formatBytes(d.usedSpace)}, ${d.fileCount} 个文件，数据保留可恢复)`);
                });
              } else if (result.action === 'scale_up') {
                console.log(chalk.green(`⬆ 扩容: ${result.reason}`));
                result.details.forEach(d => {
                  const verb = d.action === 'restored' ? '已恢复' : '已新增';
                  console.log(`  ${chalk.green('■')} ${d.nodeId} ${verb}`);
                });
              } else {
                console.log(chalk.cyan(`● ${result.reason}`));
              }

              const newStats = await scaler.getClusterStats();
              console.log(chalk.green('\n伸缩后状态:'));
              console.log(`  运行节点: ${newStats.running.length}`);
              console.log(`  已停止: ${newStats.stopped.length}`);
              console.log(`  使用率: ${(newStats.usageRate * 100).toFixed(1)}%`);
            } catch (err) {
              spinner.fail(`伸缩失败: ${err.message}`);
              process.exit(1);
            }
          })
      )
      .addCommand(
        new Command('status')
          .description('查看伸缩状态和配置')
          .action(async () => {
            const { AutoScaler } = await import('./auto-scaler.js');
            const scaler = new AutoScaler();
            const status = await scaler.getStatus();

            console.log(chalk.green('═══ 节点自动伸缩状态 ═══'));
            console.log(`  运行节点: ${status.runningNodes}`);
            console.log(`  已停止节点: ${status.stoppedNodes}`);
            console.log(`  总配额: ${scaler.formatBytes(status.totalQuota)}`);
            console.log(`  已使用: ${scaler.formatBytes(status.totalUsed)}`);
            console.log(`  使用率: ${status.usagePercent}`);
            console.log(`  建议: ${chalk.cyan(status.recommendation)}`);

            console.log(chalk.green('\n═══ 伸缩配置 ═══'));
            console.log(`  启用状态: ${status.config.enabled ? chalk.green('已启用') : chalk.red('已禁用')}`);
            console.log(`  扩容阈值: ≤ ${(status.config.scaleUpThreshold * 100).toFixed(0)}%`);
            console.log(`  缩容阈值: ≥ ${(status.config.scaleDownThreshold * 100).toFixed(0)}%`);
            console.log(`  节点范围: ${status.config.minNodes} - ${status.config.maxNodes}`);
            console.log(`  每次伸缩: ${status.config.scaleStep} 个节点`);
          })
      )
      .addCommand(
        new Command('config')
          .description('修改伸缩配置')
          .option('--up <percent>', '扩容阈值百分比（如 50）')
          .option('--down <percent>', '缩容阈值百分比（如 80）')
          .option('--min <number>', '最小节点数')
          .option('--max <number>', '最大节点数')
          .option('--step <number>', '每次伸缩节点数')
          .option('--disable', '禁用自动伸缩')
          .option('--enable', '启用自动伸缩')
          .action(async (options) => {
            const { AutoScaler } = await import('./auto-scaler.js');
            const scaler = new AutoScaler();
            const config = await scaler.getConfig();

            if (options.up) config.scaleUpThreshold = parseInt(options.up) / 100;
            if (options.down) config.scaleDownThreshold = parseInt(options.down) / 100;
            if (options.min) config.minNodes = parseInt(options.min);
            if (options.max) config.maxNodes = parseInt(options.max);
            if (options.step) config.scaleStep = parseInt(options.step);
            if (options.disable) config.enabled = false;
            if (options.enable) config.enabled = true;

            await scaler.saveConfig(config);
            console.log(chalk.green('伸缩配置已更新:'));
            console.log(`  启用: ${config.enabled}`);
            console.log(`  扩容阈值: ≤ ${(config.scaleUpThreshold * 100).toFixed(0)}%`);
            console.log(`  缩容阈值: ≥ ${(config.scaleDownThreshold * 100).toFixed(0)}%`);
            console.log(`  节点范围: ${config.minNodes} - ${config.maxNodes}`);
            console.log(`  每次伸缩: ${config.scaleStep} 个节点`);
          })
      )
  );

// ==================== P2P 网络命令 ====================

program
  .command('p2p')
  .description('P2P 网络通信')
  .addCommand(
    new Command('broadcast')
      .description('通过 floodsub 广播消息到所有节点')
      .argument('<message>', '广播消息内容')
      .option('-n, --node <node-id>', '发送节点 ID', 'node-0')
      .action(async (message, options) => {
        const spinner = ora('广播消息...').start();
        try {
          const network = await import('./libp2p-network.js');
          const activeNodes = network.getActiveNodes();
          if (activeNodes.length === 0) {
            spinner.fail('P2P 网络未启动，请先运行 node daemon');
            process.exit(1);
          }
          const result = await network.broadcastGossip(options.node, {
            type: 'broadcast',
            content: message,
            timestamp: new Date().toISOString()
          });
          spinner.succeed(`广播完成，${result.recipients} 个节点收到`);
          console.log(`  topic: ${result.topic}`);
          console.log(`  recipients: ${result.recipients}`);
        } catch (err) {
          spinner.fail(`广播失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('listen')
      .description('监听 floodsub 广播消息')
      .option('-n, --node <node-id>', '监听节点 ID', 'node-0')
      .option('--duration <seconds>', '监听时长（秒）', '10')
      .action(async (options) => {
        const network = await import('./libp2p-network.js');
        const activeNodes = network.getActiveNodes();
        if (activeNodes.length === 0) {
          console.log(chalk.red('P2P 网络未启动，请先运行 node daemon'));
          process.exit(1);
        }
        const duration = parseInt(options.duration);
        console.log(chalk.green(`节点 ${options.node} 开始监听 floodsub 广播（${duration} 秒）...`));

        let count = 0;
        const unsubscribe = network.subscribeGossip(options.node, (msg, from) => {
          count++;
          console.log(chalk.cyan(`  [${count}] from: ${from?.slice(0, 20)}... | ${JSON.stringify(msg)}`));
        });

        await new Promise(r => setTimeout(r, duration * 1000));
        unsubscribe();
        console.log(chalk.green(`监听结束，共收到 ${count} 条消息`));
        process.exit(0);
      })
  );

// ==================== 文件同步命令 ====================

program
  .command('sync')
  .description('文件同步管理')
  .addCommand(
    new Command('full')
      .description('全量同步：将所有文件分发到所有在线节点')
      .action(async () => {
        const spinner = ora('执行全量同步...').start();
        try {
          const fileSync = await import('./file-sync.js');
          const result = await fileSync.fullSync();
          if (result.synced === 0) {
            spinner.succeed('所有节点已同步，无需额外分发');
          } else {
            spinner.succeed(`全量同步完成，新分发 ${result.synced} 个文件副本`);
            result.details.forEach(d => {
              console.log(`  ${d.nodeId} ← ${d.fromNode}: ${d.cid.slice(0, 20)}...`);
            });
          }
        } catch (err) {
          spinner.fail(`同步失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('status')
      .description('查看文件同步覆盖率')
      .action(async () => {
        const fileSync = await import('./file-sync.js');
        const status = await fileSync.getSyncStatus();
        console.log(chalk.green('═══ 文件同步状态 ═══'));
        console.log(`  文件总数: ${status.files}`);
        console.log(`  节点总数: ${status.nodes}`);
        console.log(`  总副本数: ${status.totalReplicas}`);
        console.log(`  同步覆盖率: ${status.coverage}`);
        if (status.coverage === '100.0%') {
          console.log(chalk.green('\n  所有文件已完整分发到所有节点'));
        } else {
          console.log(chalk.yellow('\n  部分文件尚未分发到所有节点，可运行 sync full 补全'));
        }
      })
  );

// ==================== 容量管理命令 ====================

program
  .command('capacity')
  .description('查看集群容量状态（使用率、剩余空间、各节点分布）')
  .action(async () => {
    try {
      const report = await fileOps.getCapacityReport();

      if (report.nodeCount === 0) {
        console.log(chalk.red('无在线存储节点，请先运行 node start'));
        process.exit(1);
      }

      const pct = (report.usageRate * 100).toFixed(1);
      const levelMap = {
        healthy: { icon: '🟢', label: '健康', color: chalk.green },
        caution: { icon: '🟡', label: '注意', color: chalk.yellow },
        warning: { icon: '🟠', label: '预警', color: chalk.hex('#FF8C00') },
        critical: { icon: '🔴', label: '危险', color: chalk.red }
      };
      const lv = levelMap[report.level] || levelMap.healthy;

      console.log(chalk.bold('\n集群容量概览'));
      console.log(`  状态: ${lv.icon} ${lv.color(lv.label)}`);
      console.log(`  节点数: ${report.nodeCount}`);
      console.log(`  总容量: ${fileOps.formatBytes(report.totalQuota)}`);
      console.log(`  已使用: ${fileOps.formatBytes(report.totalUsed)} (${pct}%)`);
      console.log(`  剩余:   ${fileOps.formatBytes(report.availableBytes)}`);

      // 使用率进度条
      const barLen = 30;
      const filled = Math.round(report.usageRate * barLen);
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
      console.log(`  ${lv.color(bar)} ${pct}%`);

      // 各节点容量分布
      console.log(chalk.bold('\n节点容量分布'));
      console.log(`  ${'节点'.padEnd(10)} ${'已用'.padStart(10)} ${'剩余'.padStart(10)} ${'使用率'.padStart(8)}  分布`);
      console.log(`  ${'─'.repeat(60)}`);

      for (const node of report.nodes) {
        const nodePct = (node.usageRate * 100).toFixed(1);
        const nodeBarLen = 20;
        const nodeFilled = Math.round(node.usageRate * nodeBarLen);
        let nodeColor = chalk.green;
        if (node.usageRate > 0.9) nodeColor = chalk.red;
        else if (node.usageRate > 0.8) nodeColor = chalk.hex('#FF8C00');
        else if (node.usageRate > 0.6) nodeColor = chalk.yellow;
        const nodeBar = nodeColor('█'.repeat(nodeFilled) + '░'.repeat(nodeBarLen - nodeFilled));
        console.log(`  ${node.nodeId.padEnd(10)} ${fileOps.formatBytes(node.usedSpace).padStart(10)} ${fileOps.formatBytes(node.freeSpace).padStart(10)} ${(nodePct + '%').padStart(8)}  ${nodeBar}`);
      }

      // 建议
      if (report.level === 'critical') {
        console.log(chalk.red('\n⚠️  集群使用率超过 90%，副本修复可能失败。建议：删除不需要的文件或扩容节点。'));
      } else if (report.level === 'warning') {
        console.log(chalk.hex('#FF8C00')('\n⚠️  集群使用率超过 80%，建议关注容量增长趋势。'));
      }
      console.log('');
    } catch (err) {
      console.log(chalk.red(`容量查询失败: ${err.message}`));
      process.exit(1);
    }
  });

// ==================== 升级管理命令 ====================

program
  .command('upgrade')
  .description('节点滚动升级管理（前置检查、逐节点升级、验证、回滚）')
  .option('--check', '前置检查：验证是否满足升级条件')
  .option('--run', '执行滚动升级')
  .option('--rollback', '回滚到升级前状态')
  .option('--status', '查看升级状态')
  .option('--resume', '从中断处恢复升级（自动检测并继续）')
  .option('--dry-run', '模拟升级流程（不实际停止/重启节点）')
  .option('-s, --script <path>', '每个节点停止后执行的升级脚本路径')
  .option('--token <token>', '认证 token（多用户模式必需）')
  .action(async (options) => {
    try {
      // 高危操作鉴权：--run / --rollback / --resume 需要有效认证
      if (options.run || options.rollback || options.resume) {
        const { requireAuth } = await import('./security.js');
        const auth = await requireAuth(options.token);
        if (!auth.allowed) {
          console.log(chalk.red(`⛔ 鉴权失败: ${auth.reason}`));
          process.exit(1);
        }
      }

      if (options.check) {
        // 前置检查
        const spinner = ora('执行升级前置检查...').start();
        const result = await upgradeManager.preCheck();

        if (result.canUpgrade) {
          spinner.succeed('前置检查通过，可以执行升级');
        } else {
          spinner.fail('前置检查未通过');
        }

        console.log(chalk.green('\n集群状态:'));
        console.log(`  节点总数: ${result.stats.totalNodes}`);
        console.log(`  在线节点: ${result.stats.runningNodes}`);
        console.log(`  已停止: ${result.stats.stoppedNodes}`);
        console.log(`  使用率: ${(result.stats.usageRate * 100).toFixed(1)}%`);
        console.log(`  文件总数: ${result.stats.totalFiles}`);
        console.log(`  降级文件: ${result.stats.degradedFiles}（副本 ≤ 1）`);
        console.log(`  不可用文件: ${result.stats.unavailableFiles}（副本 = 0）`);

        if (result.issues.length > 0) {
          console.log(chalk.red('\n阻塞问题:'));
          result.issues.forEach(i => console.log(`  ✖ ${i}`));
        }
        if (result.warnings.length > 0) {
          console.log(chalk.yellow('\n警告:'));
          result.warnings.forEach(w => console.log(`  ⚠ ${w}`));
        }
        if (result.canUpgrade && result.warnings.length === 0) {
          console.log(chalk.green('\n  所有检查项通过，可安全执行升级'));
        }

      } else if (options.run) {
        // 执行滚动升级
        const spinner = ora('执行滚动升级...').start();
        const result = await upgradeManager.rollingUpgrade({
          script: options.script,
          dryRun: options.dryRun || false,
          onProgress: (msg) => { spinner.text = `滚动升级: ${msg}`; }
        });

        if (result.success) {
          spinner.succeed(`滚动升级完成（${result.upgraded}/${result.totalNodes} 节点）`);
        } else {
          spinner.warn(`升级完成但有 ${result.failed} 个节点失败`);
        }

        if (result.dryRun) {
          console.log(chalk.yellow('\n  [模拟模式] 未实际执行停止/重启'));
        }

        console.log(chalk.green('\n升级结果:'));
        for (const r of result.results) {
          const icon = r.status === 'upgraded' ? '✅' : r.status === 'simulated' ? '🔵' : '❌';
          let line = `  ${icon} ${r.nodeId}: ${r.status}`;
          if (r.blocks !== undefined) line += ` (${r.blocks} blocks 验证通过)`;
          if (r.error) line += ` - ${r.error}`;
          console.log(line);
          if (r.scriptOutput) console.log(`     脚本输出: ${r.scriptOutput}`);
        }

      } else if (options.resume) {
        // 从中断处恢复
        const spinner = ora('检测中断状态并恢复升级...').start();
        const result = await upgradeManager.resume({
          onProgress: (msg) => { spinner.text = `恢复升级: ${msg}`; }
        });

        if (!result.resumed) {
          spinner.fail(result.error);
          console.log(chalk.red(`  ${result.error}`));
          return;
        }

        if (result.success) {
          spinner.succeed(`恢复升级完成（${result.totalCompleted}/${result.totalNodes} 节点）`);
        } else {
          spinner.warn(`恢复完成但有 ${result.failed} 个节点失败`);
        }

        console.log(chalk.green('\n恢复详情:'));
        console.log(`  修复中断节点: ${result.repairedNodes} 个`);
        console.log(`  继续升级: ${result.remainingUpgraded} 个`);

        for (const r of result.results) {
          const icon = r.status === 'upgraded' ? '✅' : r.status === 'repaired' ? '🔧' : '❌';
          let line = `  ${icon} ${r.nodeId}: ${r.status}`;
          if (r.blocks !== undefined) line += ` (${r.blocks} blocks)`;
          if (r.error) line += ` - ${r.error}`;
          console.log(line);
        }

      } else if (options.rollback) {
        // 回滚
        const spinner = ora('回滚升级...').start();
        const result = await upgradeManager.rollback();

        if (result.success) {
          spinner.succeed(`回滚完成（${result.restored} 个节点已恢复）`);
        } else {
          spinner.fail(`回滚失败: ${result.error || `${result.failed} 个节点恢复失败`}`);
          if (result.failedNodes) {
            result.failedNodes.forEach(f => console.log(`  ✖ ${f.nodeId}: ${f.error}`));
          }
        }

      } else if (options.status) {
        // 查看状态
        const status = await upgradeManager.getStatus();
        if (!status.hasUpgrade) {
          console.log(chalk.gray('无升级记录'));
          return;
        }

        console.log(chalk.bold('\n升级状态:'));
        console.log(`  状态: ${status.status}`);
        console.log(`  开始时间: ${status.startedAt}`);
        if (status.completedAt) console.log(`  完成时间: ${status.completedAt}`);
        if (status.rolledBackAt) console.log(`  回滚时间: ${status.rolledBackAt}`);
        console.log(`  总节点: ${status.totalNodes}`);
        console.log(`  已完成: ${(status.completedNodes || []).length}`);
        console.log(`  失败: ${(status.failedNodes || []).length}`);
        if (status.script) console.log(`  升级脚本: ${status.script}`);
        if (status.dryRun) console.log(`  模式: 模拟`);

      } else {
        console.log('请指定操作: --check / --run / --resume / --rollback / --status');
        console.log('示例:');
        console.log('  node scripts/cli.js upgrade --check');
        console.log('  node scripts/cli.js upgrade --run --script ./my-upgrade.js');
        console.log('  node scripts/cli.js upgrade --resume   # 从中断处继续');
        console.log('  node scripts/cli.js upgrade --rollback');
      }
    } catch (err) {
      console.log(chalk.red(`升级操作失败: ${err.message}`));
      process.exit(1);
    }
  });

// ==================== 安全命令 ====================

program
  .command('whitelist')
  .description('P2P 节点白名单管理（启用后仅允许白名单内的 PeerId 连接）')
  .option('--enable', '启用白名单')
  .option('--disable', '禁用白名单')
  .option('--add <peerId>', '添加 PeerId 到白名单')
  .option('--remove <peerId>', '从白名单移除 PeerId')
  .option('--list', '查看白名单状态')
  .action(async (options) => {
    try {
      const { loadWhitelist, saveWhitelist } = await import('./security.js');
      let wl = await loadWhitelist();

      if (options.enable) {
        wl.enabled = true;
        await saveWhitelist(wl);
        console.log(chalk.green('白名单已启用（仅允许白名单内的节点连接）'));
      } else if (options.disable) {
        wl.enabled = false;
        await saveWhitelist(wl);
        console.log(chalk.yellow('白名单已禁用（允许所有节点连接）'));
      } else if (options.add) {
        if (!wl.peerIds.includes(options.add)) {
          wl.peerIds.push(options.add);
          await saveWhitelist(wl);
        }
        console.log(chalk.green(`已添加: ${options.add.slice(0, 30)}...`));
        console.log(`  白名单共 ${wl.peerIds.length} 个节点，状态: ${wl.enabled ? '启用' : '禁用'}`);
      } else if (options.remove) {
        wl.peerIds = wl.peerIds.filter(id => id !== options.remove);
        await saveWhitelist(wl);
        console.log(chalk.green(`已移除: ${options.remove.slice(0, 30)}...`));
        console.log(`  白名单共 ${wl.peerIds.length} 个节点`);
      } else {
        // 默认显示状态
        console.log(chalk.bold('\n白名单状态:'));
        console.log(`  启用: ${wl.enabled ? chalk.green('是') : chalk.yellow('否')}`);
        console.log(`  节点数: ${wl.peerIds.length}`);
        if (wl.peerIds.length > 0) {
          console.log(chalk.bold('\n  PeerId 列表:'));
          wl.peerIds.forEach(id => console.log(`    ${id.slice(0, 40)}...`));
        }
        if (!wl.enabled) {
          console.log(chalk.gray('\n  提示: 使用 --enable 启用白名单后，仅白名单内的节点可连接'));
        }
      }
    } catch (err) {
      console.log(chalk.red(`白名单操作失败: ${err.message}`));
      process.exit(1);
    }
  });

// ==================== 文件操作命令 ====================

program
  .command('upload')
  .description('上传文件到存储网络')
  .argument('<file-path>', '文件路径')
  .option('-e, --encrypt', '加密上传')
  .option('-k, --key <key>', '加密密钥（不推荐，建议用 --key-file 或环境变量 IPFS_STORAGE_KEY）')
  .option('--key-file <path>', '从文件读取加密密钥（文件权限应为 600）')
  .option('-r, --replicas <number>', '副本数（不指定则按冗余配置自动解析）')
  .option('--token <token>', '认证 token（多用户模式必需）')
  .action(async (filePath, options) => {
    // 鉴权守卫
    const { requireAuth } = await import('./security.js');
    const auth = await requireAuth(options.token);
    if (!auth.allowed) {
      console.log(chalk.red(`⛔ 鉴权失败: ${auth.reason}`));
      process.exit(1);
    }

    const spinner = ora(`上传文件 ${filePath}...`).start();
    try {
      const result = await fileOps.upload(filePath, {
        encrypt: options.encrypt,
        key: options.key,
        keyFile: options.keyFile,
        replicas: options.replicas ? parseInt(options.replicas) : undefined
      });
      spinner.succeed('文件上传成功');
      console.log(chalk.green('\n上传结果:'));
      console.log(`  CID: ${chalk.cyan(result.cid)}`);
      console.log(`  文件名: ${result.fileName}`);
      console.log(`  大小: ${result.sizeHuman}`);
      console.log(`  加密: ${result.encrypted ? '是' : '否'}`);
      console.log(`  副本数: ${result.replicas}/${result.targetReplicas || result.replicas}`);
      console.log(`  冗余来源: ${result.redundancySource === 'cli' ? 'CLI 指定' : result.redundancySource === 'global' ? '全局配置' : `规则 ${result.redundancySource?.replace('rule:', '') || ''}`}`);
      console.log(`  存储节点: ${result.storedNodes.join(', ')}`);

      // 容量预警
      if (result.capacityWarning) {
        const w = result.capacityWarning;
        const icon = w.level === 'warning' ? '⚠️' : '💡';
        const color = w.level === 'warning' ? chalk.red : chalk.yellow;
        console.log(color(`\n${icon} ${w.message}`));
        console.log(color(`  集群容量: ${fileOps.formatBytes(w.totalUsed + w.requiredBytes)}/${fileOps.formatBytes(w.totalQuota)}（上传后使用率 ${(w.usageAfter * 100).toFixed(1)}%）`));
      }

      // 自动同步：将文件分发到所有 running 状态的节点
      // 注意：容量预警时跳过自动同步，避免同步副本进一步挤占空间导致修复失败
      if (!result.capacityWarning) {
        try {
          const fileSync = await import('./file-sync.js');
          const fileInfo = await fileOps.getFileIndex(result.cid);
          const syncResult = await fileSync.localSync(fileInfo);
          if (syncResult.success && syncResult.syncedNodes.length > 0) {
            console.log(chalk.green(`\n  文件同步: 已自动分发到 ${syncResult.syncedNodes.join(', ')}`));
          } else if (syncResult.success) {
            console.log(chalk.green(`\n  文件同步: 所有 ${syncResult.totalNodes} 个在线节点已有副本`));
          }
        } catch (e) {
          // 同步失败不影响上传结果
        }
      }

      console.log(chalk.yellow('\n请保存 CID 地址，用于后续下载'));
    } catch (err) {
      spinner.fail(`上传失败: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('download')
  .description('从存储网络下载文件')
  .argument('<cid>', '文件 CID')
  .option('-o, --output <path>', '输出路径')
  .option('-d, --decrypt', '解密下载')
  .option('-k, --key <key>', '解密密钥（不推荐，建议用 --key-file 或环境变量 IPFS_STORAGE_KEY）')
  .option('--key-file <path>', '从文件读取解密密钥（文件权限应为 600）')
  .option('--token <token>', '认证 token（多用户模式必需）')
  .action(async (cid, options) => {
    // 鉴权守卫
    const { requireAuth } = await import('./security.js');
    const auth = await requireAuth(options.token);
    if (!auth.allowed) {
      console.log(chalk.red(`⛔ 鉴权失败: ${auth.reason}`));
      process.exit(1);
    }

    const spinner = ora(`下载文件 ${cid}...`).start();
    try {
      const result = await fileOps.download(cid, {
        output: options.output,
        decrypt: options.decrypt,
        key: options.key,
        keyFile: options.keyFile
      });
      spinner.succeed('文件下载成功');
      console.log(chalk.green('\n下载结果:'));
      console.log(`  CID: ${result.cid}`);
      console.log(`  输出路径: ${result.outputPath}`);
      console.log(`  大小: ${result.sizeHuman}`);
    } catch (err) {
      spinner.fail(`下载失败: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('info')
  .description('查看文件信息')
  .argument('<cid>', '文件 CID')
  .action(async (cid) => {
    const result = await fileOps.getInfo(cid);
    if (!result.success) {
      console.log(chalk.red(result.error));
      process.exit(1);
    }
    console.log(chalk.green('文件信息:'));
    console.log(`  CID: ${result.cid}`);
    console.log(`  文件名: ${result.fileName}`);
    console.log(`  大小: ${result.sizeHuman}`);
    console.log(`  加密: ${result.encrypted ? '是' : '否'}`);
    console.log(`  副本数: ${result.replicas}/${result.targetReplicas || result.replicas}`);
    console.log(`  最小副本: ${result.minReplicas || '-'}`);
    console.log(`  放置策略: ${result.placement || '-'}`);
    console.log(`  修复优先级: ${result.repairPriority || '-'}`);
    console.log(`  存储节点: ${result.storedNodes.join(', ')}`);
    console.log(`  上传时间: ${result.uploadedAt}`);
  });

program
  .command('files')
  .description('列出所有存储的文件')
  .action(async () => {
    const files = await fileOps.listFiles();
    if (files.length === 0) {
      console.log(chalk.yellow('暂无文件'));
      return;
    }
    console.log(chalk.green('文件列表:'));
    files.forEach(file => {
      console.log(`  ${file.fileName} | ${file.sizeHuman} | ${file.encrypted ? '加密' : '明文'} | CID: ${file.cid}`);
    });
  });

program
  .command('delete')
  .description('删除文件')
  .argument('<cid>', '文件 CID')
  .option('--token <token>', '认证 token（多用户模式必需）')
  .action(async (cid, options) => {
    // 鉴权守卫
    const { requireAuth } = await import('./security.js');
    const auth = await requireAuth(options.token);
    if (!auth.allowed) {
      console.log(chalk.red(`⛔ 鉴权失败: ${auth.reason}`));
      process.exit(1);
    }

    const spinner = ora(`删除文件 ${cid}...`).start();
    try {
      const result = await fileOps.deleteFile(cid);
      if (result.success) {
        spinner.succeed('文件已删除');
      } else {
        spinner.fail(result.error);
      }
    } catch (err) {
      spinner.fail(`删除失败: ${err.message}`);
    }
  });

// ==================== 加密管理命令 ====================

program
  .command('encrypt')
  .description('加密管理')
  .addCommand(
    new Command('keygen')
      .description('生成加密密钥')
      .action(async () => {
        const keyInfo = fileOps.generateKey();
        console.log(chalk.green('加密密钥已生成:'));
        console.log(`  密钥: ${chalk.cyan(keyInfo.key)}`);
        console.log(`  算法: ${keyInfo.algorithm}`);
        console.log(`  创建时间: ${keyInfo.createdAt}`);
        console.log(chalk.yellow('\n⚠️ 请妥善保管密钥，丢失将无法解密文件'));
      })
  );

// ==================== 网络管理命令 ====================

program
  .command('network')
  .description('网络管理')
  .addCommand(
    new Command('status')
      .description('查看网络状态')
      .action(async () => {
        const status = await networkMonitor.getNetworkStatus();
        
        console.log(chalk.green('═══ 网络状态 ═══'));
        console.log(`  版本: ${status.network.version}`);
        console.log(`  节点总数: ${status.network.nodeCount}`);
        console.log(`  运行中: ${chalk.green(status.network.runningNodes)}`);
        console.log(`  已停止: ${chalk.red(status.network.stoppedNodes)}`);
        
        console.log(chalk.green('\n═══ 存储容量 ═══'));
        console.log(`  总配额: ${status.storage.totalQuotaHuman}`);
        console.log(`  已使用: ${status.storage.totalUsedHuman}`);
        console.log(`  使用率: ${status.storage.usagePercent}%`);
        
        console.log(chalk.green('\n═══ 文件统计 ═══'));
        console.log(`  文件数: ${status.files.count}`);
        console.log(`  总大小: ${status.files.totalSizeHuman}`);
        
        if (status.nodes.length > 0) {
          console.log(chalk.green('\n═══ 节点详情 ═══'));
          status.nodes.forEach(node => {
            const statusIcon = node.status === 'running' ? '🟢' : '🔴';
            console.log(`  ${statusIcon} ${node.nodeId} | 配额: ${node.quota} | 已用: ${node.used} (${node.usagePercent}%)`);
          });
        }
      })
  )
  .addCommand(
    new Command('health')
      .description('网络健康检查')
      .action(async () => {
        const health = await networkMonitor.healthCheck();
        console.log(chalk.green('网络健康检查:'));
        console.log(`  总节点数: ${health.totalNodes}`);
        console.log(`  健康节点: ${chalk.green(health.healthyNodes)}`);
        console.log(`  异常节点: ${chalk.red(health.totalNodes - health.healthyNodes)}`);
        
        health.nodes.forEach(node => {
          const icon = node.healthy ? '✅' : '❌';
          console.log(`  ${icon} ${node.nodeId} | 状态: ${node.status} | 块数: ${node.blockCount}`);
        });
      })
  )
  .addCommand(
    new Command('forecast')
      .description('容量预测')
      .action(async () => {
        const forecast = await networkMonitor.capacityForecast();
        console.log(chalk.green('容量预测:'));
        console.log(`  当前使用: ${forecast.currentUsage}`);
        console.log(`  剩余空间: ${forecast.remaining}`);
        console.log(`  使用率: ${forecast.usageRate}`);
        console.log(`  建议: ${forecast.recommendation}`);
      })
  );

// ==================== ACP 协议命令 ====================

program
  .command('acp')
  .description('ACP 智能体通信协议管理')
  .addCommand(
    new Command('init')
      .description('初始化 ACP 协议层')
      .action(async () => {
        const spinner = ora('初始化 ACP 协议层...').start();
        try {
          const config = await acpProtocol.init();
          spinner.succeed('ACP 协议层初始化成功');
          console.log(chalk.green('\nACP 配置:'));
          console.log(`  协议版本: ${config.protocol} v${config.version}`);
          console.log(`  规范版本: ${config.specVersion}`);
          console.log(`  传输层: ${config.transport.join(', ')}`);
          console.log(`  加密: ${config.encryption}`);
        } catch (err) {
          spinner.fail(`初始化失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('register')
      .description('注册 Agent 身份（AID）')
      .argument('<node-id>', '节点 ID')
      .argument('<agent-name>', 'Agent 名称')
      .option('-c, --capabilities <caps>', '能力列表（逗号分隔）', '')
      .action(async (nodeId, agentName, options) => {
        const spinner = ora(`注册 Agent ${agentName}...`).start();
        try {
          const capabilities = options.capabilities
            ? options.capabilities.split(',').map(c => c.trim())
            : [];
          const result = await acpProtocol.registerAgent(nodeId, agentName, capabilities);
          spinner.succeed(`Agent ${agentName} 注册成功`);
          console.log(chalk.green('\nAID 信息:'));
          console.log(`  AID: ${chalk.cyan(result.aid.aid)}`);
          console.log(`  节点: ${result.aid.nodeId}`);
          console.log(`  PeerID: ${result.aid.peerId || '未绑定'}`);
          console.log(`  能力: ${result.aid.capabilities.join(', ') || 'storage, retrieval'}`);
        } catch (err) {
          spinner.fail(`注册失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('discover')
      .description('发现网络中的 Agent')
      .option('-c, --capability <cap>', '按能力过滤')
      .action(async (options) => {
        const caps = options.capability ? [options.capability] : [];
        const agents = await acpProtocol.discoverAgents(caps);

        if (agents.length === 0) {
          console.log(chalk.yellow('未发现任何 Agent，请先注册'));
          return;
        }

        console.log(chalk.green(`发现 ${agents.length} 个 Agent:`));
        agents.forEach(agent => {
          console.log(`  ${agent.aid} | ${agent.name} | 能力: ${agent.capabilities.join(', ')} | 状态: ${agent.status}`);
        });
      })
  )
  .addCommand(
    new Command('session')
      .description('会话管理')
      .addCommand(
        new Command('create')
          .description('创建通信会话')
          .argument('<from-aid>', '发起方 AID')
          .argument('<to-aid>', '目标 AID')
          .option('-e, --encrypted', '加密会话')
          .action(async (fromAid, toAid, options) => {
            const spinner = ora('创建会话...').start();
            try {
              const session = await acpProtocol.createSession(fromAid, toAid, {
                encrypted: options.encrypted
              });
              spinner.succeed('会话创建成功');
              console.log(chalk.green('\n会话信息:'));
              console.log(`  会话 ID: ${chalk.cyan(session.sessionId)}`);
              console.log(`  发起方: ${session.from}`);
              console.log(`  目标方: ${session.to}`);
              console.log(`  加密: ${session.encrypted ? '是' : '否'}`);
            } catch (err) {
              spinner.fail(`创建失败: ${err.message}`);
            }
          })
      )
      .addCommand(
        new Command('close')
          .description('关闭会话')
          .argument('<session-id>', '会话 ID')
          .action(async (sessionId) => {
            const result = await acpProtocol.closeSession(sessionId);
            if (result.success) {
              console.log(chalk.green(`会话 ${sessionId} 已关闭，共 ${result.messageCount} 条消息`));
            } else {
              console.log(chalk.red(result.error));
            }
          })
      )
  )
  .addCommand(
    new Command('send')
      .description('发送 ACP 消息')
      .argument('<session-id>', '会话 ID')
      .argument('<content>', '消息内容')
      .option('-t, --type <type>', '消息类型', 'message')
      .option('-k, --key <key>', '加密密钥')
      .action(async (sessionId, content, options) => {
        const spinner = ora('发送消息...').start();
        try {
          let parsedContent = content;
          try {
            parsedContent = JSON.parse(content);
          } catch (e) {
            // 保持为字符串
          }

          const message = await acpProtocol.sendMessage(sessionId, parsedContent, {
            type: options.type,
            key: options.key
          });
          spinner.succeed('消息发送成功');
          console.log(chalk.green('\n消息信息:'));
          console.log(`  消息 ID: ${message.id}`);
          console.log(`  类型: ${message.type}`);
          console.log(`  时间: ${message.timestamp}`);
        } catch (err) {
          spinner.fail(`发送失败: ${err.message}`);
        }
      })
  )
  .addCommand(
    new Command('receive')
      .description('接收 ACP 消息')
      .argument('<session-id>', '会话 ID')
      .option('-n, --limit <number>', '消息数量', '10')
      .action(async (sessionId, options) => {
        try {
          const messages = await acpProtocol.receiveMessages(sessionId, parseInt(options.limit));
          if (messages.length === 0) {
            console.log(chalk.yellow('暂无消息'));
            return;
          }
          console.log(chalk.green(`收到 ${messages.length} 条消息:`));
          messages.forEach(msg => {
            console.log(`  [${msg.timestamp}] ${msg.type}: ${JSON.stringify(msg.content.data).slice(0, 100)}`);
          });
        } catch (err) {
          console.log(chalk.red(`接收失败: ${err.message}`));
        }
      })
  )
  .addCommand(
    new Command('broadcast')
      .description('广播消息到所有 Agent')
      .argument('<from-aid>', '发起方 AID')
      .argument('<content>', '广播内容')
      .option('-t, --type <type>', '消息类型', 'hello')
      .action(async (fromAid, content, options) => {
        const spinner = ora('广播消息...').start();
        try {
          const result = await acpProtocol.broadcast(fromAid, content, { type: options.type });
          spinner.succeed(`广播完成，发送到 ${result.broadcastCount} 个 Agent`);
        } catch (err) {
          spinner.fail(`广播失败: ${err.message}`);
        }
      })
  )
  .addCommand(
    new Command('status')
      .description('查看 ACP 网络状态')
      .action(async () => {
        const status = await acpProtocol.getNetworkStatus();
        console.log(chalk.green('═══ ACP 网络状态 ═══'));
        console.log(`  协议: ${status.protocol} v${status.version}`);
        console.log(`  注册 Agent 数: ${status.registeredAgents}`);
        console.log(`  活跃会话数: ${status.activeSessions}`);
        console.log(`  总消息数: ${status.totalMessages}`);
        console.log(`  传输层: ${status.transport.join(', ')}`);

        if (status.agents.length > 0) {
          console.log(chalk.green('\n═══ 已注册 Agent ═══'));
          status.agents.forEach(agent => {
            console.log(`  ${agent.aid} | ${agent.name} | 能力: ${agent.capabilities.join(', ')}`);
          });
        }
      })
  );

// ==================== 可视化面板命令 ====================

program
  .command('dashboard')
  .description('文件存储状态可视化面板')
  .action(async () => {
    const status = await networkMonitor.getNetworkStatus();
    const files = await fileOps.listFiles();
    const fileSync = await import('./file-sync.js');
    const syncStatus = await fileSync.getSyncStatus();

    const W = 56; // 面板宽度
    const line = '═'.repeat(W);
    const thin = '─'.repeat(W);

    // 标题
    console.log(chalk.cyan(`╔${line}╗`));
    console.log(chalk.cyan('║') + chalk.bold.white('  IPFS 分布式存储网络 · 状态面板'.padEnd(W - 2)) + chalk.cyan('║'));
    console.log(chalk.cyan(`╚${line}╝`));

    // ── 网络概览 ──
    console.log(chalk.green(`\n┌${thin}┐`));
    console.log(chalk.green('│') + chalk.bold(' 网络概览'.padEnd(W - 2)) + chalk.green('│'));
    console.log(chalk.green(`├${thin}┤`));
    const netRows = [
      ['节点总数', `${status.network.nodeCount}`],
      ['运行中', chalk.green(`${status.network.runningNodes}`)],
      ['已停止', status.network.stoppedNodes > 0 ? chalk.red(`${status.network.stoppedNodes}`) : '0'],
      ['文件总数', `${status.files.count}`],
      ['数据总量', status.files.totalSizeHuman],
      ['同步覆盖率', syncStatus.coverage]
    ];
    for (const [label, value] of netRows) {
      const pad = W - 4 - label.length * 2 - value.length;
      console.log(chalk.green('│') + `  ${label}` + ' '.repeat(Math.max(1, pad)) + `${value} ` + chalk.green('│'));
    }
    console.log(chalk.green(`└${thin}┘`));

    // ── 节点存储状态 ──
    console.log(chalk.green(`\n┌${thin}┐`));
    console.log(chalk.green('│') + chalk.bold(' 节点存储状态'.padEnd(W - 2)) + chalk.green('│'));
    console.log(chalk.green(`├${thin}┤`));

    for (const node of status.nodes) {
      const icon = node.status === 'running' ? chalk.green('●') : chalk.red('●');
      const pct = parseFloat(node.usagePercent);
      const barLen = 20;
      const filled = Math.round((pct / 100) * barLen);
      const bar = chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(barLen - filled));
      const pctColor = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;

      console.log(chalk.green('│') + `  ${icon} ${chalk.bold(node.nodeId)}` + ' '.repeat(W - 6 - node.nodeId.length - 2) + `${node.used}/${node.quota} ` + chalk.green('│'));
      console.log(chalk.green('│') + `    ${bar} ${pctColor(node.usagePercent + '%')}` + ' '.repeat(Math.max(1, W - 4 - barLen - 10)) + chalk.green('│'));
    }
    console.log(chalk.green(`└${thin}┘`));

    // ── 文件分布 ──
    console.log(chalk.green(`\n┌${thin}┐`));
    console.log(chalk.green('│') + chalk.bold(' 文件分布'.padEnd(W - 2)) + chalk.green('│'));
    console.log(chalk.green(`├${thin}┤`));

    if (files.length === 0) {
      console.log(chalk.green('│') + chalk.gray('  暂无文件'.padEnd(W - 2)) + chalk.green('│'));
    } else {
      // 表头
      const header = `  ${'文件名'.padEnd(16)}${'大小'.padEnd(10)}${'副本'.padEnd(6)}状态`;
      console.log(chalk.green('│') + chalk.bold(header) + ' '.repeat(Math.max(1, W - 2 - 40)) + chalk.green('│'));
      console.log(chalk.green('│') + chalk.gray('  ' + '─'.repeat(W - 6)) + chalk.green('│'));

      for (const file of files.slice(0, 10)) {
        const name = file.fileName.length > 14 ? file.fileName.slice(0, 12) + '..' : file.fileName;
        const replicas = `${file.storedNodes?.length || file.replicas}/${status.network.nodeCount}`;
        const fullSynced = (file.storedNodes?.length || 0) >= status.network.runningNodes;
        const syncIcon = fullSynced ? chalk.green('✓ 已同步') : chalk.yellow('◐ 部分');
        const enc = file.encrypted ? chalk.magenta(' 🔒') : '';
        const row = `  ${name.padEnd(16)}${file.sizeHuman.padEnd(10)}${replicas.padEnd(6)}${syncIcon}${enc}`;
        console.log(chalk.green('│') + row + ' '.repeat(Math.max(1, W - 2 - 44)) + chalk.green('│'));
      }

      if (files.length > 10) {
        console.log(chalk.green('│') + chalk.gray(`  ... 还有 ${files.length - 10} 个文件`.padEnd(W - 2)) + chalk.green('│'));
      }
    }
    console.log(chalk.green(`└${thin}┘`));

    // ── 容量预测 ──
    const forecast = await networkMonitor.capacityForecast();
    console.log(chalk.green(`\n┌${thin}┐`));
    console.log(chalk.green('│') + chalk.bold(' 容量预测'.padEnd(W - 2)) + chalk.green('│'));
    console.log(chalk.green(`├${thin}┤`));
    console.log(chalk.green('│') + `  已使用: ${forecast.currentUsage}  剩余: ${forecast.remaining}  使用率: ${forecast.usageRate}` + ' '.repeat(Math.max(1, W - 2 - 46)) + chalk.green('│'));
    console.log(chalk.green('│') + `  建议: ${forecast.recommendation}` + ' '.repeat(Math.max(1, W - 2 - forecast.recommendation.length * 2 - 6)) + chalk.green('│'));
    console.log(chalk.green(`└${thin}┘`));
    console.log('');
  });

// ==================== 硬件评估命令 ====================

program
  .command('hardware')
  .description('硬件配置评估')
  .addCommand(
    new Command('assess')
      .description('评估硬件配置，输出推荐节点数（3-100）')
      .action(async () => {
        const spinner = ora('评估硬件配置...').start();
        try {
          const assessment = await nodeManager.getHardwareAssessment();
          spinner.succeed('硬件评估完成');

          console.log(chalk.green('\n═══ 硬件评估报告 ═══'));
          console.log(`  推荐节点数: ${chalk.cyan.bold(assessment.recommendedNodes)} (范围 ${assessment.minNodes}-${assessment.maxNodes})`);
          console.log(`  瓶颈维度: ${chalk.yellow(assessment.bottleneck)}`);
          console.log(`  单节点配额: ${assessment.quotaHuman}`);
          console.log(`  集群总容量: ${assessment.totalCapacityHuman}`);

          console.log(chalk.green('\n═══ CPU ═══'));
          const cpu = assessment.dimensions.cpu;
          console.log(`  核心数: ${cpu.cores}`);
          console.log(`  型号: ${cpu.model}`);
          console.log(`  主频: ${cpu.avgSpeedMHz} MHz`);
          console.log(`  可支撑节点: ${cpu.capacityNodes} (${cpu.weight})`);

          console.log(chalk.green('\n═══ 内存 ═══'));
          const mem = assessment.dimensions.memory;
          console.log(`  总内存: ${mem.totalHuman}`);
          console.log(`  可用: ${mem.freeHuman}`);
          console.log(`  可支撑节点: ${mem.capacityNodes} (${mem.weight})`);

          console.log(chalk.green('\n═══ 磁盘 ═══'));
          const disk = assessment.dimensions.disk;
          console.log(`  总容量: ${disk.totalHuman}`);
          console.log(`  可用: ${disk.freeHuman}`);
          console.log(`  可分配: ${disk.usableHuman}`);
          console.log(`  可支撑节点: ${disk.capacityNodes} (${disk.weight})`);

          console.log(chalk.green('\n═══ 结论 ═══'));
          console.log(`  本机推荐启动 ${chalk.cyan.bold(assessment.recommendedNodes)} 个存储节点`);
          console.log(`  运行 ${chalk.cyan('node start')} 将自动按此配置启动`);
        } catch (err) {
          spinner.fail(`评估失败: ${err.message}`);
          process.exit(1);
        }
      })
  );

// ==================== 索引管理命令 ====================

program
  .command('index')
  .description('分片索引管理')
  .addCommand(
    new Command('stats')
      .description('查看索引分片统计（文件数、大小、分片分布）')
      .action(async () => {
        const stats = await fileOps.getIndexStats();
        console.log(chalk.green('═══ 索引统计 ═══'));
        console.log(`  文件总数: ${stats.totalFiles}`);
        console.log(`  数据总量: ${fileOps.formatBytes(stats.totalSize)}`);
        console.log(`  分片数量: ${stats.shardCount}`);
        console.log(`  平均每分片: ${stats.avgFilesPerShard} 个文件`);

        const activeShards = stats.shards.filter(s => s.files > 0);
        if (activeShards.length > 0) {
          console.log(chalk.green('\n═══ 活跃分片 ═══'));
          for (const s of activeShards) {
            console.log(`  shard-${s.shardId.toString(16).padStart(2, '0')}: ${s.files} 个文件, ${fileOps.formatBytes(s.size)}`);
          }
        }
      })
  )
  .addCommand(
    new Command('migrate')
      .description('迁移旧版单文件索引到分片索引')
      .action(async () => {
        const spinner = ora('迁移索引...').start();
        try {
          const { IndexStore } = await import('./index-store.js');
          const store = new IndexStore();
          const result = await store.init();
          spinner.succeed('索引迁移完成');
          console.log(`  分片数: ${result.shardCount}`);
          console.log(`  索引目录: ${result.indexDir}`);
        } catch (err) {
          spinner.fail(`迁移失败: ${err.message}`);
        }
      })
  );

// ==================== 数据完整性命令 ====================

program
  .command('integrity')
  .description('数据完整性管理（扫描/修复/GC）')
  .addCommand(
    new Command('scan')
      .description('全量完整性扫描（验证所有副本哈希）')
      .action(async () => {
        const spinner = ora('扫描数据完整性...').start();
        try {
          const { DataIntegrity } = await import('./data-integrity.js');
          const integrity = new DataIntegrity();
          const report = await integrity.fullScan();
          spinner.succeed('完整性扫描完成');

          console.log(chalk.green('\n═══ 完整性扫描报告 ═══'));
          console.log(`  文件总数: ${report.totalFiles}`);
          console.log(`  健康: ${chalk.green(report.healthyFiles)}`);
          console.log(`  损坏: ${report.corruptedFiles > 0 ? chalk.red(report.corruptedFiles) : '0'}`);
          console.log(`  缺失副本: ${report.missingReplicas > 0 ? chalk.yellow(report.missingReplicas) : '0'}`);

          if (report.details.length > 0) {
            console.log(chalk.green('\n═══ 文件详情 ═══'));
            for (const d of report.details) {
              const icon = d.status === 'healthy' ? '✅' : d.status === 'degraded' ? '⚠️' : '❌';
              const replicaInfo = d.replicas.map(r => `${r.nodeId}:${r.status}`).join(', ');
              console.log(`  ${icon} ${d.fileName} | ${replicaInfo}`);
            }
          }

          if (report.corruptedFiles > 0 || report.missingReplicas > 0) {
            console.log(chalk.yellow('\n建议运行 integrity repair 自动修复'));
          }
        } catch (err) {
          spinner.fail(`扫描失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('repair')
      .description('自动修复损坏/缺失的副本')
      .option('--dry-run', '仅显示修复计划，不实际执行')
      .option('--max <number>', '最大修复文件数', '10')
      .action(async (options) => {
        const spinner = ora(options.dryRun ? '生成修复计划...' : '自动修复中...').start();
        try {
          const { DataIntegrity } = await import('./data-integrity.js');
          const integrity = new DataIntegrity();
          const report = await integrity.repair({
            dryRun: options.dryRun,
            maxRepairs: parseInt(options.max)
          });
          spinner.succeed(options.dryRun ? '修复计划生成完成' : '自动修复完成');

          console.log(chalk.green('\n═══ 修复报告 ═══'));
          console.log(`  检查文件: ${report.totalChecked}`);
          console.log(`  已修复: ${chalk.green(report.repaired)}`);
          console.log(`  失败: ${report.failed > 0 ? chalk.red(report.failed) : '0'}`);
          console.log(`  跳过: ${report.skipped}`);

          if (report.actions.length > 0) {
            console.log(chalk.green('\n═══ 操作详情 ═══'));
            for (const action of report.actions) {
              if (action.action === 'repaired') {
                console.log(`  ✅ ${action.cid.slice(0, 20)}... | ${action.source} → ${action.targets.join(', ')}`);
              } else if (action.action === 'would_repair') {
                console.log(`  📋 ${action.cid.slice(0, 20)}... | 计划: ${action.source} → ${action.targets.join(', ')}`);
              } else if (action.action === 'unrecoverable') {
                console.log(`  ❌ ${action.cid.slice(0, 20)}... | ${action.reason}`);
              }
            }
          }
        } catch (err) {
          spinner.fail(`修复失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('gc')
      .description('垃圾回收：清理无索引引用的孤立 block')
      .option('--dry-run', '仅显示可清理项，不实际删除')
      .action(async (options) => {
        const spinner = ora('执行垃圾回收...').start();
        try {
          const { DataIntegrity } = await import('./data-integrity.js');
          const integrity = new DataIntegrity();
          const report = await integrity.garbageCollect({ dryRun: options.dryRun });
          spinner.succeed('垃圾回收完成');

          console.log(chalk.green('\n═══ GC 报告 ═══'));
          console.log(`  扫描节点: ${report.scannedNodes}`);
          console.log(`  孤立 block: ${report.orphanedBlocks}`);
          console.log(`  可释放空间: ${formatGcBytes(report.freedBytes)}`);
          if (!options.dryRun && report.removed.length > 0) {
            console.log(`  已清理: ${report.removed.length} 个`);
          }
        } catch (err) {
          spinner.fail(`GC 失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('health')
      .description('快速健康摘要')
      .action(async () => {
        const { DataIntegrity } = await import('./data-integrity.js');
        const integrity = new DataIntegrity();
        const summary = await integrity.getHealthSummary();

        console.log(chalk.green('═══ 数据健康摘要 ═══'));
        console.log(`  文件总数: ${summary.totalFiles}`);
        console.log(`  健康: ${chalk.green(summary.healthy)}`);
        console.log(`  降级: ${summary.degraded > 0 ? chalk.yellow(summary.degraded) : '0'}`);
        console.log(`  损坏: ${summary.corrupted > 0 ? chalk.red(summary.corrupted) : '0'}`);
        console.log(`  健康率: ${summary.healthRate}`);
      })
  );

// ==================== 副本策略命令 ====================

program
  .command('replica')
  .description('副本策略管理')
  .addCommand(
    new Command('health')
      .description('副本健康评估（检查所有文件的副本可用性）')
      .action(async () => {
        const spinner = ora('评估副本健康...').start();
        try {
          const { ReplicaStrategy } = await import('./replica-strategy.js');
          const strategy = new ReplicaStrategy();
          const report = await strategy.assessReplicaHealth();
          spinner.succeed('副本健康评估完成');

          console.log(chalk.green('\n═══ 副本健康报告 ═══'));
          console.log(`  文件总数: ${report.totalFiles}`);
          console.log(`  健康: ${chalk.green(report.healthy)}`);
          console.log(`  降级: ${report.degraded > 0 ? chalk.yellow(report.degraded) : '0'}`);
          console.log(`  危急: ${report.critical > 0 ? chalk.red(report.critical) : '0'}`);
          console.log(`  健康率: ${report.healthRate}`);

          const issues = report.details.filter(d => d.status !== 'healthy');
          if (issues.length > 0) {
            console.log(chalk.green('\n═══ 问题文件 ═══'));
            for (const d of issues.slice(0, 10)) {
              const icon = d.status === 'degraded' ? '⚠️' : '❌';
              console.log(`  ${icon} ${d.fileName} | 副本 ${d.availableReplicas}/${d.targetReplicas}`);
            }
            if (issues.length > 10) {
              console.log(chalk.gray(`  ... 还有 ${issues.length - 10} 个`));
            }
          }
        } catch (err) {
          spinner.fail(`评估失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('balance')
      .description('数据倾斜检测')
      .action(async () => {
        const { ReplicaStrategy } = await import('./replica-strategy.js');
        const strategy = new ReplicaStrategy();
        const report = await strategy.detectImbalance();

        console.log(chalk.green('═══ 数据均衡检测 ═══'));
        console.log(`  状态: ${report.balanced ? chalk.green('均衡') : chalk.yellow('不均衡')}`);
        console.log(`  平均使用率: ${report.avgUsageRate}`);
        console.log(`  最大偏差: ${report.maxDeviation}`);
        console.log(`  建议: ${report.recommendation}`);

        if (report.nodes.length > 0) {
          console.log(chalk.green('\n═══ 节点详情 ═══'));
          for (const n of report.nodes) {
            const bar = '█'.repeat(Math.round(n.usageRate * 20)) + '░'.repeat(20 - Math.round(n.usageRate * 20));
            console.log(`  ${n.nodeId} | ${bar} ${(n.usageRate * 100).toFixed(1)}%`);
          }
        }
      })
  )
  .addCommand(
    new Command('config')
      .description('冗余参数配置管理')
      .addCommand(
        new Command('show')
          .description('查看当前冗余配置和规则')
          .action(async () => {
            const { ReplicaConfig } = await import('./replica-config.js');
            const rc = new ReplicaConfig();
            const config = await rc.getGlobal();
            const rules = await rc.listRules();

            console.log(chalk.green('═══ 冗余参数配置 ═══'));
            console.log(`  冗余等级: ${chalk.cyan(config.level)} (${config.preset?.label || '自定义'})`);
            console.log(`  目标副本数: ${config.replicas === -1 ? chalk.cyan('所有可用节点') : config.replicas}`);
            console.log(`  最小副本数: ${config.minReplicas}（低于此值触发修复）`);
            console.log(`  放置策略: ${rc.formatPlacement(config.placement)}`);
            console.log(`  修复优先级: ${config.repairPriority}`);

            console.log(chalk.green('\n═══ 可用预设等级 ═══'));
            const presets = rc.getPresets();
            for (const [key, p] of Object.entries(presets)) {
              const active = key === config.level ? chalk.green(' ← 当前') : '';
              console.log(`  ${key}: ${p.label} | 副本 ${p.replicas === -1 ? '全节点' : p.replicas} | 最小 ${p.minReplicas} | ${p.placement}${active}`);
            }

            if (rules.length > 0) {
              console.log(chalk.green('\n═══ 文件类型规则 ═══'));
              for (const rule of rules) {
                console.log(`  ${rule.pattern} → 副本 ${rule.replicas === -1 ? '全节点' : rule.replicas}, 最小 ${rule.minReplicas}, ${rule.placement}, 优先级 ${rule.repairPriority}`);
              }
            } else {
              console.log(chalk.gray('\n  暂无文件类型规则（所有文件使用全局配置）'));
            }
          })
      )
      .addCommand(
        new Command('set')
          .description('设置全局冗余参数')
          .option('-l, --level <level>', '冗余等级（standard/high/critical）')
          .option('-r, --replicas <number>', '目标副本数（-1 表示所有节点）')
          .option('--min <number>', '最小副本数')
          .option('-p, --placement <strategy>', '放置策略（space_first/round_robin/random）')
          .option('--priority <priority>', '修复优先级（high/normal/low）')
          .action(async (options) => {
            const { ReplicaConfig } = await import('./replica-config.js');
            const rc = new ReplicaConfig();
            try {
              const result = await rc.setGlobal({
                level: options.level,
                replicas: options.replicas,
                minReplicas: options.min,
                placement: options.placement,
                repairPriority: options.priority
              });
              console.log(chalk.green('冗余配置已更新:'));
              console.log(`  等级: ${result.level}`);
              console.log(`  目标副本数: ${result.replicas === -1 ? '所有可用节点' : result.replicas}`);
              console.log(`  最小副本数: ${result.minReplicas}`);
              console.log(`  放置策略: ${rc.formatPlacement(result.placement)}`);
              console.log(`  修复优先级: ${result.repairPriority}`);
            } catch (err) {
              console.log(chalk.red(`设置失败: ${err.message}`));
              process.exit(1);
            }
          })
      )
      .addCommand(
        new Command('reset')
          .description('重置为默认配置（standard 等级）')
          .action(async () => {
            const { ReplicaConfig } = await import('./replica-config.js');
            const rc = new ReplicaConfig();
            const result = await rc.reset();
            console.log(chalk.green('已重置为默认配置:'));
            console.log(`  等级: ${result.level}, 副本: ${result.replicas}, 最小: ${result.minReplicas}`);
          })
      )
      .addCommand(
        new Command('rule')
          .description('文件类型规则管理')
          .addCommand(
            new Command('add')
              .description('添加规则（pattern 支持扩展名/通配符/大小条件）')
              .argument('<pattern>', '匹配模式（如 .pdf、*.log、>10MB）')
              .option('-r, --replicas <number>', '目标副本数')
              .option('--min <number>', '最小副本数')
              .option('-p, --placement <strategy>', '放置策略')
              .option('--priority <priority>', '修复优先级')
              .action(async (pattern, options) => {
                const { ReplicaConfig } = await import('./replica-config.js');
                const rc = new ReplicaConfig();
                try {
                  const rule = await rc.addRule({
                    pattern,
                    replicas: options.replicas,
                    minReplicas: options.min,
                    placement: options.placement,
                    repairPriority: options.priority
                  });
                  console.log(chalk.green(`规则已添加: ${rule.pattern}`));
                  console.log(`  副本: ${rule.replicas === -1 ? '全节点' : rule.replicas}, 最小: ${rule.minReplicas}, 策略: ${rule.placement}`);
                } catch (err) {
                  console.log(chalk.red(`添加失败: ${err.message}`));
                  process.exit(1);
                }
              })
          )
          .addCommand(
            new Command('remove')
              .description('删除规则')
              .argument('<pattern>', '匹配模式')
              .action(async (pattern) => {
                const { ReplicaConfig } = await import('./replica-config.js');
                const rc = new ReplicaConfig();
                const result = await rc.removeRule(pattern);
                if (result.success) {
                  console.log(chalk.green(`规则已删除: ${pattern}`));
                } else {
                  console.log(chalk.red(result.error));
                }
              })
          )
          .addCommand(
            new Command('list')
              .description('列出所有规则')
              .action(async () => {
                const { ReplicaConfig } = await import('./replica-config.js');
                const rc = new ReplicaConfig();
                const rules = await rc.listRules();
                if (rules.length === 0) {
                  console.log(chalk.yellow('暂无规则'));
                  return;
                }
                console.log(chalk.green('文件类型规则:'));
                for (const rule of rules) {
                  console.log(`  ${rule.pattern} → 副本 ${rule.replicas === -1 ? '全节点' : rule.replicas}, 最小 ${rule.minReplicas}, ${rule.placement}, 优先级 ${rule.repairPriority}`);
                }
              })
          )
      )
  );

// ==================== 数据再平衡命令 ====================

program
  .command('rebalance')
  .description('数据再平衡（将倾斜节点的数据迁移到空闲节点）')
  .addCommand(
    new Command('status')
      .description('查看再平衡状态和节点使用率分布')
      .action(async () => {
        const { RebalanceEngine } = await import('./rebalance.js');
        const engine = new RebalanceEngine();
        const status = await engine.getStatus();

        console.log(chalk.green('═══ 数据再平衡状态 ═══'));
        console.log(`  启用状态: ${status.enabled ? chalk.green('已启用') : chalk.red('已禁用')}`);
        console.log(`  是否需要再平衡: ${status.needed ? chalk.yellow('是') : chalk.green('否')}`);
        console.log(`  原因: ${status.reason}`);
        console.log(`  平均使用率: ${status.avgUsageRate}`);
        console.log(`  最大偏差: ${status.maxDeviation}（阈值 ${status.thresholds.deviation}）`);
        console.log(`  节点差值: ${status.gap}（阈值 ${status.thresholds.gap}）`);

        if (status.lastRun) {
          console.log(chalk.green('\n═══ 上次执行 ═══'));
          console.log(`  时间: ${status.lastRun}`);
          if (status.lastResult) {
            console.log(`  迁移: ${status.lastResult.migrated} 个, 失败: ${status.lastResult.failed} 个, 释放: ${engine.formatBytes(status.lastResult.freedBytes)}`);
          }
        }

        if (status.nodes.length > 0) {
          console.log(chalk.green('\n═══ 节点使用率 ═══'));
          for (const n of status.nodes) {
            const pct = parseFloat(n.usageRate);
            const barLen = 20;
            const filled = Math.round((pct / 100) * barLen);
            const bar = chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(barLen - filled));
            const color = pct > 60 ? chalk.red : pct > 30 ? chalk.yellow : chalk.green;
            console.log(`  ${n.nodeId} | ${bar} ${color(n.usageRate)} | ${n.blockCount} blocks`);
          }
        }
      })
  )
  .addCommand(
    new Command('plan')
      .description('生成再平衡迁移计划（不实际执行）')
      .option('--max <number>', '最大迁移数', '20')
      .action(async (options) => {
        const spinner = ora('生成再平衡计划...').start();
        try {
          const { RebalanceEngine } = await import('./rebalance.js');
          const engine = new RebalanceEngine();
          const plan = await engine.generatePlan({ maxMoves: parseInt(options.max) });
          spinner.stop();

          if (!plan.needed) {
            console.log(chalk.green(`无需再平衡: ${plan.reason}`));
            return;
          }

          console.log(chalk.green('═══ 再平衡迁移计划 ═══'));
          console.log(`  原因: ${plan.reason}`);
          console.log(`  计划迁移: ${plan.totalMoves} 个 block`);
          console.log(`  总数据量: ${engine.formatBytes(plan.totalBytes)}`);

          if (plan.moves.length > 0) {
            console.log(chalk.green('\n═══ 迁移详情 ═══'));
            for (const move of plan.moves.slice(0, 15)) {
              console.log(`  ${move.cid.slice(0, 20)}... | ${move.from} → ${move.to} | ${engine.formatBytes(move.size)}`);
            }
            if (plan.moves.length > 15) {
              console.log(chalk.gray(`  ... 还有 ${plan.moves.length - 15} 个`));
            }
            console.log(chalk.yellow('\n运行 rebalance run 执行迁移'));
          }
        } catch (err) {
          spinner.fail(`生成计划失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('run')
      .description('执行再平衡迁移')
      .option('--dry-run', '仅显示计划，不实际执行')
      .option('--max <number>', '最大迁移数', '20')
      .action(async (options) => {
        const spinner = ora(options.dryRun ? '生成再平衡计划...' : '执行再平衡迁移...').start();
        try {
          const { RebalanceEngine } = await import('./rebalance.js');
          const engine = new RebalanceEngine();
          const report = await engine.execute({
            dryRun: options.dryRun,
            maxMoves: parseInt(options.max)
          });
          spinner.stop();

          if (!report.needed) {
            console.log(chalk.green(`无需再平衡: ${report.reason}`));
            return;
          }

          if (options.dryRun) {
            console.log(chalk.green('═══ 再平衡计划（dry-run）═══'));
            console.log(`  计划迁移: ${report.plannedMoves} 个 block`);
            console.log(`  总数据量: ${engine.formatBytes(report.totalBytes)}`);
            for (const move of report.moves.slice(0, 10)) {
              console.log(`  ${move.from} → ${move.to}: ${move.cid.slice(0, 20)}... (${engine.formatBytes(move.size)})`);
            }
            return;
          }

          console.log(chalk.green('═══ 再平衡执行报告 ═══'));
          console.log(`  成功迁移: ${chalk.green(report.migrated)} 个`);
          console.log(`  失败: ${report.failed > 0 ? chalk.red(report.failed) : '0'} 个`);
          console.log(`  释放空间: ${engine.formatBytes(report.freedBytes)}`);
          console.log(`  耗时: ${report.startedAt} → ${report.completedAt}`);

          if (report.moves.length > 0) {
            console.log(chalk.green('\n═══ 迁移详情 ═══'));
            for (const move of report.moves.slice(0, 10)) {
              const icon = move.status === 'migrated' ? '✅' : '❌';
              console.log(`  ${icon} ${move.from} → ${move.to}: ${move.cid.slice(0, 20)}...${move.error ? ` (${move.error})` : ''}`);
            }
            if (report.moves.length > 10) {
              console.log(chalk.gray(`  ... 还有 ${report.moves.length - 10} 个`));
            }
          }
        } catch (err) {
          spinner.fail(`再平衡失败: ${err.message}`);
          process.exit(1);
        }
      })
  );

// ==================== 多用户管理命令 ====================

program
  .command('user')
  .description('多用户管理（用户注册、节点分配、跨用户互联）')
  .addCommand(
    new Command('register')
      .description('注册新用户')
      .argument('<username>', '用户名（小写字母+数字+连字符）')
      .option('--display-name <name>', '显示名称')
      .action(async (username, options) => {
        const spinner = ora(`注册用户 ${username}...`).start();
        try {
          const { UserManager } = await import('./user-manager.js');
          const um = new UserManager();
          const user = await um.registerUser(username, { displayName: options.displayName });
          spinner.succeed(`用户 ${username} 注册成功`);
          console.log(chalk.green('\n用户信息:'));
          console.log(`  用户名: ${user.username}`);
          console.log(`  显示名: ${user.displayName}`);
          console.log(`  创建时间: ${user.createdAt}`);
          console.log(`  认证: ${user.authSecret ? '已启用' : '未启用'}`);
          console.log(chalk.yellow('\n下一步: 运行 user start <username> 为用户分配节点'));
        } catch (err) {
          spinner.fail(`注册失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('login')
      .description('用户登录，颁发认证 token（自动保存会话）')
      .argument('<username>', '用户名')
      .action(async (username) => {
        const spinner = ora(`用户 ${username} 登录中...`).start();
        try {
          const { UserManager } = await import('./user-manager.js');
          const { saveSession } = await import('./security.js');
          const um = new UserManager();
          const result = await um.login(username);
          // 持久化会话，后续敏感命令自动使用
          await saveSession(username, result);
          spinner.succeed(`用户 ${username} 登录成功`);
          console.log(chalk.green('\n认证信息:'));
          console.log(`  Token: ${result.token}`);
          console.log(`  过期时间: ${result.expiresAt}`);
          console.log(chalk.green('\n  会话已保存，后续 upload/download/delete 将自动使用此身份'));
          console.log(chalk.gray('  提示: 也可通过 --token 参数或 IPFS_AUTH_TOKEN 环境变量手动传递'));
        } catch (err) {
          spinner.fail(`登录失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('logout')
      .description('登出，清除本地会话')
      .action(async () => {
        const { clearSession, loadSession } = await import('./security.js');
        const session = await loadSession();
        if (!session) {
          console.log(chalk.yellow('当前无活跃会话'));
          return;
        }
        await clearSession();
        console.log(chalk.green(`已登出用户 ${session.username}，会话已清除`));
      })
  )
  .addCommand(
    new Command('list')
      .description('列出所有用户及其节点统计')
      .action(async () => {
        const { UserManager } = await import('./user-manager.js');
        const um = new UserManager();
        const stats = await um.getNetworkStats();

        console.log(chalk.green('═══ 多用户网络概览 ═══'));
        console.log(`  用户总数: ${stats.totalUsers}`);
        console.log(`  节点总数: ${stats.totalNodes}`);
        console.log(`  运行中: ${chalk.green(stats.runningNodes)}`);

        if (stats.users.length > 0) {
          console.log(chalk.green('\n═══ 用户详情 ═══'));
          for (const u of stats.users) {
            const usage = u.totalQuota > 0 ? ((u.usedSpace / u.totalQuota) * 100).toFixed(1) : '0.0';
            console.log(`  ${chalk.cyan(u.username)} (${u.displayName}) | 节点: ${u.runningNodes}/${u.nodeCount} | 配额: ${formatGcBytes(u.totalQuota)} | 使用率: ${usage}%`);
          }
        } else {
          console.log(chalk.yellow('\n  暂无用户，请先运行 user register <username>'));
        }
      })
  )
  .addCommand(
    new Command('start')
      .description('为用户启动存储节点')
      .argument('<username>', '用户名')
      .option('-n, --count <number>', '节点数量', '3')
      .action(async (username, options) => {
        const count = parseInt(options.count);
        const spinner = ora(`为用户 ${username} 启动 ${count} 个节点...`).start();
        try {
          const { UserManager } = await import('./user-manager.js');
          const um = new UserManager();
          const nodes = await um.startUserNodes(username, count);
          spinner.succeed(`用户 ${username} 的 ${count} 个节点启动成功`);
          console.log(chalk.green('\n节点列表:'));
          for (const node of nodes) {
            console.log(`  ${node.nodeId}: ${node.peerId.slice(0, 20)}... | 端口: ${node.port} | 配额: ${formatGcBytes(node.quota)}`);
          }
          console.log(chalk.yellow('\n下一步: 运行 user network 启动跨用户 P2P 互联'));
        } catch (err) {
          spinner.fail(`启动失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('nodes')
      .description('查看用户的节点列表')
      .argument('<username>', '用户名')
      .action(async (username) => {
        const { UserManager } = await import('./user-manager.js');
        const um = new UserManager();
        const nodes = await um.getUserNodes(username);

        if (nodes.length === 0) {
          console.log(chalk.yellow(`用户 ${username} 没有节点，请先运行 user start ${username}`));
          return;
        }

        console.log(chalk.green(`用户 ${username} 的节点:`));
        for (const node of nodes) {
          const status = node.status === 'running' ? chalk.green('运行中') : chalk.red('已停止');
          console.log(`  ${node.nodeId}: ${status} | ${node.peerId.slice(0, 20)}... | 端口: ${node.port} | 已用: ${formatGcBytes(node.usedSpace || 0)}/${formatGcBytes(node.quota)}`);
        }
      })
  )
  .addCommand(
    new Command('network')
      .description('启动多用户 P2P 网络（所有用户节点互联）')
      .argument('[usernames...]', '要启动的用户列表（空则全部用户）')
      .option('--duration <seconds>', '运行时长（秒），0 表示永久运行', '0')
      .action(async (usernames, options) => {
        const duration = parseInt(options.duration);
        const spinner = ora('启动多用户 P2P 网络...').start();
        try {
          const { MultiUserNetwork } = await import('./multi-user-network.js');
          const network = new MultiUserNetwork();
          const result = await network.startMultiUserNetwork(usernames);
          spinner.succeed(`多用户 P2P 网络启动成功，${result.totalActiveNodes} 个节点活跃`);

          console.log(chalk.green('\n═══ 用户节点状态 ═══'));
          for (const userResult of result.users) {
            if (userResult.error) {
              console.log(`  ${chalk.red(userResult.username)}: ${userResult.error}`);
            } else {
              console.log(`  ${chalk.cyan(userResult.username)}: ${userResult.nodeCount} 个节点`);
              for (const node of userResult.nodes) {
                console.log(`    ${node.nodeId}: ${node.peerId.slice(0, 20)}... | port ${node.port}`);
              }
            }
          }

          console.log(chalk.green('\n═══ 跨用户互联 ═══'));
          console.log(`  拓扑: ${result.mesh.topology}`);
          console.log(`  新建连接: ${result.mesh.newConnections}`);
          console.log(`  失败: ${result.mesh.failures}`);

          console.log(chalk.green('\n═══ 节点 Peers ═══'));
          for (const ns of result.nodeStatus) {
            console.log(`  ${ns.nodeId}: ${ns.peers} peers`);
          }

          console.log(chalk.green('\n═══ floodsub 广播通道 ═══'));
          console.log(`  topic: ipfs-multi-user-network`);
          console.log(`  订阅节点: ${result.totalActiveNodes}`);
          console.log(`  状态: ${chalk.green('就绪')}（所有用户节点可互相广播）`);

          if (duration > 0) {
            console.log(chalk.yellow(`\n将在 ${duration} 秒后自动停止...`));
            await new Promise(r => setTimeout(r, duration * 1000));
            await network.stopAll();
            console.log(chalk.green('多用户 P2P 网络已停止'));
            process.exit(0);
          } else {
            console.log(chalk.yellow('\n守护进程运行中，按 Ctrl+C 停止'));
            await new Promise(() => {});
          }
        } catch (err) {
          spinner.fail(`启动失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('broadcast')
      .description('跨用户广播消息')
      .argument('<message>', '广播消息内容')
      .option('-n, --node <node-id>', '发送节点 ID')
      .action(async (message, options) => {
        const { MultiUserNetwork } = await import('./multi-user-network.js');
        const network = new MultiUserNetwork();
        const activeNodes = network.getActiveNodes();

        if (activeNodes.length === 0) {
          console.log(chalk.red('多用户 P2P 网络未启动，请先运行 user network'));
          process.exit(1);
        }

        const fromNode = options.node || activeNodes[0];
        try {
          const result = await network.broadcast(fromNode, {
            type: 'broadcast',
            content: message
          });
          console.log(chalk.green(`广播完成，${result.recipients} 个节点收到`));
          console.log(`  topic: ${result.topic}`);
          console.log(`  发送节点: ${fromNode}`);
        } catch (err) {
          console.log(chalk.red(`广播失败: ${err.message}`));
          process.exit(1);
        }
      })
  );

// ==================== 分块存储命令 ====================

program
  .command('chunk')
  .description('分块存储管理（Chunk DAG）')
  .addCommand(
    new Command('info')
      .description('查看分块文件的 DAG 结构信息')
      .argument('<cid>', '文件 CID')
      .action(async (cid) => {
        const result = await fileOps.getChunkInfo(cid);
        if (!result.success) {
          console.log(chalk.red(result.error));
          process.exit(1);
        }
        console.log(chalk.green('═══ 分块文件信息 ═══'));
        console.log(`  文件名: ${result.fileName}`);
        console.log(`  文件大小: ${formatGcBytes(result.fileSize)}`);
        console.log(`  Root CID: ${chalk.cyan(result.rootCid)}`);
        console.log(`  分块大小: ${formatGcBytes(result.chunkSize)}`);
        console.log(`  分块数量: ${result.chunkCount}`);
        console.log(`  创建时间: ${result.createdAt}`);

        console.log(chalk.green('\n═══ Chunk 列表 ═══'));
        for (const chunk of result.chunks) {
          console.log(`  [${String(chunk.index).padStart(3)}] ${chunk.cid} | ${formatGcBytes(chunk.size)}`);
        }
      })
  )
  .addCommand(
    new Command('repair')
      .description('修复分块文件的 chunk 副本（从健康副本重新分发到缺失节点）')
      .argument('<cid>', '文件 CID')
      .option('--dry-run', '仅预览修复计划，不实际执行')
      .action(async (cid, options) => {
        const spinner = ora(options.dryRun ? '生成修复计划...' : '修复 chunk 副本...').start();
        try {
          const result = await fileOps.repairChunkedFile(cid, { dryRun: options.dryRun });
          if (!result.success) {
            spinner.fail(result.error);
            process.exit(1);
          }
          spinner.stop();

          console.log(chalk.green('═══ Chunk 副本修复报告 ═══'));
          console.log(`  文件名: ${result.fileName}`);
          console.log(`  模式: ${options.dryRun ? 'dry-run（仅预览）' : '实际执行'}`);
          console.log(`  总 chunk: ${result.totalChunks}`);
          console.log(`  健康: ${result.healthyChunks}`);
          console.log(`  已修复: ${result.repaired}`);
          console.log(`  失败: ${result.failed}`);
          console.log(`  跳过: ${result.skipped}`);

          if (result.actions && result.actions.length > 0) {
            console.log(chalk.green('\n═══ 操作详情 ═══'));
            for (const action of result.actions) {
              if (action.action === 'repaired') {
                console.log(`  ${chalk.green('✅')} chunk[${action.chunkIndex}] 已从 ${action.source} 修复到 ${action.targets.join(', ')}`);
              } else if (action.action === 'would_repair') {
                console.log(`  ${chalk.cyan('📋')} chunk[${action.chunkIndex}] 计划: ${action.source} → ${action.targets.join(', ')}`);
              } else if (action.action === 'unrecoverable') {
                console.log(`  ${chalk.red('❌')} chunk[${action.chunkIndex}] ${action.reason}`);
              } else if (action.action === 'failed') {
                console.log(`  ${chalk.red('❌')} chunk[${action.chunkIndex}] ${action.reason}`);
              }
            }
          }
        } catch (err) {
          spinner.fail(`修复失败: ${err.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('verify')
      .description('验证分块文件完整性（逐 chunk 校验 CID）')
      .argument('<cid>', '文件 CID')
      .action(async (cid) => {
        const spinner = ora('验证分块文件完整性...').start();
        try {
          const result = await fileOps.verifyChunkedFile(cid);
          if (!result.success) {
            spinner.fail(result.error);
            process.exit(1);
          }
          spinner.stop();

          const icon = result.allValid ? chalk.green('✅') : chalk.red('❌');
          console.log(`${icon} 分块文件完整性验证`);
          console.log(chalk.green('\n═══ 验证结果 ═══'));
          console.log(`  文件名: ${result.fileName}`);
          console.log(`  文件大小: ${formatGcBytes(result.fileSize)}`);
          console.log(`  分块总数: ${result.chunkCount}`);
          console.log(`  有效: ${chalk.green(result.validChunks)}`);
          console.log(`  无效: ${result.invalidChunks > 0 ? chalk.red(result.invalidChunks) : '0'}`);
          console.log(`  状态: ${result.allValid ? chalk.green('完整') : chalk.red('存在损坏')}`);

          if (!result.allValid) {
            console.log(chalk.green('\n═══ 问题 Chunk ═══'));
            for (const d of result.details.filter(d => !d.valid)) {
              console.log(`  ${chalk.red('✗')} [${d.index}] ${d.cid} | ${d.error || 'CID 不匹配'}`);
            }
          }
        } catch (err) {
          spinner.fail(`验证失败: ${err.message}`);
          process.exit(1);
        }
      })
  );

// GC 字节格式化辅助函数
function formatGcBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 解析命令行参数
program.parse();
