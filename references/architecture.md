# 系统架构设计

## 概览
IPFS 分布式存储网络采用多节点冗余架构，通过 libp2p 协议实现节点间通信和数据同步。
系统基于 **"Everything is a Plugin"** 架构（借鉴 deepseek-harness），所有能力通过插件挂载，无特权核心。

## 插件架构（Plugin Architecture）

### 设计理念
借鉴 deepseek-harness 的 Cordis 框架精髓：
- **一切皆插件**：核心能力与扩展能力地位平等，均可替换
- **能力接缝（Capability Seam）**：Service Definition / Provider / Consumer 三角色解耦
- **注册即效果（Registration as Effect）**：每个注册返回 disposer，卸载时自动回滚
- **事件驱动**：插件间通过事件通信，不直接导入
- **Profile 组合**：运行时按配置组合插件树

### 核心组件

```
scripts/core/
├── plugin-context.js   # 共享上下文：服务注册表 + 事件总线 + 命令注册 + 中间件链
├── plugin-base.js      # 插件基类：生命周期（install→start→stop→dispose）+ disposer 追踪
├── plugin-loader.js    # 加载器：依赖拓扑排序 + Profile 组合 + 优雅降级
└── index.js            # 统一导出
```

### 插件列表

| 插件名 | 文件 | 提供服务 | 依赖 |
|--------|------|----------|------|
| security | plugins/security-plugin.js | `security` | 无 |
| node-manager | plugins/node-plugin.js | `nodeManager` | 无 |
| storage | plugins/storage-plugin.js | `storage` | security, node-manager |
| upgrade | plugins/upgrade-plugin.js | `upgrade` | node-manager, security |
| monitor | plugins/monitor-plugin.js | `monitor` | node-manager, storage |
| multi-user | plugins/user-plugin.js | `userManager` | security, node-manager |

### Profile 定义

| Profile | 包含插件 | 用途 |
|---------|----------|------|
| full | 全部 6 个 | 完整功能（默认） |
| storage-only | security + node-manager + storage | 最小化存储 |
| admin | security + node-manager + storage + upgrade + monitor | 管理场景 |

### 插件驱动 CLI

```bash
# 使用默认 full profile
node scripts/cli-plugin.js <command> [args...]

# 指定 profile
node scripts/cli-plugin.js --profile storage-only upload file.txt

# 查看已加载插件
node scripts/cli-plugin.js --list-plugins
```

### 事件流

```
file/uploaded → security 审计日志
file/downloaded → 审计
node/started / node/stopped → 监控
upgrade/completed / upgrade/rolled-back → 通知
user/logged-in / user/logged-out → 会话管理
audit/command → 中间件自动发射（敏感命令）
```

## 核心组件

### 节点身份层
- 每个节点拥有唯一的 Ed25519 密钥对
- PeerID 作为节点在网络中的唯一标识
- 身份信息持久化存储，节点重启后身份不变

### 存储层
- 文件按内容寻址（CID），相同内容只存储一份
- 默认 3 副本冗余存储，分布在不同节点
- 存储配额根据磁盘空间动态分配

### 网络层
- 节点间通过 libp2p WebSocket 连接（沙箱环境 TCP transport 不可用）
- 全网格拓扑：每个节点连接到所有其他节点，确保 floodsub 广播可达
- floodsub 广播：节点启动时即订阅 topic，消息通过 floodsub 泛洪到所有订阅者
- 协议流通信（dialProtocol/newStream）：接口已实现，沙箱环境存在兼容性问题暂不可用
- 网络规模随节点增加而扩展

### P2P 网络模块（libp2p-network.js）
- WebSocket transport 监听：`/ip4/127.0.0.1/tcp/{port}/ws`
- 密钥持久化：Ed25519 私钥以 protobuf 格式存储在 `{nodeDir}/private.key`
- 连接管理：`connectToPeer` 拨号、`getPeers` 查询、`stopLibp2pNode` 停止
- 广播通信：`broadcastGossip` 发布、`subscribeGossip` 订阅回调
- Node.js 20 兼容：需先导入 `polyfills.js`（WebSocket 全局对象 + Promise.withResolvers）

### 文件同步层（file-sync.js）
- 本地直接同步：上传后自动将文件复制到所有 running 状态的节点（共享文件系统，无需网络传输）
- floodsub 广播通知：daemon 进程内通过 floodsub 广播 FILE_SYNC 消息，通知其他订阅节点拉取
- 全量同步：`fullSync` 遍历索引，补全所有节点缺失的副本
- 覆盖率统计：`getSyncStatus` 计算文件在各节点的分布覆盖率
- 配额保护：同步前检查目标节点配额，超限则跳过
- 容量预警联动：使用率 >80% 时跳过自动同步，避免挤占修复空间

### 安全层（security.js）
- 路径遍历防护：上传/下载/升级脚本入口统一校验（resolve + 敏感目录黑名单 + 符号链接检测）
- 密钥安全传递：环境变量 `IPFS_STORAGE_KEY` > 密钥文件（检查 600 权限）> CLI `--key`（打印警告）
- 用户认证：注册自动生成 authSecret，login 颁发 HMAC-SHA256 token（24h 过期），timingSafeEqual 防时序攻击
- P2P 节点白名单：启用后仅允许白名单内 PeerId 连接，不在名单内的连接自动断开
- 广播消息签名：HMAC-SHA256 签名 + 时间戳，接收方验证签名，篡改消息自动丢弃

### 滚动升级引擎（upgrade.js）
- 数据与进程解耦：节点"运行"仅是 config.json 中的状态标记，停止/重启不影响磁盘数据
- 升级流程：前置检查 → 逐节点（停止→执行升级脚本→重启→验证 block 完整性）→ 完成
- 中断恢复：`--resume` 检测 `stopReason='upgrade'` 的中断节点，修复后继续升级剩余节点
- 回滚：恢复所有节点到升级前配置（保留当前 usedSpace）
- 状态持久化：`upgrade-state.json` 记录进度，支持断点续升

## 数据流

```
上传: 文件 → 路径校验 → 容量预检 → 加密(可选) → 计算CID → 分发到N个节点 → 自动同步到所有在线节点
下载: CID → 查找索引 → 从任一副本节点读取 → CID校验 → 解密(可选) → 输出路径校验 → 写入
同步: 上传触发 → localSync 本地分发 → floodsub 广播通知(daemon) → 索引更新
升级: --check → 逐节点(停止→脚本→重启→验证) → 完成 / --resume 断点续升
```

## 存储配额计算

```
单节点配额 = min(可用磁盘空间 × 0.7 / 节点数量, 100MB)
```

- 保留 30% 空间给系统使用，避免磁盘写满
- **单节点硬性上限 100MB**，防止单个节点占用过多空间
- 3 节点集群总容量上限：300MB

## 网络效应

| 节点数 | 总容量上限（每节点 100MB） | 冗余度 |
|--------|--------------------------|--------|
| 3      | 300 MB                   | 3 副本 |
| 5      | 500 MB                   | 3 副本 |
| 10     | 1 GB                     | 3 副本 |

节点越多，总容量越大，数据可用性越高。

## 目录结构

```
/home/project/.ipfs-nodes/
├── network.json          # 网络配置
├── index/                # 分片索引（16 分片）
│   ├── shard-00.json
│   └── ...
├── upgrade-state.json    # 升级进度状态
├── whitelist.json        # P2P 节点白名单
├── users.json            # 用户注册表
├── registry.json         # 全局节点注册表（跨用户发现）
├── users/                # 多用户隔离目录
│   └── <username>/
│       ├── user.json     # 用户配置（含 authSecret）
│       └── <username>-node-*/
├── node-0/
│   ├── identity.json     # 节点身份
│   ├── config.json       # 节点配置（status/quota/usedSpace/lastUpgradeAt）
│   ├── private.key       # Ed25519 私钥（protobuf 格式）
│   └── blocks/           # 存储的数据块
│       ├── <cid>.block
│       └── <cid>.meta.json
├── node-1/
└── node-2/
```
