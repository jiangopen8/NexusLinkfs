/**
 * IPFS 分布式存储网络 - 文件冗余参数配置模块
 * 
 * 商用级冗余策略设计：
 * - 全局默认参数（副本数、放置策略、最小副本数）
 * - 按文件类型规则（不同扩展名/大小可配置不同冗余等级）
 * - 冗余等级预设（standard / high / critical）
 * - 持久化配置（JSON 文件，原子写入）
 * - 上传时自动匹配规则，CLI 参数可覆盖
 * 
 * 参数说明：
 * - replicas: 目标副本数（实际存储份数）
 * - minReplicas: 最小可接受副本数（低于此值触发修复告警）
 * - placement: 放置策略（space_first=剩余空间优先 / round_robin=轮询 / random=随机）
 * - repairPriority: 修复优先级（high=优先修复 / normal=正常 / low=延迟修复）
 */

import fs from 'fs-extra';
import path from 'path';

const NODES_DIR = '/home/project/.ipfs-nodes';

// 冗余等级预设
const REDUNDANCY_PRESETS = {
  standard: {
    label: '标准',
    description: '适用于普通文件，3 副本，空间优先放置',
    replicas: 3,
    minReplicas: 2,
    placement: 'space_first',
    repairPriority: 'normal'
  },
  high: {
    label: '高冗余',
    description: '适用于重要文件，5 副本，轮询放置确保分散',
    replicas: 5,
    minReplicas: 3,
    placement: 'round_robin',
    repairPriority: 'high'
  },
  critical: {
    label: '关键',
    description: '适用于核心数据，所有可用节点均存储副本',
    replicas: -1, // -1 表示所有可用节点
    minReplicas: 5,
    placement: 'round_robin',
    repairPriority: 'high'
  }
};

// 默认全局配置
const DEFAULT_CONFIG = {
  level: 'standard',
  replicas: 3,
  minReplicas: 2,
  placement: 'space_first',
  repairPriority: 'normal',
  rules: [],
  updatedAt: null
};

export class ReplicaConfig {
  constructor(nodesDir = NODES_DIR) {
    this.nodesDir = nodesDir;
    this.configPath = path.join(nodesDir, 'replica-config.json');
    this._config = null;
  }

  /**
   * 加载配置（不存在则创建默认配置）
   */
  async load() {
    if (this._config) return this._config;

    if (await fs.pathExists(this.configPath)) {
      this._config = await fs.readJson(this.configPath);
    } else {
      this._config = { ...DEFAULT_CONFIG };
      await this.save();
    }
    return this._config;
  }

  /**
   * 保存配置（原子写入：tmp + rename）
   */
  async save() {
    this._config.updatedAt = new Date().toISOString();
    const tmpPath = this.configPath + `.tmp.${process.pid}`;
    await fs.ensureDir(path.dirname(this.configPath));
    await fs.writeJson(tmpPath, this._config, { spaces: 2 });
    await fs.rename(tmpPath, this.configPath);
  }

  /**
   * 获取当前全局冗余参数
   */
  async getGlobal() {
    const config = await this.load();
    return {
      level: config.level,
      replicas: config.replicas,
      minReplicas: config.minReplicas,
      placement: config.placement,
      repairPriority: config.repairPriority,
      preset: REDUNDANCY_PRESETS[config.level] || null
    };
  }

  /**
   * 设置全局冗余参数
   * @param {object} params - { level, replicas, minReplicas, placement, repairPriority }
   */
  async setGlobal(params) {
    const config = await this.load();

    if (params.level) {
      if (!REDUNDANCY_PRESETS[params.level]) {
        throw new Error(`未知冗余等级: ${params.level}（可选: ${Object.keys(REDUNDANCY_PRESETS).join(', ')}）`);
      }
      config.level = params.level;
      // 应用预设值
      const preset = REDUNDANCY_PRESETS[params.level];
      config.replicas = preset.replicas;
      config.minReplicas = preset.minReplicas;
      config.placement = preset.placement;
      config.repairPriority = preset.repairPriority;
    }

    // 手动覆盖单个参数（优先级高于预设）
    if (params.replicas !== undefined) {
      const r = parseInt(params.replicas);
      if (r < 1 && r !== -1) throw new Error('副本数必须 >= 1 或 -1（全节点）');
      if (r > 100) throw new Error('副本数不能超过 100');
      config.replicas = r;
    }
    if (params.minReplicas !== undefined) {
      const m = parseInt(params.minReplicas);
      if (m < 1) throw new Error('最小副本数必须 >= 1');
      config.minReplicas = m;
    }
    if (params.placement !== undefined) {
      const valid = ['space_first', 'round_robin', 'random'];
      if (!valid.includes(params.placement)) {
        throw new Error(`无效放置策略: ${params.placement}（可选: ${valid.join(', ')}）`);
      }
      config.placement = params.placement;
    }
    if (params.repairPriority !== undefined) {
      const valid = ['high', 'normal', 'low'];
      if (!valid.includes(params.repairPriority)) {
        throw new Error(`无效修复优先级: ${params.repairPriority}（可选: ${valid.join(', ')}）`);
      }
      config.repairPriority = params.repairPriority;
    }

    await this.save();
    return this.getGlobal();
  }

  /**
   * 重置为默认配置
   */
  async reset() {
    this._config = { ...DEFAULT_CONFIG, rules: [] };
    await this.save();
    return this.getGlobal();
  }

  /**
   * 添加文件类型规则
   * @param {object} rule - { pattern, replicas, minReplicas, placement, repairPriority }
   *   pattern 支持：扩展名（.pdf）、通配符（*.log）、大小条件（>10MB, <1KB）
   */
  async addRule(rule) {
    if (!rule.pattern) throw new Error('规则必须包含 pattern（匹配模式）');

    const config = await this.load();
    // 去重：相同 pattern 覆盖
    config.rules = config.rules.filter(r => r.pattern !== rule.pattern);

    const newRule = {
      pattern: rule.pattern,
      replicas: rule.replicas !== undefined ? parseInt(rule.replicas) : config.replicas,
      minReplicas: rule.minReplicas !== undefined ? parseInt(rule.minReplicas) : config.minReplicas,
      placement: rule.placement || config.placement,
      repairPriority: rule.repairPriority || config.repairPriority,
      createdAt: new Date().toISOString()
    };

    config.rules.push(newRule);
    await this.save();
    return newRule;
  }

  /**
   * 删除规则
   */
  async removeRule(pattern) {
    const config = await this.load();
    const before = config.rules.length;
    config.rules = config.rules.filter(r => r.pattern !== pattern);
    if (config.rules.length === before) {
      return { success: false, error: `未找到规则: ${pattern}` };
    }
    await this.save();
    return { success: true, pattern };
  }

  /**
   * 列出所有规则
   */
  async listRules() {
    const config = await this.load();
    return config.rules;
  }

  /**
   * 解析文件应使用的冗余参数（核心方法）
   * 优先级：CLI 显式参数 > 文件类型规则 > 全局默认
   * @param {string} fileName - 文件名
   * @param {number} fileSize - 文件大小（字节）
   * @param {object} cliOverrides - CLI 显式指定的参数 { replicas }
   * @returns {object} 最终冗余参数
   */
  async resolve(fileName, fileSize, cliOverrides = {}) {
    const config = await this.load();

    // 1. 尝试匹配规则
    let matched = null;
    for (const rule of config.rules) {
      if (this.matchPattern(rule.pattern, fileName, fileSize)) {
        matched = rule;
        break; // 第一条匹配的规则生效
      }
    }

    // 2. 组装最终参数
    const base = matched || config;
    const result = {
      replicas: cliOverrides.replicas !== undefined ? cliOverrides.replicas : base.replicas,
      minReplicas: base.minReplicas,
      placement: base.placement,
      repairPriority: base.repairPriority,
      source: cliOverrides.replicas !== undefined ? 'cli' : matched ? `rule:${matched.pattern}` : 'global'
    };

    // 3. 确保 minReplicas 不超过 replicas
    if (result.replicas > 0 && result.minReplicas > result.replicas) {
      result.minReplicas = result.replicas;
    }

    return result;
  }

  /**
   * 模式匹配
   * 支持：
   * - 扩展名：.pdf, .jpg, .mp4
   * - 通配符：*.log, backup-*
   * - 大小条件：>10MB, <1KB, >=5MB
   */
  matchPattern(pattern, fileName, fileSize) {
    // 大小条件匹配
    if (pattern.startsWith('>') || pattern.startsWith('<') || pattern.startsWith('>=')) {
      const sizeThreshold = this.parseSize(pattern.replace(/^[><=]+/, ''));
      if (pattern.startsWith('>=')) return fileSize >= sizeThreshold;
      if (pattern.startsWith('>')) return fileSize > sizeThreshold;
      if (pattern.startsWith('<')) return fileSize < sizeThreshold;
    }

    // 扩展名匹配
    if (pattern.startsWith('.')) {
      return fileName.toLowerCase().endsWith(pattern.toLowerCase());
    }

    // 通配符匹配
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
        'i'
      );
      return regex.test(fileName);
    }

    // 精确文件名匹配
    return fileName === pattern;
  }

  /**
   * 解析大小字符串为字节数
   */
  parseSize(str) {
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return Math.round(value * (multipliers[unit] || 1));
  }

  /**
   * 获取所有预设等级
   */
  getPresets() {
    return REDUNDANCY_PRESETS;
  }

  /**
   * 格式化配置为可读文本
   */
  formatConfig(config) {
    const lines = [];
    lines.push(`冗余等级: ${config.level} (${REDUNDANCY_PRESETS[config.level]?.label || '自定义'})`);
    lines.push(`目标副本数: ${config.replicas === -1 ? '所有可用节点' : config.replicas}`);
    lines.push(`最小副本数: ${config.minReplicas}（低于此值触发修复）`);
    lines.push(`放置策略: ${this.formatPlacement(config.placement)}`);
    lines.push(`修复优先级: ${config.repairPriority}`);
    return lines;
  }

  formatPlacement(p) {
    const map = {
      space_first: '剩余空间优先',
      round_robin: '轮询分散',
      random: '随机'
    };
    return map[p] || p;
  }
}

export default ReplicaConfig;
