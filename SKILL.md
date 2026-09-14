---
name: ipfs-storage-network
description: 基于 IPFS/libp2p 的分布式文件存储网络，支持多节点冗余、内容寻址、分块存储、插件热加载和插件市场。当用户提到分布式存储、IPFS、P2P 文件共享、去中心化存储、节点管理、插件系统时使用此技能。
dependency:
  npm:
    - libp2p@^2.8.0
    - "@libp2p/websockets@^9.2.0"
    - "@libp2p/noise@^16.0.0"
    - "@chainsafe/libp2p-yamux@^7.0.1"
    - "@libp2p/identify@^3.0.0"
    - "@libp2p/floodsub@^10.1.0"
    - "@libp2p/crypto@^5.0.0"
    - "@libp2p/peer-id@^5.0.0"
    - "@multiformats/multiaddr@^12.3.0"
    - multiformats@^13.3.0
    - crypto-js@^4.2.0
    - commander@^13.1.0
    - chalk@^5.4.1
    - ora@^8.2.0
    - fs-extra@^11.3.0
    - ws@^8.18.0
  system:
    - mkdir -p /home/project/.ipfs-nodes
---

# IPFS 分布式存储网络

## 任务目标
- 本 Skill 用于：构建和管理基于 IPFS/libp2p 的分布式文件存储网络
- 能力：多节点冗余存储、内容寻址（CID）、分块存储（Chunk DAG）、插件热加载、插件市场、权限隔离、滚动升级、数据完整性校验
- 触发：当用户需要分布式文件存储、P2P 网络、去中心化存储方案时使用

## 前置准备
- 依赖说明：libp2p 生态（websockets transport + noise + yamux + floodsub）、multiformats（CID）、crypto-js（AES-256）、commander（CLI）
- 数据目录：`/home/project/.ipfs-nodes/`（自动创建）

## 操作步骤

### 1. 初始化节点集群
调用 `node scripts/cli.js init` 初始化存储节点，节点数根据硬件配置自动评估。

### 2. 文件上传/下载
- 上传：`node scripts/cli.js upload <file-path>`（≥1MB 自动分块）
- 下载：`node scripts/cli.js download <cid> [output-path]`

### 3. 插件管理（两层体系）
- **系统插件**（管理员维护）：`node scripts/cli-plugin.js plugin list|mount|unmount|reload`
- **用户插件**（插件市场）：`node scripts/cli-plugin.js market list|search|install|uninstall|publish`
- 权限隔离：管理员管理系统插件，普通用户仅操作扩展插件

### 4. 网络监控与维护
- 状态监控：`node scripts/cli.js status`
- 容量报告：`node scripts/cli.js capacity`
- 数据修复：`node scripts/cli.js repair`
- 滚动升级：`node scripts/cli.js upgrade --run`

## 资源索引

### 脚本工具
- **[scripts/cli.js](scripts/cli.js)**
  - 用途：CLI 统一入口（节点管理、文件操作、网络监控）
  - 触发时机：当需要执行存储网络基础操作时，**必须调用此脚本**
- **[scripts/cli-plugin.js](scripts/cli-plugin.js)**
  - 用途：插件驱动 CLI 入口（插件管理 + 插件市场）
  - 触发时机：当需要管理插件或操作插件市场时，**必须调用此脚本**

### 参考文档
- **[references/architecture.md](references/architecture.md)**
  - 内容：系统架构设计（节点拓扑、存储策略、插件体系）
  - 使用时机：在理解系统设计或做架构决策前，**必须先读取此文档**
- **[references/cli-reference.md](references/cli-reference.md)**
  - 内容：完整 CLI 命令参考（所有命令、参数、示例）
  - 使用时机：在执行任何 CLI 操作前，**必须先读取此文档**确认命令格式
- **[references/encryption.md](references/encryption.md)**
  - 内容：加密方案（AES-256、Ed25519、HMAC 签名）
  - 使用时机：在涉及安全、加密、认证功能时，**必须先读取此文档**
- **[references/acp-protocol.md](references/acp-protocol.md)**
  - 内容：ACP 智能体通信协议规范
  - 使用时机：在实现智能体间通信时，**必须先读取此文档**

## 注意事项
- **附件读取规则**：执行 CLI 命令前，**必须优先读取** references/cli-reference.md 确认命令格式
- **脚本调用规则**：所有存储网络操作通过 scripts/ 中的 CLI 脚本执行，不要手动操作 .ipfs-nodes/ 目录
- **插件体系**：系统插件由管理员通过 Profile 加载，用户插件通过插件市场安装；两层权限严格隔离
- **回退机制**：插件挂载失败自动清理（原子挂载）、reload 失败自动恢复旧版本（快照回退）、状态写入前自动验证完整性
- 沙箱会在会话间重置 node_modules，每次测试前需 `pnpm install`
