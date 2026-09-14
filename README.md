# IPFS 分布式存储网络 (ipfs-storage-network)

基于 IPFS/libp2p 的分布式文件存储网络，采用 "Everything is a Plugin" 架构与两层插件体系（系统插件层 + 用户插件层），支持多节点冗余存储、内容寻址（CID）、分块存储（Chunk DAG）、AES-256 加密与 ACP 智能体通信协议。

## 核心特性

- **P2P 网络**：libp2p + WebSocket 互联、floodsub 广播、Ed25519 节点身份、节点白名单
- **分布式存储**：多节点冗余副本、CID 内容寻址、Chunk DAG 分块、自动修复与数据再平衡
- **两层插件体系**：
  - 系统插件层（管理员维护）：6 个内置插件 security / node-manager / storage / upgrade / monitor / multi-user，通过 Profile（full / storage-only / admin）组合加载
  - 用户插件层（普通用户）：插件市场安装扩展插件，支持热加载 / 卸载 / 发布
- **回退保护**：原子挂载、reload 快照回退、状态写入前验证、升级失败自动恢复旧版本
- **安全**：路径遍历防护、HMAC-SHA256 插件签名、消息签名、AES-256 文件加密

## 快速开始

环境要求：Node.js >= 18、pnpm

```bash
pnpm install
node scripts/cli-plugin.js activate        # 一键激活整个存储网络
node scripts/cli-plugin.js plugin list     # 查看插件状态
```

## 两层 CLI

### 系统插件层（管理员）

```bash
node scripts/cli-plugin.js plugin list                  # 已挂载/可挂载插件与依赖图
node scripts/cli-plugin.js plugin mount <name>          # 运行时挂载
node scripts/cli-plugin.js plugin unmount <name>        # 运行时卸载
node scripts/cli-plugin.js plugin reload <name>         # 热重载
node scripts/cli-plugin.js plugin upgrade <name> --from <path>  # 单插件升级（版本对比+回退保护）
node scripts/cli-plugin.js plugin upgrade --all         # 批量升级所有已挂载插件
```

### 用户插件层（插件市场）

```bash
node scripts/cli-plugin.js market list                  # 浏览市场
node scripts/cli-plugin.js market search <keyword>      # 搜索插件
node scripts/cli-plugin.js market install <name>        # 安装（即热加载）
node scripts/cli-plugin.js market uninstall <name>      # 卸载
node scripts/cli-plugin.js market publish <path>        # 发布插件
```

### 存储业务命令

```bash
node scripts/cli.js init                                # 初始化网络
node scripts/cli.js node start                          # 启动节点集群
node scripts/cli.js node daemon --duration 30           # 启动 P2P 守护进程
node scripts/cli.js upload ./myfile.txt                 # 上传（自动分发多节点）
node scripts/cli.js download <CID>                      # 下载并校验
node scripts/cli.js capacity                            # 集群容量报告
```

## 全局命令安装

```bash
npm install -g .
ipfs-net plugin list        # 插件系统 CLI（两层 CLI 入口）
ipfs-storage --help         # 存储业务 CLI
```

## 目录结构

```
scripts/
├── core/           # 插件框架核心：Context / Base / Loader / Market / Permission / State / Resolver / Signature / Watcher / Config
├── plugins/        # 6 个系统插件
├── cli-plugin.js   # 插件驱动 CLI 入口（两层 CLI）
├── cli.js          # 存储业务 CLI 入口
└── *.js            # 业务模块：存储 / 网络 / 安全 / 分块 / 副本 / 同步 / 扩容 / ACP
references/         # 架构、CLI 参考、加密方案、ACP 协议文档
```

## 文档

- [架构设计](references/architecture.md)
- [CLI 命令参考](references/cli-reference.md)
- [加密方案](references/encryption.md)
- [ACP 智能体通信协议](references/acp-protocol.md)

## 版本

v1.0.0

## License

[MIT](LICENSE) © jiangopen8
