<div align="center">

# 🌐 NexusLink FS

### IPFS 分布式存储网络 · 一切皆插件

**在一台机器上，跑起一整个去中心化存储集群。**

内容寻址 · 多副本冗余 · 分块 DAG · AES-256 加密 · libp2p 真实互联
插件热插拔 · 快照回退 · 滚动升级 · 弹性伸缩 · 智能体通信协议

[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-orange.svg)](https://github.com/jiangopen8/NexusLinkfs/releases/tag/v1.0.0)
[![Plugins](https://img.shields.io/badge/system%20plugins-6-brightgreen)](#插件体系)

</div>

---

## 目录

- [它是什么](#它是什么)
- [架构全景](#架构全景)
- [安装](#安装)
- [六十秒跑起来](#六十秒跑起来)
- [双层 CLI](#双层-cli)
- [场景化调用示例](#场景化调用示例)
- [编程接口](#编程接口)
- [插件开发指南](#插件开发指南)
- [安全模型](#安全模型)
- [能力边界](#能力边界必读)
- [目录结构](#目录结构)
- [文档索引](#文档索引)

---

## 它是什么

传统的对象存储把文件放在**某个地方**——某台服务器、某个机房、某个云厂商的某个可用区。地址指向位置，位置一旦消失，数据就消失了。

NexusLink FS 走的是另一条路：**地址就是内容本身**。

一个文件被切分、计算哈希、生成 CID（Content Identifier）之后，这个 CID 就是它在网络中永恒的名字。你不需要知道它存在哪台机器上——你只需要拿着这个名字向网络索取，任何一个持有副本的节点都能把它交还给你，并且交还的那一刻会重新计算哈希，验证它一个字都没被改过。

在此基础上，这个项目把一整套分布式存储系统的骨架完整地搭了出来：

| 能力 | 实现 |
|---|---|
| **内容寻址** | multiformats 计算 CID，相同内容全网只存一份 |
| **多副本冗余** | 默认 3 副本分散到不同节点，支持 basic / standard / high / paranoid 四档预设 |
| **分块存储** | ≥1MB 文件自动切分为 256KB chunk，构成 Chunk DAG，间隔分散策略避免热点 |
| **真实 P2P 网络** | libp2p + WebSocket transport + noise 加密握手 + yamux 多路复用，全网格拓扑 |
| **广播通信** | floodsub 泛洪广播，消息带 HMAC-SHA256 签名与时间戳，篡改即丢弃 |
| **节点身份** | 每个节点持有独立 Ed25519 密钥对，PeerID 持久化，重启后身份不变 |
| **静态加密** | AES-256 全文件加密，密钥由用户自持，服务端永远看不到明文 |
| **自愈能力** | 完整性扫描、降级副本修复、chunk 级修复、垃圾回收、数据再平衡 |
| **弹性伸缩** | 按集群使用率自动扩容/缩容，阈值与步长可配 |
| **滚动升级** | 逐节点「停止→升级→重启→验证」，支持断点续升与一键回滚 |
| **多用户隔离** | 用户注册表 + HMAC token（24h）+ 独立节点目录，敏感命令强制鉴权 |
| **智能体协作** | ACP 协议：Agent 注册、能力发现、会话管理、任务委派 |

而承载这一切的，是一套 **"Everything is a Plugin"** 的架构——**没有特权核心**。存储、安全、监控、升级、用户管理，全部是插件。它们和你在插件市场里下载的第三方扩展地位完全平等，都可以被挂载、卸载、热重载、升级，也都会在失败时自动回退。

---

## 架构全景

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CLI 层（双层入口）                              │
│   ipfs-net  ← 插件体系 CLI        ipfs-storage  ← 存储业务 CLI        │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│                   PluginContext（共享上下文）                          │
│      服务注册表  ·  事件总线  ·  命令注册  ·  中间件链                  │
│                                                                      │
│   ┌────────────── 系统插件层（管理员，Profile 组合）──────────────┐    │
│   │  security ─┬─→ storage ─┬─→ monitor                        │    │
│   │            │            │                                    │    │
│   │  node-manager ─┬─→ upgrade      multi-user                   │    │
│   └──────────────────────────────────────────────────────────────┘    │
│   ┌────────────── 用户插件层（插件市场，热加载）─────────────────┐    │
│   │  market install / uninstall / publish / search               │    │
│   └──────────────────────────────────────────────────────────────┘    │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│                          业务模块层                                    │
│  FileOperations   ChunkStore    IndexStore    ReplicaStrategy        │
│  DataIntegrity    RebalanceEngine  AutoScaler  UpgradeManager        │
│  StreamIO         HardwareAssessor  NetworkMonitor                   │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│                          网络与存储层                                  │
│   libp2p（WebSocket + noise + yamux + identify + floodsub）           │
│   MultiUserNetwork · UserManager · ACPProtocol · Security            │
│                                                                      │
│              .ipfs-nodes/  ←  节点数据目录（每节点独立）                │
└──────────────────────────────────────────────────────────────────────┘
```

**数据流**

```
上传   文件 → 路径校验 → 容量预检 → [AES-256 加密] → 计算 CID
        → 按副本策略选节点 → 分发 N 份 → [≥1MB 切 chunk] → 写索引 → floodsub 广播

下载   CID → 查索引 → 从任一健康副本读取 → CID 哈希校验
        → [解密] → 输出路径校验 → 落盘

自愈   integrity scan → 发现降级副本 → 从健康节点复制补齐 → 更新索引

升级   --check 前置检查 → 逐节点(停止→脚本→重启→验证 block) → 完成
        中断 → --resume 断点续升    出错 → --rollback 回滚
```

---

## 安装

### 方式一：全局命令安装（推荐，部署包用法）

```bash
# 解压部署包
unzip ipfs-storage-network-v1.0.0-deploy.zip
cd ipfs-storage-network-v1.0.0-deploy

# 安装依赖
npm install          # 或 pnpm install

# 注册全局命令
npm install -g .
```

安装完成后你会得到**两个命令**：

| 命令 | 对应 | 职责 |
|---|---|---|
| `ipfs-net` | `scripts/cli-plugin.js` | 插件体系 CLI —— 激活系统、管理插件、逛插件市场 |
| `ipfs-storage` | `scripts/cli.js` | 存储业务 CLI —— 节点、文件、副本、升级、监控 |

```bash
ipfs-net --help
ipfs-storage --help
```

### 方式二：源码直接运行

不装全局命令也可以，所有例子都等价：

```bash
node scripts/cli-plugin.js <command>     # 等价于 ipfs-net <command>
node scripts/cli.js <command>            # 等价于 ipfs-storage <command>
```

> 📖 **本文档后续示例统一使用 `ipfs-storage` / `ipfs-net` 全局命令形式。**
> 若你走的是源码运行，把 `ipfs-storage` 换成 `node scripts/cli.js`、`ipfs-net` 换成 `node scripts/cli-plugin.js` 即可，参数完全一致。

### 环境要求

- **Node.js ≥ 18**（推荐 20+，libp2p 生态需要 `Promise.withResolvers`，项目已内置 polyfill）
- **npm / pnpm** 任一
- 可写的数据目录（默认 `./.ipfs-nodes/`，自动创建）

---

## 六十秒跑起来

```bash
# 1. 一键激活整个存储网络
#    依赖检查 → 节点初始化 → Profile 加载 → 状态恢复 → 健康检查
ipfs-net activate

# 2. 看看插件都挂载好了没
ipfs-net plugin list

# 3. 初始化存储网络（检测磁盘、评估硬件、生成网络配置）
ipfs-storage init

# 4. 启动节点集群（不指定数量则按硬件评估自动决定，3~100 个）
ipfs-storage node start

# 5. 丢个文件进去
echo "hello distributed world" > demo.txt
ipfs-storage upload ./demo.txt
#    → 返回 CID，例如 bafkreig7x2v...

# 6. 从网络里取回来
ipfs-storage download <上一步返回的CID> --output ./restored.txt

# 7. 看看集群状态
ipfs-storage capacity
ipfs-storage dashboard
```

第 5 步返回的那串 CID，就是这个文件在整个网络中**唯一且永恒**的名字。把它记下来——只要网络里还有任何一个节点持有副本，你就能凭它把文件完整取回，并且取回时会重新计算哈希验证内容分毫未改。

---

## 双层 CLI

这个项目的 CLI 分成两层，对应两套完全不同的权限模型。

### 第一层：`ipfs-net` —— 插件体系（管理员）

管理系统插件的生命周期。这一层的操作会影响整个网络的能力构成，因此**仅管理员可用**。

```bash
# 激活与状态
ipfs-net activate                              # 一键激活（full profile）
ipfs-net activate --profile storage-only       # 最小化启动：只加载存储必需插件
ipfs-net activate --profile admin              # 管理场景：不含多用户模块
ipfs-net --list-plugins                        # 列出当前 Profile 会加载哪些插件
ipfs-net plugin list                           # 已挂载/可挂载插件 + 依赖图
ipfs-net plugin info                           # 插件详情

# 运行时热插拔
ipfs-net plugin mount <name>                   # 挂载
ipfs-net plugin unmount <name>                 # 卸载（自动执行 disposer 清理）
ipfs-net plugin reload <name>                  # 同进程热重载（带快照回退）

# 升级
ipfs-net plugin upgrade <name> --from ./new-version.js    # 单插件升级
ipfs-net plugin upgrade <name> --from ./new.js --force    # 版本号相同时强制覆盖
ipfs-net plugin upgrade --all                             # 批量升级所有已挂载插件
```

**三个 Profile**

| Profile | 包含插件 | 适用场景 |
|---|---|---|
| `full` | 全部 6 个（默认） | 完整功能 |
| `storage-only` | security + node-manager + storage | 最小化存储节点，资源占用最低 |
| `admin` | security + node-manager + storage + upgrade + monitor | 运维管理，不开放多用户 |

**六个系统插件与依赖关系**

| 插件 | 提供服务 | 依赖 |
|---|---|---|
| `security` | `security` | — |
| `node-manager` | `nodeManager` | — |
| `storage` | `storage` | security, node-manager |
| `upgrade` | `upgrade` | node-manager, security |
| `monitor` | `monitor` | node-manager, storage |
| `multi-user` | `userManager` | security, node-manager |

依赖关系决定了操作顺序：**卸载时逆拓扑序**（先卸依赖者），**挂载时正拓扑序**（先挂被依赖者）。试图卸载一个仍被别人依赖的插件会被依赖检查直接拦下——这是设计如此，不是 bug。

### 第二层：`ipfs-storage` —— 存储业务

日常运维和数据操作全在这一层。

```bash
# 网络与节点
ipfs-storage init                              # 初始化存储网络
ipfs-storage hardware assess                   # 硬件评估 → 推荐节点数
ipfs-storage identity create <node-id>         # 生成 Ed25519 密钥对与 PeerID
ipfs-storage node start [--count N] [node-id]  # 启动集群/单节点
ipfs-storage node stop <node-id>               # 停止（数据保留在磁盘）
ipfs-storage node list                         # 列出节点
ipfs-storage node add                          # 扩容一个节点
ipfs-storage node remove <node-id>             # 移除节点（含数据迁移）
ipfs-storage node daemon [--count N] [--duration S] [--autoscale-interval S]
ipfs-storage node peers <node-id>              # 查看 P2P 对等连接
ipfs-storage node autoscale run|status|config  # 弹性伸缩

# 文件
ipfs-storage upload <path> [-e] [--replicas N] [--key-file F] [--token T]
ipfs-storage download <cid> [--output P] [-d] [--key-file F] [--token T]
ipfs-storage info <cid>                        # 文件元信息
ipfs-storage files                             # 列出所有文件
ipfs-storage delete <cid>                      # 删除

# 副本与完整性
ipfs-storage replica config show|set|preset|add-rule
ipfs-storage integrity scan|repair|gc
ipfs-storage chunk status|repair
ipfs-storage index status|rebuild
ipfs-storage rebalance plan|run|status
ipfs-storage sync full|status

# 升级
ipfs-storage upgrade --check|--run|--resume|--rollback|--status [--dry-run] [--script F]

# 监控
ipfs-storage capacity                          # 容量报告（进度条 + 四级健康评级）
ipfs-storage dashboard                         # 终端可视化面板
ipfs-storage network status|health|forecast
ipfs-storage whitelist [--enable|--disable|--add|--remove]

# 多用户
ipfs-storage user register|login|logout|start|list

# P2P 与智能体
ipfs-storage p2p broadcast|listen
ipfs-storage acp init|register|discover|session|send|receive|broadcast|status

# 加密
ipfs-storage encrypt keygen
```

完整参数说明见 [references/cli-reference.md](references/cli-reference.md)。

---

## 场景化调用示例

下面是十二个真实场景，每个都可以直接复制执行。

### 场景 1 · 冷启动：从零拉起一个存储集群

```bash
ipfs-storage init
ipfs-storage hardware assess
```

`hardware assess` 会评估 CPU / 内存 / 磁盘三个维度，输出推荐节点数（3~100）、瓶颈维度、单节点配额和集群总容量。

```bash
# 按硬件评估的推荐值启动
ipfs-storage node start

# 或者手动指定 5 个节点
ipfs-storage node start --count 5

# 只启动某一个节点
ipfs-storage node start node-0

ipfs-storage node list
```

### 场景 2 · 拉起真实 P2P 网络并验证互联

`node start` 启动的是本地存储节点；要让节点之间真正建立 libp2p 连接，需要 `node daemon`。

```bash
# 启动 3 节点 P2P 网络，全网格互联，运行 30 秒后自动停止
ipfs-storage node daemon --duration 30

# 指定节点数
ipfs-storage node daemon --count 5

# 自定义伸缩检查间隔（秒），传 0 禁用定时伸缩
ipfs-storage node daemon --autoscale-interval 30
ipfs-storage node daemon --autoscale-interval 0
```

daemon 跑起来之后，另开一个终端验证对等连接：

```bash
ipfs-storage node peers node-0
```

再试试 floodsub 广播——一个终端监听，另一个终端喊话：

```bash
# 终端 A：监听 30 秒
ipfs-storage p2p listen --duration 30 --node node-1

# 终端 B：从 node-0 广播
ipfs-storage p2p broadcast "hello network" --node node-0
```

消息经 floodsub 泛洪到所有订阅节点，带 HMAC-SHA256 签名与时间戳；签名不匹配的消息会被接收方直接丢弃。

### 场景 3 · 加密存储敏感文件

密钥由你自持，网络里流转的永远是密文。

```bash
# 生成一个 256 位密钥（64 个十六进制字符）
ipfs-storage encrypt keygen
```

三种传密钥的方式，**安全性从高到低**：

```bash
# ① 环境变量（推荐，不留痕迹）
IPFS_STORAGE_KEY=<你的密钥> ipfs-storage upload ./secret.txt -e

# ② 密钥文件（推荐，注意权限必须是 600）
echo "<你的密钥>" > my.key
chmod 600 my.key
ipfs-storage upload ./secret.txt -e --key-file ./my.key

# ③ 命令行参数（不推荐，会留在 shell history，执行时会打印安全警告）
ipfs-storage upload ./secret.txt -e --key <你的密钥>
```

系统按 `环境变量 > 密钥文件 > CLI 参数` 的优先级自动解析。

解密下载同理：

```bash
IPFS_STORAGE_KEY=<你的密钥> ipfs-storage download <cid> -d --output ./secret.txt
ipfs-storage download <cid> -d --key-file ./my.key
```

> ⚠️ **密钥丢失 = 数据永久丢失。** AES-256 没有后门，请务必把密钥存进密码管理器并做备份。

### 场景 4 · 大文件分块与副本修复

≥1MB 的文件会自动切分为 256KB 的 chunk，构成 Chunk DAG，按间隔分散策略铺到不同节点上，避免单点热点。

```bash
# 上传一个大文件，指定 5 副本
ipfs-storage upload ./big-video.mp4 --replicas 5

# 查看 chunk 分布
ipfs-storage chunk status

# 查看这个文件的分块详情
ipfs-storage info <cid>
```

模拟一个节点挂掉之后的修复流程：

```bash
ipfs-storage node stop node-2          # 停掉一个节点
ipfs-storage chunk status              # 会看到部分 chunk 副本降级
ipfs-storage chunk repair              # 从健康节点复制补齐
ipfs-storage integrity scan            # 全量 CID 完整性扫描
ipfs-storage integrity repair          # 修复降级副本
ipfs-storage integrity gc              # 回收无索引引用的孤立 block
ipfs-storage node start node-2         # 节点恢复
```

### 场景 5 · 副本策略：按文件类型分级冗余

```bash
# 查看当前配置
ipfs-storage replica config show

# 全局设为 3 副本
ipfs-storage replica config set --replicas 3

# 使用预设等级：basic / standard / high / paranoid
ipfs-storage replica config preset paranoid

# 针对特定文件类型单独定规则
ipfs-storage replica config add-rule --pattern "*.mp4" --replicas 2
ipfs-storage replica config add-rule --pattern "*.log" --replicas 1
```

### 场景 6 · 弹性伸缩：让集群自己照顾自己

```bash
# 查看伸缩状态：运行/停止节点数、使用率、伸缩建议
ipfs-storage node autoscale status

# 配置阈值：使用率超 50% 扩容，低于 80% 缩容，节点数限定在 3~100
ipfs-storage node autoscale config --up 50 --down 80 --min 3 --max 100

# 每次伸缩 2 个节点
ipfs-storage node autoscale config --step 2

# 临时关闭 / 重新开启自动伸缩
ipfs-storage node autoscale config --disable
ipfs-storage node autoscale config --enable

# 手动触发一次伸缩决策
ipfs-storage node autoscale run
```

`node daemon` 默认每 60 秒自动执行一次伸缩检查，无需人工干预。

### 场景 7 · 数据再平衡：消除存储倾斜

节点间使用率偏差 >20% 或差值 >30% 时触发。

```bash
ipfs-storage rebalance plan      # 检测倾斜，生成迁移计划（只读，不动数据）
ipfs-storage rebalance run       # 执行迁移
ipfs-storage rebalance status    # 查看进度
```

迁移走**安全四步**：复制到目标节点 → 校验 CID → 更新索引 → 删除源副本。任何一步失败都会中止，不会出现「源已删、目标没写好」的窗口。

### 场景 8 · 滚动升级：不停机换版本

数据与进程解耦——节点的「运行」只是 `config.json` 里的一个状态标记，停止/重启不动磁盘上的任何数据。

```bash
# 第一步：前置检查（副本健康度、容量余量、是否有进行中的升级）
ipfs-storage upgrade --check

# 第二步：先干跑一遍，不实际停止/重启
ipfs-storage upgrade --run --dry-run

# 第三步：真正执行，逐节点「停止 → 升级 → 重启 → 验证 block 完整性」
ipfs-storage upgrade --run

# 带自定义升级脚本
ipfs-storage upgrade --run --script ./my-upgrade.js

# 随时查看进度
ipfs-storage upgrade --status
```

**如果中途进程被杀**：

```bash
ipfs-storage upgrade --resume
```

`--resume` 会检测 `stopReason='upgrade'` 的中断节点，先修复它们，再继续升级剩余节点。进度持久化在 `upgrade-state.json`，支持断点续升。

**如果升级后发现有问题**：

```bash
ipfs-storage upgrade --rollback
```

回滚会把所有节点恢复到升级前的配置（保留当前 `usedSpace`）。

> 🔐 多用户模式下，`--run` / `--rollback` / `--resume` 属高危操作，必须先 `user login` 或带 `--token`；`--check` / `--status` 是只读的，无需鉴权。

### 场景 9 · 多用户：隔离与鉴权

```bash
# 注册用户（自动生成 authSecret）
ipfs-storage user register alice --display-name "Alice"

# 登录，颁发 24h 有效的 HMAC-SHA256 token，会话自动存到 session.json
ipfs-storage user login alice

# 为这个用户启动 3 个专属节点
ipfs-storage user start alice -n 3

# 列出所有用户及节点统计
ipfs-storage user list

# 登出，清除本地会话
ipfs-storage user logout
```

登录之后，`upload` / `download` / `delete` 会自动带上会话 token，不用每次手动传。也可以显式指定：

```bash
ipfs-storage upload ./file.txt --token <token>
IPFS_AUTH_TOKEN=<token> ipfs-storage download <cid>
```

**一旦注册了第一个用户，系统就进入多用户模式**，所有敏感命令都必须携带有效认证。token 校验使用 `timingSafeEqual`，防时序攻击。

### 场景 10 · 插件热插拔与升级回退

```bash
# 看看现在挂了什么
ipfs-net plugin list

# 热重载一个插件（同进程内，带快照回退保护）
ipfs-net plugin reload monitor

# 升级单个插件：版本对比 + 失败自动恢复旧版本
ipfs-net plugin upgrade storage --from ./storage-plugin-v2.js

# 版本号相同但确实要覆盖
ipfs-net plugin upgrade storage --from ./patched.js --force

# 批量升级所有已挂载插件
ipfs-net plugin upgrade --all
```

`upgrade --all` 的执行顺序是精心设计的：

```
① 拓扑排序所有已挂载插件
② 逆依赖顺序全部卸载（依赖者先走，被依赖者后走）
③ 按依赖顺序从注册表重新挂载（被依赖者先起）
④ 某个插件失败 → 级联跳过所有依赖它的插件
⑤ 输出成功/失败汇总
```

之所以不能简单地逐个 `reload`，是因为被依赖的插件（如 `storage`、`security`）在 unmount 时会被依赖检查拦下——必须先让依赖它们的插件全部离场。

**三重回退保护**：

| 机制 | 触发时机 | 行为 |
|---|---|---|
| 原子挂载 | `install` 成功但 `start` 失败 | 自动从注册表移除 + 执行 dispose 清理，不留半成品 |
| 快照回退 | `reload` 时新版本挂载失败 | 从保存的旧插件构造器重建，恢复原状 |
| 写入前验证 | 任何状态持久化之前 | `PluginState.validate()` 检查完整性，关键系统插件受保护 |

### 场景 11 · 插件市场：安装与发布扩展

普通用户在这一层活动，**无需管理员权限**。

```bash
# 浏览市场
ipfs-net market list
ipfs-net market stats
ipfs-net market sources

# 搜索
ipfs-net market search compression

# 查看详情（注意：市场以【文件名】作为插件标识，不是插件内部的 name）
ipfs-net market info my-compressor.js

# 安装 —— 装完即热加载生效，无需重启
ipfs-net market install my-compressor.js

# 卸载
ipfs-net market uninstall my-compressor.js

# 发布你自己写的插件到市场
ipfs-net market publish ./my-compressor.js
```

### 场景 12 · ACP：让存储节点变成会对话的智能体

ACP（Agent Communication Protocol）让每个存储节点都能注册为智能体，彼此发现、建会话、委派任务。

```bash
# 初始化 ACP 协议层
ipfs-storage acp init

# 把 node-0 注册为一个具备 storage / retrieval 能力的 Agent
ipfs-storage acp register node-0 storage-agent -c "storage,retrieval"

# 能力发现
ipfs-storage acp discover
ipfs-storage acp discover -c storage

# 在两个 Agent 之间建立会话
ipfs-storage acp session create agent-a.local.acp agent-b.local.acp

# 发送任务消息
ipfs-storage acp send <session-id> '{"action":"query"}' -t task

# 接收
ipfs-storage acp receive <session-id>

# 广播
ipfs-storage acp broadcast my-agent.local.acp "hello network"

# 网络状态
ipfs-storage acp status
```

**协议栈**

```
┌─────────────────────────────────┐
│   应用层：ACP JSON 消息格式      │
├─────────────────────────────────┤
│   会话层：会话创建/管理/关闭      │
├─────────────────────────────────┤
│   传输层：local-ipc / floodsub  │
├─────────────────────────────────┤
│   网络层：libp2p WebSocket      │
└─────────────────────────────────┘
```

Agent 身份格式为 `{agent-name}.{ap-domain}`，例如 `storage-node-0.local.acp`。支持 9 种消息类型：`hello` / `discover` / `session.create` / `message` / `task` / `storage.request` / `storage.response` / `heartbeat` / `bye`。

当 `node daemon` 已启动时，ACP 消息会自动经 floodsub 广播到所有订阅节点，实际接收节点数记录在消息的 `metadata.p2pBroadcast.recipients` 字段里。

### 附 · 日常巡检三件套

```bash
ipfs-storage capacity        # 集群使用率、剩余空间、各节点分布（含四级健康评级）
ipfs-storage sync status     # 文件总数、节点总数、总副本数、同步覆盖率
ipfs-storage dashboard       # 终端可视化面板：网络概览 + 进度条 + 文件分布表 + 容量预测
```

`capacity` 的健康评级分四档：`healthy` / `caution` / `warning` / `critical`。使用率超过 80% 时，自动同步会主动跳过，把空间留给副本修复。

---

## 编程接口

CLI 只是薄薄一层壳，所有能力都以 ES Module 导出，可以直接嵌进你自己的程序。

### 文件操作

```javascript
import { FileOperations } from './scripts/file-ops.js';

const files = new FileOperations();          // 默认数据目录 .ipfs-nodes/
await files.ensureIndex();

// 上传
const result = await files.upload('./demo.txt', { replicas: 3 });
console.log(result.cid);

// 下载（自动做 CID 哈希校验）
await files.download(result.cid, { output: './restored.txt' });

// 元信息 / 列表 / 删除
const info = await files.getInfo(result.cid);
const all  = await files.listFiles();
await files.deleteFile(result.cid);

// 容量
const report = await files.getCapacityReport();
await files.checkCapacity(1024 * 1024);      // 上传前预检
```

`FileOperations` 还导出了分块相关的方法：`chunkedUploadFlow` / `chunkedDownloadFlow` / `getChunkInfo` / `verifyChunkedFile` / `repairChunkedFile`，以及加密工具 `generateKey` / `encryptContent` / `decryptContent`。

### 节点管理

```javascript
import { NodeManager } from './scripts/node-manager.js';

const nm = new NodeManager();
await nm.init();

const assessment = await nm.getHardwareAssessment();
const recommended = await nm.getRecommendedNodeCount();

await nm.startCluster(5);                    // 启动 5 节点集群
await nm.startNode('node-0');
await nm.stopNode('node-0');
await nm.restoreNode('node-0');

console.log(await nm.listNodes());
console.log(await nm.getNodeStatus('node-1'));

await nm.addNode();                          // 扩容
await nm.removeNode('node-3');               // 移除（含数据迁移）
await nm.migrateNodeData('node-3');          // 仅迁移数据

await nm.createIdentity('node-9');           // 生成 Ed25519 密钥对 + PeerID
await nm.startP2PNetwork(3);                 // 拉起真实 libp2p 网络
```

### P2P 网络

```javascript
// ⚠️ 必须先导入 polyfills（WebSocket 全局对象 + Promise.withResolvers）
import './scripts/polyfills.js';
import { getPeers, subscribeGossip, getActiveNodes } from './scripts/libp2p-network.js';

console.log(getActiveNodes());
console.log(getPeers('node-0'));

subscribeGossip('node-1', (msg) => {
  console.log('收到广播:', msg);
}, { duration: 30000 });
```

### 其他模块

```javascript
import { ChunkStore }      from './scripts/chunk-store.js';
import { DataIntegrity }   from './scripts/data-integrity.js';
import { IndexStore }      from './scripts/index-store.js';
import { RebalanceEngine } from './scripts/rebalance.js';
import { AutoScaler }      from './scripts/auto-scaler.js';
import { UpgradeManager }  from './scripts/upgrade.js';
import { ReplicaConfig }   from './scripts/replica-config.js';
import { ReplicaStrategy } from './scripts/replica-strategy.js';
import { HardwareAssessor }from './scripts/hardware-assessor.js';
import { NetworkMonitor }  from './scripts/network-monitor.js';
import { MultiUserNetwork }from './scripts/multi-user-network.js';
import { UserManager }     from './scripts/user-manager.js';
import { StreamIO }        from './scripts/stream-io.js';
import { ACPProtocol, MessageType } from './scripts/acp-protocol.js';
import { startFileSyncListener }    from './scripts/file-sync.js';
```

安全工具是纯函数，可以单独取用：

```javascript
import {
  validateInputPath, validateOutputPath, validateScriptPath,
  resolveKey, generateToken, verifyToken,
  signMessage, verifyMessageSignature, isPeerAllowed,
} from './scripts/security.js';
```

### 插件框架

```javascript
import {
  PluginContext, PluginBase, PluginLoader, PluginWatcher,
  PluginResolver, PluginSignature, PluginState, PluginConfig,
  PluginMarket, PluginPermission,
} from './scripts/core/index.js';

import { createLoader } from './scripts/plugins/index.js';

const loader = createLoader();
```

---

## 插件开发指南

写一个插件只需要继承 `PluginBase`，实现生命周期钩子。

```javascript
import { PluginBase } from '../core/plugin-base.js';

export class MyPlugin extends PluginBase {
  constructor() {
    // ⚠️ 签名是 (name, meta)，不是 ({ name, ... })
    super('my-plugin', {
      version: '1.0.0',
      description: '我的第一个插件',
      dependencies: ['storage'],        // 依赖的服务名
    });
  }

  async install(ctx) {
    // ⚠️ 必须用 this.provide()，不要用 ctx.provide()
    //    this.provide 会登记 disposer，unmount 时自动清理
    this.provide('myService', {
      hello: () => 'world',
    });

    // 注册命令
    ctx.command('my-command', {
      description: '我的命令',
      handler: async () => console.log('executed'),
    });

    // 订阅事件
    ctx.on('file/uploaded', (e) => console.log('新文件:', e.cid));
  }

  async start()  { /* 启动资源 */ }
  async stop()   { /* 释放资源 */ }
  async dispose(){ /* 最终清理 */ }
}

export default MyPlugin;
```

**四个必须记住的坑**

| ❌ 错误写法 | ✅ 正确写法 | 后果 |
|---|---|---|
| `super({ name: 'x' })` | `super('x', { version: '1.0.0' })` | 构造签名是 `(name, meta = {})` |
| `ctx.provide(...)` | `this.provide(...)` | 用 ctx 注册的服务在 unmount 时不会被清理，造成泄漏 |
| 跨进程 unmount → mount 实现热重载 | `ipfs-net plugin reload <name>` | 每次 CLI 调用都是独立进程，会重新加载 Profile |
| 直接 reload 被依赖的插件 | 先卸载依赖它的插件 | 依赖检查会拦下，这是正确行为 |

**生命周期**：`install → start → stop → dispose`

**事件流**（插件之间通过事件通信，不直接 import 彼此）：

```
file/uploaded      → security 审计日志
file/downloaded    → 审计
node/started       → 监控
node/stopped       → 监控
upgrade/completed  → 通知
upgrade/rolled-back→ 通知
user/logged-in     → 会话管理
user/logged-out    → 会话管理
audit/command      → 中间件自动发射（敏感命令）
```

写完发布到市场：

```bash
ipfs-net market publish ./my-plugin.js
ipfs-net market list          # 确认已上架（标识是文件名）
```

---

## 安全模型

| 层面 | 机制 |
|---|---|
| **路径安全** | 上传/下载/升级脚本入口统一校验：`resolve` 归一化 + 敏感目录黑名单 + 符号链接检测，杜绝路径遍历 |
| **静态加密** | AES-256 全文件加密；密钥解析优先级 `环境变量 > 密钥文件(检查 600 权限) > CLI 参数(打印警告)` |
| **节点身份** | 每节点独立 Ed25519 密钥对，私钥以 protobuf 格式存于 `{nodeDir}/private.key`，重启后身份不变 |
| **传输加密** | libp2p noise 协议握手，yamux 多路复用 |
| **网络准入** | P2P 白名单：启用后仅允许名单内 PeerId 连接，名单外连接自动断开 |
| **消息完整性** | 广播消息带 HMAC-SHA256 签名 + 时间戳，接收方验签，篡改消息直接丢弃 |
| **用户认证** | 注册自动生成 authSecret；登录颁发 HMAC-SHA256 token（24h 过期）；校验用 `timingSafeEqual` 防时序攻击 |
| **插件完整性** | HMAC-SHA256 插件签名校验 |
| **权限隔离** | `PluginPermission` 基于 `admin.json` / `users.json` / `session.json` 判定角色；系统插件层仅管理员可操作 |
| **数据校验** | 下载时重算 CID 哈希；完整性扫描覆盖全部文件；chunk 级校验与修复 |

**权限判定优先级**：`admin.json` > 单用户模式（默认管理员）> 多用户首个注册用户

白名单操作：

```bash
ipfs-storage whitelist                          # 查看状态
ipfs-storage whitelist --enable                 # 启用
ipfs-storage whitelist --add <peerId>           # 添加节点
ipfs-storage whitelist --remove <peerId>        # 移除
ipfs-storage whitelist --disable                # 关闭
```

详见 [references/encryption.md](references/encryption.md)。

---

## 能力边界（必读）

这是一个**完整实现分布式存储架构的单机多节点集群**，不是一个接入公网 IPFS 的生产网络。请在使用前明确以下几点：

### 节点模型

- 所有节点运行在**同一台机器的同一个文件系统**上，数据目录为 `.ipfs-nodes/node-*/`
- 因此「同步到其它节点」的实现是**本地文件复制**，不经过网络传输——这让它能快速演示副本分发、降级修复、再平衡等全套逻辑，但不具备跨机器的真实网络开销与分区容错
- 节点「运行中」是 `config.json` 里的状态标记，不是真实进程；这正是滚动升级能做到数据零影响的原因

### 容量限制

```
单节点配额 = min(可用磁盘空间 × 0.7 / 节点数量, 100MB)
```

- 保留 30% 空间给系统，避免磁盘写满
- **单节点硬性上限 100MB**
- 3 节点集群总容量上限 **300MB**，10 节点约 **1GB**

这是为了防止演示环境把磁盘吃满而设的护栏，不是算法限制。

### 网络传输

| 组件 | 状态 | 说明 |
|---|---|---|
| libp2p WebSocket transport | ✅ 可用 | 监听 `/ip4/127.0.0.1/tcp/{port}/ws` |
| noise 加密握手 / yamux 多路复用 / identify | ✅ 可用 | |
| floodsub 广播 | ✅ 可用 | 全网格拓扑，节点启动即订阅 topic |
| `@libp2p/tcp` | ❌ 不可用 | 沙箱环境 TCP 入站连接被重置（ECONNRESET），故改用 WebSocket |
| `@chainsafe/libp2p-gossipsub` | ❌ 不可用 | 3 节点规模下 mesh 无法建立，故改用 floodsub |
| `dialProtocol` / `connection.newStream` | ❌ 不可用 | multistream-select 与 WebSocket transport 存在兼容性问题；接口已实现但暂不可用 |

### 其他

- 生成的 CID 是**本地计算的内容地址**，不与公网 IPFS 网络互通；同一份内容在公网 IPFS 上会有相同的 CID，但本网络不会去公网取数据
- 协议流通信（点对点请求/响应）受上述 transport 限制暂不可用，节点间协作目前走 floodsub 广播 + 共享索引

---

## 目录结构

```
.
├── SKILL.md                  # Meoo 技能定义（仅源码包含有）
├── README.md                 # 本文档
├── LICENSE                   # MIT
├── package.json              # 含 bin 字段：ipfs-net / ipfs-storage
├── pnpm-lock.yaml
│
├── scripts/
│   ├── cli-plugin.js         # 🔌 插件体系 CLI 入口（ipfs-net）
│   ├── cli.js                # 📦 存储业务 CLI 入口（ipfs-storage）
│   ├── polyfills.js          # Node 兼容层（WebSocket / Promise.withResolvers）
│   │
│   ├── core/                 # 🧩 插件框架核心
│   │   ├── plugin-context.js     # 服务注册表 + 事件总线 + 命令注册 + 中间件链
│   │   ├── plugin-base.js        # 插件基类：生命周期 + disposer 追踪 + 健康检查
│   │   ├── plugin-loader.js      # 依赖拓扑排序 + Profile 组合 + 优雅降级
│   │   ├── plugin-market.js      # 插件市场：publish/list/search/install/uninstall
│   │   ├── plugin-permission.js  # 角色判定与权限隔离
│   │   ├── plugin-state.js       # 状态持久化 + 写入前完整性验证
│   │   ├── plugin-resolver.js    # 插件解析
│   │   ├── plugin-signature.js   # HMAC-SHA256 签名校验
│   │   ├── plugin-watcher.js     # 文件监听热重载
│   │   ├── plugin-config.js      # Profile 与插件配置
│   │   └── index.js
│   │
│   ├── plugins/              # 🔌 6 个系统插件
│   │   ├── security-plugin.js
│   │   ├── node-plugin.js
│   │   ├── storage-plugin.js
│   │   ├── upgrade-plugin.js
│   │   ├── monitor-plugin.js
│   │   ├── user-plugin.js
│   │   └── index.js              # createLoader()
│   │
│   ├── file-ops.js           # 上传/下载/索引/加密（核心业务）
│   ├── chunk-store.js        # Chunk DAG 分块存储
│   ├── chunk-repair.js       # chunk 级副本修复
│   ├── index-store.js        # 16 分片索引
│   ├── data-integrity.js     # 完整性扫描 / 修复 / GC
│   ├── replica-config.js     # 副本策略配置
│   ├── replica-strategy.js   # 副本放置策略
│   ├── rebalance.js          # 数据再平衡引擎
│   ├── file-sync.js          # 文件同步 + floodsub 通知
│   ├── stream-io.js          # 流式读写
│   │
│   ├── node-manager.js       # 节点生命周期管理
│   ├── hardware-assessor.js  # 硬件评估 → 推荐节点数
│   ├── auto-scaler.js        # 弹性伸缩决策
│   ├── upgrade.js            # 滚动升级引擎（断点续升 + 回滚）
│   ├── network-monitor.js    # 网络监控与容量预测
│   │
│   ├── libp2p-network.js     # libp2p 实例管理 + floodsub 广播
│   ├── peer-id-utils.js      # PeerID 导入导出
│   ├── multi-user-network.js # 多用户网络隔离
│   ├── user-manager.js       # 用户注册 / 登录 / token
│   ├── security.js           # 路径校验 / 密钥解析 / 签名 / 白名单
│   └── acp-protocol.js       # ACP 智能体通信协议
│
└── references/
    ├── architecture.md       # 架构设计
    ├── cli-reference.md      # 完整 CLI 参考
    ├── encryption.md         # 加密方案
    └── acp-protocol.md       # ACP 协议规范
```

**运行时数据目录**（自动创建，不在发布包内）

```
.ipfs-nodes/
├── network.json              # 网络配置
├── registry.json             # 全局节点注册表（跨用户发现）
├── whitelist.json            # P2P 节点白名单
├── users.json                # 用户注册表
├── upgrade-state.json        # 升级进度（支持断点续升）
├── index/                    # 16 分片索引
│   └── shard-00.json ...
├── users/<username>/         # 多用户隔离目录
│   ├── user.json             # 用户配置（含 authSecret）
│   └── <username>-node-*/
└── node-0/
    ├── identity.json         # 节点身份
    ├── config.json           # status / quota / usedSpace / lastUpgradeAt
    ├── private.key           # Ed25519 私钥（protobuf）
    └── blocks/
        ├── <cid>.block
        └── <cid>.meta.json
```

> 🚫 **不要手动编辑 `.ipfs-nodes/` 里的任何文件。** 所有操作都通过 CLI 或编程接口进行，索引与副本状态由系统维护一致性。

---

## 文档索引

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [references/architecture.md](references/architecture.md) | 插件架构、核心组件、数据流、配额计算、网络效应 | 做架构决策或二次开发前 |
| [references/cli-reference.md](references/cli-reference.md) | 全部命令、参数、示例、典型工作流 | 执行任何 CLI 操作前查参数 |
| [references/encryption.md](references/encryption.md) | AES-256 流程、密钥传递优先级、安全注意事项 | 涉及加密、认证、密钥管理时 |
| [references/acp-protocol.md](references/acp-protocol.md) | 协议栈、AID 格式、消息类型、通信流程 | 实现智能体间通信时 |

---

## 两个发布包的区别

| | 源码包 `-source.zip` | 部署包 `-deploy.zip` |
|---|---|---|
| `SKILL.md` | ✅ 含 | ❌ 不含 |
| 用途 | 作为 Meoo 技能包导入平台 | 独立部署，`npm install -g .` |
| 其余内容 | 完全一致 | 完全一致 |

---

## 版本

**v1.0.0** — 首个发布版本

- 完整的分布式存储内核：内容寻址、多副本、Chunk DAG、分片索引
- 真实 libp2p P2P 网络：WebSocket + noise + yamux + floodsub
- "Everything is a Plugin" 架构：6 个系统插件 + 3 个 Profile
- 两层插件体系：系统插件层（管理员）+ 用户插件层（插件市场）
- 三重回退保护：原子挂载、快照回退、写入前验证
- 单插件升级与 `upgrade --all` 批量协调升级（依赖拓扑排序）
- 滚动升级引擎：断点续升 + 一键回滚
- 弹性伸缩、数据再平衡、完整性自愈
- 多用户隔离与 HMAC token 鉴权
- AES-256 静态加密、P2P 白名单、消息签名
- ACP 智能体通信协议
- 双层 CLI：`ipfs-net` + `ipfs-storage`

---

## License

[MIT](LICENSE) © jiangopen8

<div align="center">

**地址即内容，内容即永恒。**

</div>
