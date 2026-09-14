/**
 * IPFS 分布式存储网络 - 分片索引存储模块
 * 解决单文件 index.json 的性能瓶颈：
 * 
 * 商用级特性：
 * - 分片存储：按 CID 前缀哈希分散到多个分片文件，避免单文件过大
 * - 原子写入：write-to-temp + rename，防止写入中断导致索引损坏
 * - 读写锁：进程内互斥，防止并发写入互相覆盖
 * - 向后兼容：自动迁移旧版单文件 index.json
 * - LRU 缓存：热点分片内存缓存，减少磁盘 I/O
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

const NODES_DIR = '/home/project/.ipfs-nodes';
const SHARD_COUNT = 16;       // 16 个分片（CID 首字符 hex 映射）
const CACHE_SIZE = 8;         // LRU 缓存最多 8 个分片

export class IndexStore {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.indexDir = path.join(nodesDir, '.index-shards');
    this.legacyIndexPath = path.join(nodesDir, 'index.json');
    // 进程内读写锁
    this._locks = new Map(); // shardId -> Promise chain
    // LRU 缓存
    this._cache = new Map(); // shardId -> { data, lastAccess }
  }

  /**
   * 初始化：确保分片目录存在，自动迁移旧版索引
   */
  async init() {
    await fs.ensureDir(this.indexDir);

    // 自动迁移旧版单文件索引
    if (await fs.pathExists(this.legacyIndexPath)) {
      const legacyIndex = await fs.readJson(this.legacyIndexPath);
      const entries = Object.entries(legacyIndex);

      if (entries.length > 0) {
        // 按分片分组写入
        const shardGroups = new Map();
        for (const [cid, info] of entries) {
          const shardId = this.getShardId(cid);
          if (!shardGroups.has(shardId)) {
            shardGroups.set(shardId, {});
          }
          shardGroups.get(shardId)[cid] = info;
        }

        for (const [shardId, data] of shardGroups) {
          const shardPath = this.getShardPath(shardId);
          let existing = {};
          if (await fs.pathExists(shardPath)) {
            existing = await fs.readJson(shardPath);
          }
          Object.assign(existing, data);
          await this.atomicWrite(shardPath, existing);
        }

        // 迁移完成后重命名旧索引为备份
        await fs.rename(this.legacyIndexPath, this.legacyIndexPath + '.migrated');
      }
    }

    return { shardCount: SHARD_COUNT, indexDir: this.indexDir };
  }

  /**
   * 根据 CID 计算分片 ID（取 CID 字符串哈希的低 4 位）
   */
  getShardId(cid) {
    const hash = crypto.createHash('md5').update(cid).digest();
    return hash[0] % SHARD_COUNT;
  }

  /**
   * 获取分片文件路径
   */
  getShardPath(shardId) {
    return path.join(this.indexDir, `shard-${shardId.toString(16).padStart(2, '0')}.json`);
  }

  /**
   * 读取分片（带 LRU 缓存）
   */
  async readShard(shardId) {
    // 检查缓存
    if (this._cache.has(shardId)) {
      const entry = this._cache.get(shardId);
      entry.lastAccess = Date.now();
      return entry.data;
    }

    const shardPath = this.getShardPath(shardId);
    let data = {};
    if (await fs.pathExists(shardPath)) {
      data = await fs.readJson(shardPath);
    }

    // 写入缓存（LRU 淘汰）
    this._cache.set(shardId, { data, lastAccess: Date.now() });
    if (this._cache.size > CACHE_SIZE) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this._cache) {
        if (entry.lastAccess < oldestTime) {
          oldestTime = entry.lastAccess;
          oldest = key;
        }
      }
      if (oldest !== null) this._cache.delete(oldest);
    }

    return data;
  }

  /**
   * 写入分片（原子写入 + 更新缓存）
   */
  async writeShard(shardId, data) {
    const shardPath = this.getShardPath(shardId);
    await this.atomicWrite(shardPath, data);
    // 更新缓存
    this._cache.set(shardId, { data, lastAccess: Date.now() });
  }

  /**
   * 原子写入：先写临时文件再 rename（防止写入中断导致数据损坏）
   */
  async atomicWrite(filePath, data) {
    const tmpPath = filePath + `.tmp.${process.pid}`;
    await fs.writeJson(tmpPath, data, { spaces: 2 });
    await fs.rename(tmpPath, filePath);
  }

  /**
   * 进程内分片级写锁（串行化同一分片的并发写入）
   */
  async withLock(shardId, fn) {
    const prev = this._locks.get(shardId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this._locks.set(shardId, prev.then(() => current));

    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 获取单个文件索引
   */
  async get(cid) {
    const shardId = this.getShardId(cid);
    const shard = await this.readShard(shardId);
    return shard[cid] || null;
  }

  /**
   * 设置单个文件索引（带锁 + 原子写入）
   */
  async set(cid, info) {
    const shardId = this.getShardId(cid);
    return await this.withLock(shardId, async () => {
      const shard = await this.readShard(shardId);
      shard[cid] = info;
      await this.writeShard(shardId, shard);
    });
  }

  /**
   * 删除单个文件索引
   */
  async delete(cid) {
    const shardId = this.getShardId(cid);
    return await this.withLock(shardId, async () => {
      const shard = await this.readShard(shardId);
      const existed = cid in shard;
      delete shard[cid];
      await this.writeShard(shardId, shard);
      return existed;
    });
  }

  /**
   * 更新文件的 storedNodes（副本修复/迁移后调用）
   */
  async updateReplicaList(cid, storedNodes) {
    const shardId = this.getShardId(cid);
    return await this.withLock(shardId, async () => {
      const shard = await this.readShard(shardId);
      if (shard[cid]) {
        shard[cid].storedNodes = storedNodes;
        shard[cid].replicas = storedNodes.length;
        shard[cid].lastRepairAt = new Date().toISOString();
        await this.writeShard(shardId, shard);
      }
    });
  }

  /**
   * 获取完整索引（遍历所有分片）
   */
  async getAll() {
    const result = {};
    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = await this.readShard(i);
      Object.assign(result, shard);
    }
    return result;
  }

  /**
   * 批量写入（迁移/导入场景）
   */
  async batchSet(entries) {
    const shardGroups = new Map();
    for (const [cid, info] of Object.entries(entries)) {
      const shardId = this.getShardId(cid);
      if (!shardGroups.has(shardId)) {
        shardGroups.set(shardId, {});
      }
      shardGroups.get(shardId)[cid] = info;
    }

    for (const [shardId, data] of shardGroups) {
      await this.withLock(shardId, async () => {
        const shard = await this.readShard(shardId);
        Object.assign(shard, data);
        await this.writeShard(shardId, shard);
      });
    }
  }

  /**
   * 索引统计信息
   */
  async getStats() {
    let totalFiles = 0;
    let totalSize = 0;
    const shardStats = [];

    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = await this.readShard(i);
      const count = Object.keys(shard).length;
      const size = Object.values(shard).reduce((sum, f) => sum + (f.size || 0), 0);
      totalFiles += count;
      totalSize += size;
      shardStats.push({ shardId: i, files: count, size });
    }

    return {
      totalFiles,
      totalSize,
      shardCount: SHARD_COUNT,
      avgFilesPerShard: (totalFiles / SHARD_COUNT).toFixed(1),
      shards: shardStats
    };
  }
}

export default IndexStore;
