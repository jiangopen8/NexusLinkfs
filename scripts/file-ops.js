/**
 * IPFS 分布式存储网络 - 文件操作模块
 * 负责文件上传、下载、加密解密
 * 
 * 商用级特性：
 * - 下载时 CID 哈希校验（数据完整性保证）
 * - 删除时正确更新节点配额
 * - 原子写入索引（防止并发损坏）
 * - 上传去重（相同内容不重复存储）
 * - 多路径下载重试（网络不稳定容错）
 */

import fs from 'fs-extra';
import path from 'path';
import CryptoJS from 'crypto-js';
import { CID } from 'multiformats/cid';
import * as sha256 from 'multiformats/hashes/sha2';
import IndexStore from './index-store.js';
import StreamIO from './stream-io.js';
import ReplicaConfig from './replica-config.js';
import ChunkStore from './chunk-store.js';
import ChunkRepair from './chunk-repair.js';
import { validateInputPath, validateOutputPath, resolveKey } from './security.js';

const NODES_DIR = '/home/project/.ipfs-nodes';
const MAX_QUOTA_PER_NODE = 100 * 1024 * 1024; // 单节点上限 100MB
const STREAM_THRESHOLD = 5 * 1024 * 1024; // 超过 5MB 使用流式处理

export class FileOperations {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.indexStore = new IndexStore(nodesDir);
    this.streamIO = new StreamIO();
    this.replicaConfig = new ReplicaConfig(nodesDir);
    this.chunkStore = new ChunkStore(nodesDir);
    this.chunkRepair = new ChunkRepair(nodesDir);
    this._indexInitialized = false;
  }

  /**
   * 确保索引已初始化（含旧版迁移）
   */
  async ensureIndex() {
    if (!this._indexInitialized) {
      await this.indexStore.init();
      this._indexInitialized = true;
    }
  }

  /**
   * 容量预检：检测集群剩余容量是否足够存储文件
   * @param {number} fileSize - 文件大小（bytes）
   * @param {object} options - { replicas }
   * @returns {object} { sufficient, requiredBytes, availableBytes, usageAfter, level, message }
   */
  async checkCapacity(fileSize, options = {}) {
    const nodes = await this.getAvailableNodes();
    if (nodes.length === 0) {
      return {
        sufficient: false,
        requiredBytes: fileSize,
        availableBytes: 0,
        usageAfter: 1,
        level: 'error',
        message: '无可用存储节点，请先运行 node start'
      };
    }

    const totalQuota = nodes.reduce((sum, n) => sum + (n.quota || 0), 0);
    const totalUsed = nodes.reduce((sum, n) => sum + (n.usedSpace || 0), 0);
    const availableBytes = totalQuota - totalUsed;

    // 解析副本数
    let replicas = options.replicas;
    if (replicas === undefined) {
      const global = await this.replicaConfig.getGlobal();
      replicas = global?.replicas || 3;
    }
    if (replicas === -1) replicas = nodes.length;

    const requiredBytes = fileSize * replicas;
    const sufficient = availableBytes >= requiredBytes;
    const usageAfter = totalQuota > 0 ? (totalUsed + requiredBytes) / totalQuota : 1;

    // 预警级别判定
    let level, message;
    if (!sufficient) {
      level = 'error';
      message = `集群容量不足：需要 ${this.formatBytes(requiredBytes)}（${this.formatBytes(fileSize)} × ${replicas} 副本），可用 ${this.formatBytes(availableBytes)}`;
    } else if (usageAfter > 0.9) {
      level = 'warning';
      message = `容量预警：上传后集群使用率将达 ${(usageAfter * 100).toFixed(1)}%（超过 90%），副本修复可能因空间不足而失败`;
    } else if (usageAfter > 0.8) {
      level = 'caution';
      message = `容量提示：上传后集群使用率将达 ${(usageAfter * 100).toFixed(1)}%，建议关注剩余空间`;
    } else {
      level = 'ok';
      message = null;
    }

    return {
      sufficient,
      requiredBytes,
      availableBytes,
      totalQuota,
      totalUsed,
      replicas,
      nodeCount: nodes.length,
      usageAfter,
      level,
      message
    };
  }

  /**
   * 获取集群容量报告（各节点使用率、剩余空间、健康状态）
   * @returns {object} 容量报告
   */
  async getCapacityReport() {
    const nodes = await this.getAvailableNodes();
    if (nodes.length === 0) {
      return { nodeCount: 0, totalQuota: 0, totalUsed: 0, availableBytes: 0, usageRate: 0, level: 'error', nodes: [] };
    }

    const totalQuota = nodes.reduce((sum, n) => sum + (n.quota || 0), 0);
    const totalUsed = nodes.reduce((sum, n) => sum + (n.usedSpace || 0), 0);
    const availableBytes = totalQuota - totalUsed;
    const usageRate = totalQuota > 0 ? totalUsed / totalQuota : 0;

    let level;
    if (usageRate > 0.9) level = 'critical';
    else if (usageRate > 0.8) level = 'warning';
    else if (usageRate > 0.6) level = 'caution';
    else level = 'healthy';

    const nodeDetails = nodes.map(n => ({
      nodeId: n.nodeId,
      quota: n.quota || 0,
      usedSpace: n.usedSpace || 0,
      freeSpace: (n.quota || 0) - (n.usedSpace || 0),
      usageRate: n.quota > 0 ? (n.usedSpace || 0) / n.quota : 0
    })).sort((a, b) => b.usageRate - a.usageRate);

    return {
      nodeCount: nodes.length,
      totalQuota,
      totalUsed,
      availableBytes,
      usageRate,
      level,
      nodes: nodeDetails
    };
  }

  /**
   * 上传文件到存储网络
   * @param {string} filePath - 文件路径
   * @param {object} options - 选项 { encrypt, key, replicas, onProgress }
   *   replicas: 显式指定副本数（覆盖配置）；不传则按冗余配置自动解析
   * @returns {object} 上传结果，包含 CID
   */
  async upload(filePath, options = {}) {
    const { encrypt = false, key, keyFile, replicas, onProgress } = options;
    await this.ensureIndex();

    // P0: 路径安全校验
    filePath = validateInputPath(filePath);

    // P0: 密钥安全解析（环境变量 > 密钥文件 > CLI 参数）
    const resolvedKey = encrypt ? resolveKey({ key, keyFile }) : null;
    if (encrypt && !resolvedKey) {
      throw new Error('加密上传需要提供密钥（环境变量 IPFS_STORAGE_KEY / --key-file / --key）');
    }

    // 验证文件存在
    if (!await fs.pathExists(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const stat = await fs.stat(filePath);
    const originalSize = stat.size;
    const fileName = path.basename(filePath);

    // 容量预检
    const capacity = await this.checkCapacity(originalSize, {
      replicas: replicas !== undefined ? parseInt(replicas) : undefined
    });
    if (!capacity.sufficient) {
      throw new Error(capacity.message);
    }

    // 分块存储：≥1MB 且未加密时使用 chunk DAG
    if (this.chunkStore.shouldChunk(originalSize) && !encrypt) {
      return await this.chunkedUploadFlow(filePath, { replicas, onProgress, fileName, originalSize, capacityWarning: capacity.level !== 'ok' ? capacity : null });
    }

    const useStream = originalSize > STREAM_THRESHOLD;

    let content;
    let cidString;

    if (useStream && !encrypt) {
      // 大文件流式处理：流式计算 CID，不全量加载
      const cidResult = await this.streamIO.computeFileCID(filePath, { onProgress });
      cidString = cidResult.cid;
      content = null; // 流式模式下延迟读取
    } else {
      // 小文件或加密模式：全量读取
      content = await fs.readFile(filePath);
      if (encrypt) {
        content = this.encryptContent(content, resolvedKey);
      }
      const hash = await sha256.sha256.digest(content);
      const cid = CID.create(1, 0x55, hash);
      cidString = cid.toString();
    }

    // 去重检查：如果 CID 已存在且未加密，直接返回
    if (!encrypt) {
      const existingInfo = await this.indexStore.get(cidString);
      if (existingInfo) {
        return {
          success: true,
          cid: cidString,
          fileName: existingInfo.fileName,
          size: existingInfo.size,
          sizeHuman: this.formatBytes(existingInfo.size),
          encrypted: existingInfo.encrypted,
          replicas: existingInfo.replicas,
          storedNodes: existingInfo.storedNodes,
          deduplicated: true
        };
      }
    }

    // 解析冗余参数（CLI 显式参数 > 文件类型规则 > 全局默认）
    const redundancy = await this.replicaConfig.resolve(fileName, originalSize, {
      replicas: replicas !== undefined ? parseInt(replicas) : undefined
    });

    // 分发到多个节点（冗余存储）
    let nodes = await this.getAvailableNodes();
    if (nodes.length === 0) {
      throw new Error('无可用存储节点，请先运行 node start');
    }

    // 按放置策略排序节点
    nodes = this.applyPlacementStrategy(nodes, redundancy.placement);

    const storedNodes = [];
    // replicas = -1 表示所有可用节点
    const targetCount = redundancy.replicas === -1
      ? nodes.length
      : Math.min(redundancy.replicas, nodes.length);

    for (let i = 0; i < targetCount; i++) {
      const node = nodes[i];
      try {
        if (useStream && !encrypt) {
          // 大文件流式写入节点
          await this.streamStoreToNode(node.nodeId, cidString, filePath, {
            fileName, originalSize, encrypted: false
          }, { onProgress });
        } else {
          await this.storeToNode(node.nodeId, cidString, content, {
            fileName, originalSize, encrypted: encrypt
          });
        }
        storedNodes.push(node.nodeId);
      } catch (err) {
        if (storedNodes.length === 0 && i === targetCount - 1) {
          throw new Error(`所有节点写入失败: ${err.message}`);
        }
      }
    }

    if (storedNodes.length === 0) {
      throw new Error('文件未能存储到任何节点');
    }

    // 更新文件索引（分片索引 + 原子写入）
    await this.indexStore.set(cidString, {
      cid: cidString,
      fileName,
      size: originalSize,
      contentSize: useStream ? originalSize : content.length,
      encrypted: encrypt,
      replicas: storedNodes.length,
      targetReplicas: redundancy.replicas === -1 ? storedNodes.length : redundancy.replicas,
      minReplicas: redundancy.minReplicas,
      placement: redundancy.placement,
      repairPriority: redundancy.repairPriority,
      redundancySource: redundancy.source,
      storedNodes,
      uploadedAt: new Date().toISOString(),
      checksum: cidString,
      streamed: useStream
    });

    return {
      success: true,
      cid: cidString,
      fileName,
      size: originalSize,
      sizeHuman: this.formatBytes(originalSize),
      encrypted: encrypt,
      replicas: storedNodes.length,
      targetReplicas: redundancy.replicas === -1 ? storedNodes.length : redundancy.replicas,
      minReplicas: redundancy.minReplicas,
      redundancySource: redundancy.source,
      storedNodes,
      deduplicated: false,
      streamed: useStream,
      capacityWarning: capacity.level !== 'ok' ? capacity : null
    };
  }

  /**
   * 分块上传流程（chunk DAG）
   * 文件被切分为 256KB chunk，每个 chunk 独立存储到不同节点
   */
  async chunkedUploadFlow(filePath, options = {}) {
    const { replicas, onProgress, fileName, originalSize, capacityWarning } = options;

    // 解析冗余参数
    const redundancy = await this.replicaConfig.resolve(fileName, originalSize, {
      replicas: replicas !== undefined ? parseInt(replicas) : undefined
    });

    // 去重检查：先计算文件整体 CID 用于索引查找
    const fileCidResult = await this.streamIO.computeFileCID(filePath);
    const existingInfo = await this.indexStore.get(fileCidResult.cid);
    if (existingInfo) {
      return {
        success: true,
        cid: existingInfo.cid,
        fileName: existingInfo.fileName,
        size: existingInfo.size,
        sizeHuman: this.formatBytes(existingInfo.size),
        encrypted: false,
        replicas: existingInfo.replicas,
        storedNodes: existingInfo.storedNodes,
        chunked: existingInfo.chunked || false,
        deduplicated: true
      };
    }

    // 执行分块上传
    const result = await this.chunkStore.chunkedUpload(filePath, {
      replicas: redundancy.replicas === -1 ? 999 : redundancy.replicas,
      onProgress,
      getAvailableNodes: () => this.getAvailableNodes(),
      storeChunkToNode: (nodeId, cid, data, metadata) =>
        this.storeToNode(nodeId, cid, data, metadata)
    });

    // 收集所有参与存储的节点
    const allNodes = new Set();
    for (const nodes of Object.values(result.chunkNodeMap)) {
      nodes.forEach(n => allNodes.add(n));
    }

    // 更新索引（使用文件整体 CID 作为主键，兼容 list/info 命令）
    await this.indexStore.set(fileCidResult.cid, {
      cid: fileCidResult.cid,
      rootCid: result.cid,
      fileName,
      size: originalSize,
      encrypted: false,
      replicas: allNodes.size,
      targetReplicas: redundancy.replicas === -1 ? allNodes.size : redundancy.replicas,
      minReplicas: redundancy.minReplicas,
      placement: redundancy.placement,
      repairPriority: redundancy.repairPriority,
      redundancySource: redundancy.source,
      storedNodes: [...allNodes],
      chunked: true,
      chunkCount: result.chunkCount,
      chunkSize: result.chunkSize,
      uploadedAt: new Date().toISOString(),
      checksum: fileCidResult.cid
    });

    return {
      success: true,
      cid: fileCidResult.cid,
      rootCid: result.cid,
      fileName,
      size: originalSize,
      sizeHuman: this.formatBytes(originalSize),
      encrypted: false,
      replicas: allNodes.size,
      targetReplicas: redundancy.replicas === -1 ? allNodes.size : redundancy.replicas,
      redundancySource: redundancy.source,
      storedNodes: [...allNodes],
      chunked: true,
      chunkCount: result.chunkCount,
      chunkSize: result.chunkSize,
      deduplicated: false,
      capacityWarning: capacityWarning || null
    };
  }

  /**
   * 按放置策略排序/选择节点
   * @param {object[]} nodes - 可用节点列表（已按剩余空间降序）
   * @param {string} strategy - space_first / round_robin / random
   */
  applyPlacementStrategy(nodes, strategy) {
    switch (strategy) {
      case 'round_robin':
        // 轮询分散：交替从头部和尾部取，确保分散
        const result = [];
        let left = 0, right = nodes.length - 1;
        let pickLeft = true;
        while (left <= right) {
          result.push(pickLeft ? nodes[left++] : nodes[right--]);
          pickLeft = !pickLeft;
        }
        return result;
      case 'random':
        // 随机打乱
        const shuffled = [...nodes];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
      case 'space_first':
      default:
        // 默认：剩余空间优先（getAvailableNodes 已排序）
        return nodes;
    }
  }

  /**
   * 流式存储到节点（大文件不全量加载）
   */
  async streamStoreToNode(nodeId, cid, filePath, metadata, options = {}) {
    const nodeDir = path.join(this.nodesDir, nodeId, 'blocks');
    await fs.ensureDir(nodeDir);

    // 检查配额
    const stat = await fs.stat(filePath);
    const configPath = path.join(this.nodesDir, nodeId, 'config.json');
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);
      const quota = Math.min(config.quota || MAX_QUOTA_PER_NODE, MAX_QUOTA_PER_NODE);
      if ((config.usedSpace || 0) + stat.size > quota) {
        throw new Error(`节点 ${nodeId} 存储空间不足`);
      }
    }

    // 流式复制到节点
    const blockPath = path.join(nodeDir, `${cid}.block`);
    await this.streamIO.streamCopy(filePath, blockPath, options);

    // 写入元数据
    const metaPath = path.join(nodeDir, `${cid}.meta.json`);
    await fs.writeJson(metaPath, { ...metadata, storedAt: new Date().toISOString() }, { spaces: 2 });

    // 更新配额
    await this.updateNodeUsage(nodeId, stat.size);
  }

  /**
   * 从存储网络下载文件（含完整性校验 + 多路径重试）
   * @param {string} cid - 文件 CID
   * @param {object} options - 选项 { output, decrypt, key, skipVerify }
   */
  async download(cid, options = {}) {
    const { output, decrypt = false, key, keyFile, skipVerify = false, onProgress } = options;
    await this.ensureIndex();

    // P0: 密钥安全解析
    const resolvedKey = (decrypt || key || keyFile) ? resolveKey({ key, keyFile }) : null;

    // 查找文件索引（分片索引）
    const fileInfo = await this.indexStore.get(cid);
    if (!fileInfo) {
      throw new Error(`文件不存在: ${cid}`);
    }

    // 分块文件：使用 chunk DAG 下载
    if (fileInfo.chunked && fileInfo.rootCid) {
      return await this.chunkedDownloadFlow(fileInfo, { output, onProgress });
    }

    // 多路径下载：依次尝试所有存储节点（网络不稳定容错）
    let content = null;
    let sourceNode = null;
    const errors = [];

    for (const nodeId of fileInfo.storedNodes) {
      try {
        const data = await this.readFromNode(nodeId, cid);
        if (data) {
          // 完整性校验：重新计算哈希并与 CID 比对
          if (!skipVerify) {
            const verified = await this.verifyContentIntegrity(data, cid);
            if (!verified) {
              errors.push({ nodeId, error: '完整性校验失败（数据损坏）' });
              continue; // 尝试下一个副本
            }
          }
          content = data;
          sourceNode = nodeId;
          break;
        }
      } catch (err) {
        errors.push({ nodeId, error: err.message });
        continue; // 尝试下一个节点
      }
    }

    if (!content) {
      const errorDetail = errors.length > 0
        ? `\n尝试过的节点: ${errors.map(e => `${e.nodeId}(${e.error})`).join(', ')}`
        : '';
      throw new Error(`无法从任何节点读取文件: ${cid}${errorDetail}`);
    }

    // 如果需要解密
    if (fileInfo.encrypted || decrypt) {
      if (!resolvedKey) {
        throw new Error('解密下载需要提供密钥（环境变量 IPFS_STORAGE_KEY / --key-file / --key）');
      }
      content = this.decryptContent(content, resolvedKey);
    }

    // P0: 输出路径安全校验
    const outputPath = validateOutputPath(output || fileInfo.fileName);
    await fs.writeFile(outputPath, content);

    return {
      success: true,
      cid,
      outputPath,
      size: content.length,
      sizeHuman: this.formatBytes(content.length),
      sourceNode,
      integrityVerified: !skipVerify
    };
  }

  /**
   * 分块下载流程：从多节点并行拉取 chunk 并组装
   */
  async chunkedDownloadFlow(fileInfo, options = {}) {
    const { output, onProgress } = options;
    const rootCid = fileInfo.rootCid;

    const result = await this.chunkStore.chunkedDownload(rootCid, {
      output,
      onProgress,
      readChunkFromNode: async (chunkCid) => {
        // 从所有存储节点中查找 chunk
        for (const nodeId of fileInfo.storedNodes) {
          const data = await this.readFromNode(nodeId, chunkCid);
          if (data) return data;
        }
        return null;
      },
      getDagFromNodes: async (dagCid) => {
        // 从所有存储节点中查找 DAG 根
        for (const nodeId of fileInfo.storedNodes) {
          const data = await this.readFromNode(nodeId, dagCid);
          if (data) {
            try {
              return JSON.parse(data.toString('utf8'));
            } catch (e) {
              continue;
            }
          }
        }
        return null;
      }
    });

    return {
      ...result,
      sizeHuman: this.formatBytes(result.size),
      integrityVerified: true,
      chunked: true
    };
  }

  /**
   * 验证内容完整性：重新计算 sha256 并与 CID 中的哈希比对
   */
  async verifyContentIntegrity(content, cidString) {
    try {
      const cid = CID.parse(cidString);
      const computedHash = await sha256.sha256.digest(content);
      // 比较 multihash 字节
      const originalBytes = cid.multihash.bytes;
      const computedBytes = computedHash.bytes;
      if (originalBytes.length !== computedBytes.length) return false;
      for (let i = 0; i < originalBytes.length; i++) {
        if (originalBytes[i] !== computedBytes[i]) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 获取文件信息
   */
  async getInfo(cid) {
    await this.ensureIndex();
    const fileInfo = await this.indexStore.get(cid);
    if (!fileInfo) {
      return { success: false, error: `文件不存在: ${cid}` };
    }

    // 实时检查各副本可用性
    const replicaStatus = [];
    for (const nodeId of fileInfo.storedNodes) {
      const exists = await this.checkBlockExists(nodeId, cid);
      replicaStatus.push({ nodeId, available: exists });
    }

    return {
      success: true,
      ...fileInfo,
      sizeHuman: this.formatBytes(fileInfo.size),
      replicaStatus,
      availableReplicas: replicaStatus.filter(r => r.available).length
    };
  }

  /**
   * 检查 block 是否存在于指定节点
   */
  async checkBlockExists(nodeId, cid) {
    const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${cid}.block`);
    return await fs.pathExists(blockPath);
  }

  /**
   * 生成加密密钥
   */
  generateKey() {
    const key = CryptoJS.lib.WordArray.random(32).toString();
    return {
      key,
      algorithm: 'AES-256',
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 加密内容
   */
  encryptContent(content, key) {
    const contentBase64 = content.toString('base64');
    const encrypted = CryptoJS.AES.encrypt(contentBase64, key).toString();
    return Buffer.from(encrypted, 'utf8');
  }

  /**
   * 解密内容
   */
  decryptContent(content, key) {
    const encryptedStr = content.toString('utf8');
    const decrypted = CryptoJS.AES.decrypt(encryptedStr, key);
    const contentBase64 = decrypted.toString(CryptoJS.enc.Utf8);
    return Buffer.from(contentBase64, 'base64');
  }

  /**
   * 存储到指定节点（含配额检查）
   */
  async storeToNode(nodeId, cid, content, metadata) {
    const nodeDir = path.join(this.nodesDir, nodeId, 'blocks');
    await fs.ensureDir(nodeDir);

    // 检查节点配额（100MB 上限）
    const configPath = path.join(this.nodesDir, nodeId, 'config.json');
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);
      const quota = Math.min(config.quota || MAX_QUOTA_PER_NODE, MAX_QUOTA_PER_NODE);
      if ((config.usedSpace || 0) + content.length > quota) {
        throw new Error(`节点 ${nodeId} 存储空间不足（上限 100MB），当前已用 ${this.formatBytes(config.usedSpace || 0)}`);
      }
    }

    // 存储内容
    const blockPath = path.join(nodeDir, `${cid}.block`);
    await fs.writeFile(blockPath, content);

    // 存储元数据
    const metaPath = path.join(nodeDir, `${cid}.meta.json`);
    await fs.writeJson(metaPath, {
      ...metadata,
      storedAt: new Date().toISOString()
    }, { spaces: 2 });

    // 更新节点使用空间
    await this.updateNodeUsage(nodeId, content.length);
  }

  /**
   * 从节点读取
   */
  async readFromNode(nodeId, cid) {
    const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${cid}.block`);
    if (!await fs.pathExists(blockPath)) {
      return null;
    }
    return await fs.readFile(blockPath);
  }

  /**
   * 更新节点使用空间（增量）
   */
  async updateNodeUsage(nodeId, addedBytes) {
    const configPath = path.join(this.nodesDir, nodeId, 'config.json');
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);
      config.usedSpace = Math.max(0, (config.usedSpace || 0) + addedBytes);
      await fs.writeJson(configPath, config, { spaces: 2 });
    }
  }

  /**
   * 获取可用节点列表（按剩余空间降序）
   */
  async getAvailableNodes() {
    const nodes = [];
    if (!await fs.pathExists(this.nodesDir)) {
      return nodes;
    }

    const dirs = await fs.readdir(this.nodesDir);
    for (const dir of dirs) {
      if (dir.startsWith('node-')) {
        const configPath = path.join(this.nodesDir, dir, 'config.json');
        if (await fs.pathExists(configPath)) {
          const config = await fs.readJson(configPath);
          if (config.status === 'running') {
            nodes.push(config);
          }
        }
      }
    }

    // 按剩余空间排序（优先写入空间充足的节点）
    return nodes.sort((a, b) => 
      (b.quota - b.usedSpace) - (a.quota - a.usedSpace)
    );
  }

  /**
   * 更新文件索引（委托给分片索引，原子写入）
   */
  async updateFileIndex(cid, info) {
    await this.ensureIndex();
    await this.indexStore.set(cid, info);
  }

  /**
   * 获取文件索引（委托给分片索引）
   */
  async getFileIndex(cid) {
    await this.ensureIndex();
    return await this.indexStore.get(cid);
  }

  /**
   * 获取完整索引（遍历所有分片）
   */
  async getFullIndex() {
    await this.ensureIndex();
    return await this.indexStore.getAll();
  }

  /**
   * 列出所有文件
   */
  async listFiles() {
    const index = await this.getFullIndex();
    return Object.values(index).map(f => ({
      ...f,
      sizeHuman: this.formatBytes(f.size)
    }));
  }

  /**
   * 删除文件（正确更新节点配额 + 分片索引删除）
   */
  async deleteFile(cid) {
    await this.ensureIndex();
    const fileInfo = await this.indexStore.get(cid);
    if (!fileInfo) {
      return { success: false, error: `文件不存在: ${cid}` };
    }

    // 分块文件：删除所有 chunk + DAG 根
    if (fileInfo.chunked && fileInfo.rootCid) {
      return await this.deleteChunkedFile(fileInfo);
    }

    // 从所有节点删除，并更新各节点 usedSpace
    for (const nodeId of fileInfo.storedNodes) {
      const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${cid}.block`);
      const metaPath = path.join(this.nodesDir, nodeId, 'blocks', `${cid}.meta.json`);

      if (await fs.pathExists(blockPath)) {
        const stat = await fs.stat(blockPath);
        await fs.remove(blockPath);
        await fs.remove(metaPath);
        // 正确减少节点已用空间
        await this.updateNodeUsage(nodeId, -stat.size);
      }
    }

    // 从分片索引删除
    await this.indexStore.delete(cid);

    return { success: true, cid, freedNodes: fileInfo.storedNodes.length };
  }

  /**
   * 删除分块文件：遍历 DAG 删除所有 chunk 和根节点
   */
  async deleteChunkedFile(fileInfo) {
    const rootCid = fileInfo.rootCid;
    let deletedBlocks = 0;

    // 获取 DAG 根以得到 chunk 列表
    let dagNode = null;
    for (const nodeId of fileInfo.storedNodes) {
      const data = await this.readFromNode(nodeId, rootCid);
      if (data) {
        try {
          dagNode = JSON.parse(data.toString('utf8'));
          break;
        } catch (e) { continue; }
      }
    }

    // 删除所有 chunk
    if (dagNode && dagNode.chunks) {
      for (const chunkMeta of dagNode.chunks) {
        for (const nodeId of fileInfo.storedNodes) {
          const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${chunkMeta.cid}.block`);
          const metaPath = path.join(this.nodesDir, nodeId, 'blocks', `${chunkMeta.cid}.meta.json`);
          if (await fs.pathExists(blockPath)) {
            const stat = await fs.stat(blockPath);
            await fs.remove(blockPath);
            await fs.remove(metaPath);
            await this.updateNodeUsage(nodeId, -stat.size);
            deletedBlocks++;
          }
        }
      }
    }

    // 删除 DAG 根节点
    for (const nodeId of fileInfo.storedNodes) {
      const blockPath = path.join(this.nodesDir, nodeId, 'blocks', `${rootCid}.block`);
      const metaPath = path.join(this.nodesDir, nodeId, 'blocks', `${rootCid}.meta.json`);
      if (await fs.pathExists(blockPath)) {
        const stat = await fs.stat(blockPath);
        await fs.remove(blockPath);
        await fs.remove(metaPath);
        await this.updateNodeUsage(nodeId, -stat.size);
        deletedBlocks++;
      }
    }

    // 从索引删除
    await this.indexStore.delete(fileInfo.cid);

    return {
      success: true,
      cid: fileInfo.cid,
      rootCid,
      chunked: true,
      deletedBlocks,
      freedNodes: fileInfo.storedNodes.length
    };
  }

  /**
   * 验证分块文件完整性（CLI chunk verify 使用）
   */
  async verifyChunkedFile(cid) {
    await this.ensureIndex();
    const fileInfo = await this.indexStore.get(cid);
    if (!fileInfo) {
      return { success: false, error: `文件不存在: ${cid}` };
    }
    if (!fileInfo.chunked || !fileInfo.rootCid) {
      return { success: false, error: '该文件不是分块存储文件' };
    }

    return await this.chunkStore.verifyChunkedFile(fileInfo.rootCid, {
      readChunkFromNode: async (chunkCid) => {
        for (const nodeId of fileInfo.storedNodes) {
          const data = await this.readFromNode(nodeId, chunkCid);
          if (data) return data;
        }
        return null;
      },
      getDagFromNodes: async (dagCid) => {
        for (const nodeId of fileInfo.storedNodes) {
          const data = await this.readFromNode(nodeId, dagCid);
          if (data) {
            try { return JSON.parse(data.toString('utf8')); } catch (e) { continue; }
          }
        }
        return null;
      }
    });
  }

  /**
   * 获取分块文件详细信息（CLI chunk info 使用）
   */
  async getChunkInfo(cid) {
    await this.ensureIndex();
    const fileInfo = await this.indexStore.get(cid);
    if (!fileInfo) {
      return { success: false, error: `文件不存在: ${cid}` };
    }
    if (!fileInfo.chunked || !fileInfo.rootCid) {
      return { success: false, error: '该文件不是分块存储文件' };
    }

    return await this.chunkStore.getChunkInfo(fileInfo.rootCid, {
      getDagFromNodes: async (dagCid) => {
        for (const nodeId of fileInfo.storedNodes) {
          const data = await this.readFromNode(nodeId, dagCid);
          if (data) {
            try { return JSON.parse(data.toString('utf8')); } catch (e) { continue; }
          }
        }
        return null;
      }
    });
  }

  /**
   * 修复分块文件的 chunk 副本（CLI chunk repair 使用）
   * 检测降级 chunk 并从健康副本重新分发到缺失节点
   */
  async repairChunkedFile(cid, options = {}) {
    const { dryRun = false, onProgress } = options;
    await this.ensureIndex();
    const fileInfo = await this.indexStore.get(cid);
    if (!fileInfo) {
      return { success: false, error: `文件不存在: ${cid}` };
    }
    if (!fileInfo.chunked || !fileInfo.rootCid) {
      return { success: false, error: '该文件不是分块存储文件' };
    }

    // 从节点读取 DAG 根
    let dagNode = null;
    for (const nodeId of fileInfo.storedNodes) {
      const data = await this.readFromNode(nodeId, fileInfo.rootCid);
      if (data) {
        try { dagNode = JSON.parse(data.toString('utf8')); break; } catch (e) { continue; }
      }
    }
    if (!dagNode) {
      return { success: false, error: '无法读取 DAG 根节点' };
    }

    // 执行修复（扫描所有在线节点，发现 storedNodes 之外的副本）
    const targetReplicas = fileInfo.targetReplicas || fileInfo.replicas || 3;
    const allNodes = await this.getAvailableNodes();
    const allNodeIds = allNodes.map(n => n.nodeId);
    const report = await this.chunkRepair.repairChunks(
      dagNode, fileInfo.storedNodes, targetReplicas,
      { dryRun, onProgress, allNodes: allNodeIds }
    );

    return {
      success: true,
      fileName: fileInfo.fileName,
      dryRun,
      ...report
    };
  }

  /**
   * 更新索引中文件的 storedNodes（副本修复后调用）
   */
  async updateReplicaList(cid, storedNodes) {
    await this.ensureIndex();
    await this.indexStore.updateReplicaList(cid, storedNodes);
  }

  /**
   * 获取索引统计信息（分片分布、文件数、总大小）
   */
  async getIndexStats() {
    await this.ensureIndex();
    return await this.indexStore.getStats();
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export default FileOperations;
