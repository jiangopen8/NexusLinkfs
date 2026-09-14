/**
 * IPFS 分布式存储网络 - 硬件评估器
 * 根据 CPU/内存/磁盘综合评估，自动计算推荐节点数（3-100）
 */

import os from 'os';
import fs from 'fs-extra';

const MIN_NODES = 3;
const MAX_NODES = 100;
const STORAGE_RESERVE_RATIO = 0.7;
const MAX_QUOTA_PER_NODE = 100 * 1024 * 1024; // 100MB
const MIN_QUOTA_PER_NODE = 1 * 1024 * 1024;   // 1MB 最低配额

// 每节点资源开销估算
const MEM_PER_NODE = 8 * 1024 * 1024;   // 8MB 内存/节点
const CPU_PER_NODE = 0.25;               // 0.25 核/节点

export class HardwareAssessor {
  constructor(nodesDir = '/home/project/.ipfs-nodes') {
    this.nodesDir = nodesDir;
  }

  /**
   * 获取 CPU 信息
   */
  getCpuInfo() {
    const cpus = os.cpus();
    const cores = cpus.length;
    const model = cpus[0]?.model || 'unknown';
    const avgSpeed = Math.round(cpus.reduce((s, c) => s + c.speed, 0) / cores);
    return { cores, model, avgSpeedMHz: avgSpeed };
  }

  /**
   * 获取内存信息
   */
  getMemoryInfo() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    return { totalBytes, freeBytes };
  }

  /**
   * 获取磁盘信息
   */
  async getDiskInfo() {
    try {
      const stats = await fs.statfs(this.nodesDir);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usableBytes = Math.floor(freeBytes * STORAGE_RESERVE_RATIO);
      return { totalBytes, freeBytes, usableBytes };
    } catch {
      return {
        totalBytes: 10 * 1024 * 1024 * 1024,
        freeBytes: 5 * 1024 * 1024 * 1024,
        usableBytes: Math.floor(5 * 1024 * 1024 * 1024 * STORAGE_RESERVE_RATIO)
      };
    }
  }

  /**
   * 综合评估，返回推荐节点数和各维度详情
   */
  async assess() {
    const cpu = this.getCpuInfo();
    const mem = this.getMemoryInfo();
    const disk = await this.getDiskInfo();

    // CPU 维度：每节点 0.25 核，保留 1 核给系统
    const cpuCapacity = Math.max(0, cpu.cores - 1) / CPU_PER_NODE;

    // 内存维度：每节点 8MB，保留 256MB 给系统
    const memReserved = 256 * 1024 * 1024;
    const memCapacity = Math.max(0, mem.totalBytes - memReserved) / MEM_PER_NODE;

    // 磁盘维度：每节点至少 1MB 配额才有意义
    const diskCapacity = Math.floor(disk.usableBytes / MIN_QUOTA_PER_NODE);

    // 取三者最小值作为推荐节点数，clamp 到 [3, 100]
    const rawRecommended = Math.min(cpuCapacity, memCapacity, diskCapacity);
    const recommendedNodes = Math.max(MIN_NODES, Math.min(MAX_NODES, Math.floor(rawRecommended)));

    // 计算推荐节点数下的配额
    const quotaPerNode = Math.min(
      Math.floor(disk.usableBytes / recommendedNodes),
      MAX_QUOTA_PER_NODE
    );

    // 瓶颈维度
    const bottleneck = this.findBottleneck(cpuCapacity, memCapacity, diskCapacity);

    return {
      recommendedNodes,
      minNodes: MIN_NODES,
      maxNodes: MAX_NODES,
      bottleneck,
      quotaPerNode,
      quotaHuman: this.formatBytes(quotaPerNode),
      totalCapacity: quotaPerNode * recommendedNodes,
      totalCapacityHuman: this.formatBytes(quotaPerNode * recommendedNodes),
      dimensions: {
        cpu: {
          cores: cpu.cores,
          model: cpu.model,
          avgSpeedMHz: cpu.avgSpeedMHz,
          capacityNodes: Math.floor(cpuCapacity),
          weight: '每节点 0.25 核，保留 1 核给系统'
        },
        memory: {
          totalBytes: mem.totalBytes,
          totalHuman: this.formatBytes(mem.totalBytes),
          freeBytes: mem.freeBytes,
          freeHuman: this.formatBytes(mem.freeBytes),
          capacityNodes: Math.floor(memCapacity),
          weight: '每节点 8MB，保留 256MB 给系统'
        },
        disk: {
          totalBytes: disk.totalBytes,
          totalHuman: this.formatBytes(disk.totalBytes),
          freeBytes: disk.freeBytes,
          freeHuman: this.formatBytes(disk.freeBytes),
          usableBytes: disk.usableBytes,
          usableHuman: this.formatBytes(disk.usableBytes),
          capacityNodes: diskCapacity,
          weight: '每节点至少 1MB 配额，保留 30% 给系统'
        }
      },
      assessedAt: new Date().toISOString()
    };
  }

  /**
   * 找出瓶颈维度
   */
  findBottleneck(cpuCap, memCap, diskCap) {
    const entries = [
      ['cpu', cpuCap],
      ['memory', memCap],
      ['disk', diskCap]
    ];
    entries.sort((a, b) => a[1] - b[1]);
    return entries[0][0];
  }

  /**
   * 格式化字节数
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export default HardwareAssessor;
