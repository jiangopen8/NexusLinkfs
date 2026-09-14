/**
 * IPFS 分布式存储网络 - 分块存储模块（Chunk DAG）
 * 
 * 实现真正的文件分块存储：
 * - 文件按固定大小（默认 256KB）切分为 chunk
 * - 每个 chunk 独立计算 CID，可分布存储到不同节点
 * - 根 DAG 节点记录所有 chunk 的有序 CID 列表
 * - 下载时从多节点并行拉取 chunk，组装后校验完整性
 * 
 * DAG 结构：
 *   RootCID → { type: 'dag-root', chunks: [chunkCID_0, chunkCID_1, ...] }
 *   ChunkCID_N → 原始二进制数据（256KB）
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { CID } from 'multiformats/cid';
import * as sha256 from 'multiformats/hashes/sha2';

const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256KB
const CHUNK_THRESHOLD = 1 * 1024 * 1024; // ≥1MB 启用分块
const MAX_PARALLEL_DOWNLOADS = 4; // 并行下载 chunk 数上限

export class ChunkStore {
  constructor(nodesDir = '/home/project/.ipfs-nodes') {
    this.nodesDir = nodesDir;
    this.chunkSize = DEFAULT_CHUNK_SIZE;
  }

  /**
   * 判断文件是否需要分块存储
   */
  shouldChunk(fileSize) {
    return fileSize >= CHUNK_THRESHOLD;
  }

  /**
   * 计算 Buffer 的 CID
   */
  async computeCID(data) {
    const hash = await sha256.sha256.digest(data);
    const cid = CID.create(1, 0x55, hash);
    return cid.toString();
  }

  /**
   * 将文件分块，返回 chunk 列表（含各 chunk 的 CID 和数据）
   * @param {string} filePath - 源文件路径
   * @param {object} options - { onProgress }
   * @returns {object} { chunks: [{ index, cid, data, size }], totalSize, chunkCount }
   */
  async splitFile(filePath, options = {}) {
    const { onProgress } = options;
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    const chunks = [];

    const stream = fs.createReadStream(filePath, {
      highWaterMark: this.chunkSize
    });

    let processed = 0;
    let index = 0;

    for await (const chunk of stream) {
      // 确保 chunk 不超过 chunkSize（ReadStream 可能返回更大块）
      const pieces = this.sliceBuffer(chunk, this.chunkSize);
      for (const piece of pieces) {
        const cid = await this.computeCID(piece);
        chunks.push({ index, cid, data: piece, size: piece.length });
        processed += piece.length;
        index++;
        if (onProgress) {
          onProgress({ processed, total: fileSize, percent: (processed / fileSize * 100).toFixed(1) });
        }
      }
    }

    return { chunks, totalSize: fileSize, chunkCount: chunks.length };
  }

  /**
   * 将 Buffer 按固定大小切片
   */
  sliceBuffer(buffer, size) {
    const pieces = [];
    for (let offset = 0; offset < buffer.length; offset += size) {
      pieces.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    }
    return pieces;
  }

  /**
   * 构建 DAG 根节点（包含所有 chunk CID 的有序列表）
   * @param {object} splitResult - splitFile 的返回值
   * @param {object} metadata - 文件元数据 { fileName, size, encrypted }
   * @returns {object} { rootCid, dagNode }
   */
  async buildDagRoot(splitResult, metadata) {
    const dagNode = {
      type: 'dag-root',
      version: 1,
      fileName: metadata.fileName,
      fileSize: splitResult.totalSize,
      chunkSize: this.chunkSize,
      chunkCount: splitResult.chunkCount,
      chunks: splitResult.chunks.map(c => ({
        index: c.index,
        cid: c.cid,
        size: c.size
      })),
      createdAt: new Date().toISOString()
    };

    // DAG 根节点的 CID = 对 DAG JSON 序列化后取哈希
    const dagBytes = Buffer.from(JSON.stringify(dagNode), 'utf8');
    const rootCid = await this.computeCID(dagBytes);

    return { rootCid, dagNode, dagBytes };
  }

  /**
   * 分块上传：将文件分块并分布存储到多个节点
   * 每个 chunk 独立存储，不同 chunk 可落在不同节点上
   * @param {string} filePath - 源文件路径
   * @param {object} options - { replicas, placement, onProgress, getAvailableNodes, storeChunkToNode }
   * @returns {object} 上传结果
   */
  async chunkedUpload(filePath, options = {}) {
    const { replicas = 3, onProgress, getAvailableNodes, storeChunkToNode } = options;

    // 1. 分块
    const splitResult = await this.splitFile(filePath, { onProgress });

    // 2. 构建 DAG 根
    const fileName = path.basename(filePath);
    const { rootCid, dagNode, dagBytes } = await this.buildDagRoot(splitResult, {
      fileName,
      size: splitResult.totalSize,
      encrypted: false
    });

    // 3. 获取可用节点
    const nodes = await getAvailableNodes();
    if (nodes.length === 0) {
      throw new Error('无可用存储节点');
    }

    // 4. 分发 chunk 到节点（间隔分散策略，确保 chunk 副本最大化分散）
    // 设计：每个 chunk 的 replicas 个副本分别取节点列表中间隔 nodeCount/replicas 的位置
    // 例如 18 节点 3 副本：chunk0 → [0,6,12], chunk1 → [1,7,13], chunk2 → [2,8,14]...
    // 这样任意连续 N 个节点故障最多只影响每个 chunk 的 1 个副本，不会整组丢失
    const chunkNodeMap = {}; // chunkCid → [nodeId, ...]
    const nodeCount = nodes.length;
    const targetReplicas = Math.min(replicas, nodeCount);
    // 间隔步长：确保同一 chunk 的副本分布在节点列表的不同区域
    const stride = Math.max(1, Math.floor(nodeCount / targetReplicas));

    for (const chunk of splitResult.chunks) {
      // 间隔分散：chunk.index 作为起始偏移，每个副本间隔 stride 个节点
      const startOffset = chunk.index % nodeCount;
      const storedNodes = [];

      for (let r = 0; r < targetReplicas; r++) {
        const nodeIdx = (startOffset + r * stride) % nodeCount;
        const node = nodes[nodeIdx];
        try {
          await storeChunkToNode(node.nodeId, chunk.cid, chunk.data, {
            type: 'chunk',
            chunkIndex: chunk.index,
            rootCid,
            size: chunk.size
          });
          storedNodes.push(node.nodeId);
        } catch (err) {
          // 节点写入失败，尝试相邻节点
          const fallbackIdx = (nodeIdx + 1) % nodeCount;
          const fallbackNode = nodes[fallbackIdx];
          if (!storedNodes.includes(fallbackNode.nodeId)) {
            try {
              await storeChunkToNode(fallbackNode.nodeId, chunk.cid, chunk.data, {
                type: 'chunk',
                chunkIndex: chunk.index,
                rootCid,
                size: chunk.size
              });
              storedNodes.push(fallbackNode.nodeId);
            } catch (e2) {
              if (storedNodes.length === 0 && r === targetReplicas - 1) {
                throw new Error(`chunk ${chunk.index} 无法存储到任何节点: ${err.message}`);
              }
            }
          }
        }
      }

      if (storedNodes.length === 0) {
        throw new Error(`chunk ${chunk.index} 未能存储到任何节点`);
      }
      chunkNodeMap[chunk.cid] = storedNodes;
    }

    // 5. 存储 DAG 根节点到所有节点（确保任何节点都能解析文件结构）
    for (const node of nodes) {
      try {
        await storeChunkToNode(node.nodeId, rootCid, dagBytes, {
          type: 'dag-root',
          fileName,
          fileSize: splitResult.totalSize,
          chunkCount: splitResult.chunkCount
        });
      } catch (err) {
        // DAG 根存储失败不致命，只要部分节点有即可
      }
    }

    return {
      success: true,
      cid: rootCid,
      fileName,
      size: splitResult.totalSize,
      chunkCount: splitResult.chunkCount,
      chunkSize: this.chunkSize,
      chunkNodeMap,
      chunked: true
    };
  }

  /**
   * 分块下载：从多节点并行拉取 chunk 并组装
   * @param {string} rootCid - DAG 根 CID
   * @param {object} options - { output, onProgress, readChunkFromNode, getDagFromNodes }
   * @returns {object} 下载结果
   */
  async chunkedDownload(rootCid, options = {}) {
    const { output, onProgress, readChunkFromNode, getDagFromNodes } = options;

    // 1. 获取 DAG 根节点
    const dagNode = await getDagFromNodes(rootCid);
    if (!dagNode) {
      throw new Error(`无法获取 DAG 根节点: ${rootCid}`);
    }

    const { chunks, fileSize, fileName } = dagNode;
    const totalChunks = chunks.length;

    // 2. 并行下载 chunk（带并发限制）
    const downloadedChunks = new Array(totalChunks);
    let completed = 0;

    // 分批并行下载
    for (let batchStart = 0; batchStart < totalChunks; batchStart += MAX_PARALLEL_DOWNLOADS) {
      const batchEnd = Math.min(batchStart + MAX_PARALLEL_DOWNLOADS, totalChunks);
      const batchPromises = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const chunkMeta = chunks[i];
        batchPromises.push(
          this.downloadSingleChunk(chunkMeta, readChunkFromNode)
            .then(data => {
              downloadedChunks[i] = data;
              completed++;
              if (onProgress) {
                onProgress({
                  processed: completed,
                  total: totalChunks,
                  percent: (completed / totalChunks * 100).toFixed(1)
                });
              }
            })
        );
      }

      await Promise.all(batchPromises);
    }

    // 3. 组装文件
    const assembled = Buffer.concat(downloadedChunks);

    // 4. 校验组装后的文件大小
    if (assembled.length !== fileSize) {
      throw new Error(`组装后文件大小不匹配: 期望 ${fileSize}, 实际 ${assembled.length}`);
    }

    // 5. 写入输出文件
    const outputPath = output || fileName;
    await fs.ensureDir(path.dirname(outputPath) || '.');
    await fs.writeFile(outputPath, assembled);

    return {
      success: true,
      cid: rootCid,
      outputPath,
      size: assembled.length,
      chunkCount: totalChunks,
      chunked: true
    };
  }

  /**
   * 下载单个 chunk（带 CID 校验 + 多节点重试）
   */
  async downloadSingleChunk(chunkMeta, readChunkFromNode) {
    const data = await readChunkFromNode(chunkMeta.cid);
    if (!data) {
      throw new Error(`chunk ${chunkMeta.index} (${chunkMeta.cid}) 无法从任何节点读取`);
    }

    // 校验 chunk CID
    const computedCid = await this.computeCID(data);
    if (computedCid !== chunkMeta.cid) {
      throw new Error(`chunk ${chunkMeta.index} 完整性校验失败: CID 不匹配`);
    }

    return data;
  }

  /**
   * 验证分块文件的完整性
   * @param {string} rootCid - DAG 根 CID
   * @param {object} options - { readChunkFromNode, getDagFromNodes }
   * @returns {object} 验证结果
   */
  async verifyChunkedFile(rootCid, options = {}) {
    const { readChunkFromNode, getDagFromNodes } = options;

    const dagNode = await getDagFromNodes(rootCid);
    if (!dagNode) {
      return { success: false, error: '无法获取 DAG 根节点' };
    }

    const results = [];
    let allValid = true;

    for (const chunkMeta of dagNode.chunks) {
      try {
        const data = await readChunkFromNode(chunkMeta.cid);
        if (!data) {
          results.push({ index: chunkMeta.index, cid: chunkMeta.cid, valid: false, error: '数据缺失' });
          allValid = false;
          continue;
        }

        const computedCid = await this.computeCID(data);
        const valid = computedCid === chunkMeta.cid;
        results.push({ index: chunkMeta.index, cid: chunkMeta.cid, valid, size: data.length });
        if (!valid) allValid = false;
      } catch (err) {
        results.push({ index: chunkMeta.index, cid: chunkMeta.cid, valid: false, error: err.message });
        allValid = false;
      }
    }

    return {
      success: true,
      rootCid,
      fileName: dagNode.fileName,
      fileSize: dagNode.fileSize,
      chunkCount: dagNode.chunks.length,
      allValid,
      validChunks: results.filter(r => r.valid).length,
      invalidChunks: results.filter(r => !r.valid).length,
      details: results
    };
  }

  /**
   * 获取分块文件信息
   */
  async getChunkInfo(rootCid, options = {}) {
    const { getDagFromNodes } = options;
    const dagNode = await getDagFromNodes(rootCid);
    if (!dagNode) {
      return { success: false, error: '非分块文件或 DAG 根不存在' };
    }

    return {
      success: true,
      rootCid,
      fileName: dagNode.fileName,
      fileSize: dagNode.fileSize,
      chunkSize: dagNode.chunkSize,
      chunkCount: dagNode.chunkCount,
      chunks: dagNode.chunks,
      createdAt: dagNode.createdAt
    };
  }
}

export default ChunkStore;
