/**
 * IPFS 分布式存储网络 - 存储插件（Storage Plugin）
 * 
 * 插件架构：将 file-ops.js 包装为标准插件，
 * 通过 PluginContext 注册服务与命令，实现"一切皆插件"。
 */

import { PluginBase } from '../core/plugin-base.js';
import FileOperations from '../file-ops.js';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';

export class StoragePlugin extends PluginBase {
  constructor() {
    super('storage', {
      description: '文件上传/下载/删除/加密',
      provides: ['storage'],
      dependencies: ['security', 'node-manager']
    });
    this.fileOps = null;
  }

  async install(ctx) {
    await super.install(ctx);
    this.fileOps = new FileOperations();
    this.provide('storage', this.fileOps);

    // 注册命令
    this.command('upload', {
      description: '上传文件到存储网络',
      options: ['--encrypt', '--key <key>', '--key-file <path>', '--replicas <n>', '--token <token>'],
      handler: async (filePath, options = {}) => {
        const security = ctx.use('security');
        const auth = await security.requireAuth(options.token);
        if (!auth.allowed) {
          console.log(chalk.red(`⛔ 鉴权失败: ${auth.reason}`));
          process.exit(1);
        }
        const result = await this.fileOps.upload(filePath, {
          encrypt: options.encrypt,
          key: options.key,
          keyFile: options.keyFile,
          replicas: options.replicas ? parseInt(options.replicas) : undefined
        });
        console.log(chalk.green('\n上传结果:'));
        console.log(`  CID: ${chalk.cyan(result.cid)}`);
        console.log(`  文件名: ${result.fileName}`);
        console.log(`  大小: ${result.sizeHuman}`);
        console.log(`  加密: ${result.encrypted ? '是' : '否'}`);
        console.log(`  副本数: ${result.replicas}/${result.targetReplicas || result.replicas}`);
        console.log(`  存储节点: ${result.storedNodes.join(', ')}`);
        this.emit('file/uploaded', { cid: result.cid, fileName: result.fileName });
        return result;
      }
    });

    this.command('download', {
      description: '从存储网络下载文件',
      options: ['--output <path>', '--decrypt', '--key <key>', '--key-file <path>', '--token <token>'],
      handler: async (cid, options = {}) => {
        const security = ctx.use('security');
        const auth = await security.requireAuth(options.token);
        if (!auth.allowed) {
          console.log(chalk.red(`⛔ 鉴权失败: ${auth.reason}`));
          process.exit(1);
        }
        const result = await this.fileOps.download(cid, {
          output: options.output,
          decrypt: options.decrypt,
          key: options.key,
          keyFile: options.keyFile
        });
        console.log(chalk.green('\n下载结果:'));
        console.log(`  CID: ${result.cid}`);
        console.log(`  输出路径: ${result.outputPath}`);
        console.log(`  大小: ${result.sizeHuman}`);
        this.emit('file/downloaded', { cid });
        return result;
      }
    });

    this.command('delete', {
      description: '删除文件',
      options: ['--token <token>'],
      handler: async (cid, options = {}) => {
        const security = ctx.use('security');
        const auth = await security.requireAuth(options.token);
        if (!auth.allowed) {
          console.log(chalk.red(`⛔ 鉴权失败: ${auth.reason}`));
          process.exit(1);
        }
        const result = await this.fileOps.deleteFile(cid);
        if (result.success) {
          console.log(chalk.green('文件已删除'));
          this.emit('file/deleted', { cid });
        } else {
          console.log(chalk.red(result.error));
        }
        return result;
      }
    });

    this.command('info', {
      description: '查看文件信息',
      options: [],
      handler: async (cid) => {
        const result = await this.fileOps.getInfo(cid);
        if (!result.success) {
          console.log(chalk.red(result.error));
          return result;
        }
        console.log(chalk.green('文件信息:'));
        console.log(`  CID: ${result.cid}`);
        console.log(`  文件名: ${result.fileName}`);
        console.log(`  大小: ${result.sizeHuman}`);
        console.log(`  加密: ${result.encrypted ? '是' : '否'}`);
        console.log(`  副本数: ${result.replicas}/${result.targetReplicas || result.replicas}`);
        console.log(`  存储节点: ${result.storedNodes.join(', ')}`);
        return result;
      }
    });

    this.command('files', {
      description: '列出所有存储的文件',
      options: [],
      handler: async () => {
        const files = await this.fileOps.listFiles();
        if (files.length === 0) {
          console.log(chalk.yellow('暂无文件'));
          return files;
        }
        console.log(chalk.green('文件列表:'));
        files.forEach(file => {
          console.log(`  ${file.fileName} | ${file.sizeHuman} | ${file.encrypted ? '加密' : '明文'} | CID: ${file.cid}`);
        });
        return files;
      }
    });
  }

  async healthCheck() {
    const details = {};
    try {
      // 检查 fileOps 是否初始化
      if (!this.fileOps) {
        return { healthy: false, message: 'FileOperations 未初始化', details };
      }
      details.serviceReady = true;

      // 检查节点目录是否存在
      const nodesDir = path.resolve('.ipfs-nodes');
      const nodesExist = await fs.pathExists(nodesDir);
      details.nodesDirExists = nodesExist;

      if (nodesExist) {
        // 统计节点数
        const entries = await fs.readdir(nodesDir);
        const nodeDirs = entries.filter(e => e.startsWith('node-'));
        details.nodeCount = nodeDirs.length;

        // 检查索引文件
        const indexPath = path.join(nodesDir, 'index.json');
        details.indexExists = await fs.pathExists(indexPath);

        if (details.indexExists) {
          try {
            const index = await fs.readJson(indexPath);
            details.fileCount = Object.keys(index.files || {}).length;
          } catch {
            details.indexReadable = false;
          }
        }
      }

      const healthy = details.serviceReady && details.nodesDirExists;
      return {
        healthy,
        message: healthy ? `存储就绪 (${details.nodeCount || 0} 节点, ${details.fileCount || 0} 文件)` : '存储目录未初始化',
        details
      };
    } catch (e) {
      this.recordError(e);
      return { healthy: false, message: `检查失败: ${e.message}`, details };
    }
  }
}

export default StoragePlugin;
