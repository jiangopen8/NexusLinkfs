# CLI 命令参考

## 概览
所有命令通过 `node scripts/cli.js <command>` 执行。

## 命令列表

### init - 初始化存储网络
```bash
node scripts/cli.js init
```
创建存储目录，检测磁盘空间，自动评估硬件配置，生成网络配置。

### hardware assess - 硬件评估
```bash
node scripts/cli.js hardware assess
```
评估 CPU/内存/磁盘配置，输出推荐节点数（3-100）、瓶颈维度、单节点配额和集群总容量。

### identity create - 创建节点身份
```bash
node scripts/cli.js identity create <node-id>
```
生成 Ed25519 密钥对和 PeerID。

### node daemon - 启动 P2P 网络守护进程
```bash
# 启动 3 节点 P2P 网络（真实 libp2p 互联 + 定时自动伸缩）
node scripts/cli.js node daemon

# 指定节点数量
node scripts/cli.js node daemon --count 5

# 运行指定秒数后自动停止
node scripts/cli.js node daemon --duration 10

# 自定义伸缩检查间隔（秒），0 禁用定时伸缩
node scripts/cli.js node daemon --autoscale-interval 30
node scripts/cli.js node daemon --autoscale-interval 0
```
启动真实 libp2p 实例，全网格拓扑互联，floodsub 广播通信。默认每 60 秒自动执行一次伸缩检查（根据使用率缩容/扩容）。

### node peers - 查看 P2P 对等连接
```bash
node scripts/cli.js node peers node-0
```
需要先运行 `node daemon` 启动 P2P 网络。

### node start - 启动节点
```bash
# 自动根据硬件评估启动推荐数量的节点
node scripts/cli.js node start

# 手动指定节点数量
node scripts/cli.js node start --count 5

# 启动单个节点
node scripts/cli.js node start node-0
```
不指定 `--count` 时，自动根据 CPU/内存/磁盘评估推荐节点数（3-100）。

### node stop - 停止节点
```bash
node scripts/cli.js node stop <node-id>
```
数据保留在磁盘上，可通过 `node start` 恢复。

### node list - 列出节点
```bash
node scripts/cli.js node list
```

### node add - 添加节点（扩容）
```bash
node scripts/cli.js node add
```

### node remove - 移除节点
```bash
node scripts/cli.js node remove <node-id>
```

### node autoscale run - 执行伸缩决策
```bash
node scripts/cli.js node autoscale run
```
根据集群使用率自动缩容（停止最空闲节点）或扩容（恢复/新增节点）。

### node autoscale status - 伸缩状态
```bash
node scripts/cli.js node autoscale status
```
显示运行/停止节点数、使用率、伸缩建议和当前配置。

### node autoscale config - 修改伸缩配置
```bash
# 设置扩容阈值 50%、缩容阈值 80%、最小 3 节点、最大 100 节点
node scripts/cli.js node autoscale config --up 50 --down 80 --min 3 --max 100

# 每次伸缩 2 个节点
node scripts/cli.js node autoscale config --step 2

# 禁用/启用自动伸缩
node scripts/cli.js node autoscale config --disable
node scripts/cli.js node autoscale config --enable
```

### upload - 上传文件
```bash
# 普通上传
node scripts/cli.js upload /path/to/file.txt

# 加密上传（三种密钥方式，优先级从高到低）
IPFS_STORAGE_KEY=mysecret node scripts/cli.js upload file.txt -e
node scripts/cli.js upload file.txt -e --key-file ./my.key
node scripts/cli.js upload file.txt -e --key <密钥>   # 不推荐，会留在 shell history

# 指定副本数
node scripts/cli.js upload /path/to/file.txt --replicas 5

# 多用户模式：手动传递 token
node scripts/cli.js upload file.txt --token <token>
```
返回文件 CID 作为唯一地址。上传前自动执行容量预检，容量不足时拒绝并提示。多用户模式下需先 `user login` 或通过 `--token` 认证。

### download - 下载文件
```bash
# 普通下载
node scripts/cli.js download <cid>

# 指定输出路径
node scripts/cli.js download <cid> --output /path/to/output.txt

# 解密下载（三种密钥方式）
IPFS_STORAGE_KEY=mysecret node scripts/cli.js download <cid> -d
node scripts/cli.js download <cid> -d --key-file ./my.key
node scripts/cli.js download <cid> -d --key <密钥>

# 多用户模式：手动传递 token
node scripts/cli.js download <cid> --token <token>
```
下载时自动进行 CID 哈希校验，输出路径经过安全校验（禁止写入系统目录）。多用户模式下需先 `user login` 或通过 `--token` 认证。

### info - 查看文件信息
```bash
node scripts/cli.js info <cid>
```

### files - 列出所有文件
```bash
node scripts/cli.js files
```

### delete - 删除文件
```bash
node scripts/cli.js delete <cid>

# 多用户模式：手动传递 token
node scripts/cli.js delete <cid> --token <token>
```
多用户模式下需先 `user login` 或通过 `--token` 认证。

### capacity - 集群容量报告
```bash
node scripts/cli.js capacity
```
展示集群使用率、剩余空间、各节点容量分布（含进度条和四级健康评级：healthy/caution/warning/critical）。

### upgrade - 滚动升级管理
```bash
# 前置检查（副本健康度、容量余量、是否有进行中的升级）
node scripts/cli.js upgrade --check

# 执行滚动升级（逐节点：停止→升级→重启→验证）
node scripts/cli.js upgrade --run

# 带自定义升级脚本
node scripts/cli.js upgrade --run --script ./my-upgrade.js

# 模拟升级（不实际停止/重启）
node scripts/cli.js upgrade --run --dry-run

# 从中断处恢复（进程被杀后继续）
node scripts/cli.js upgrade --resume

# 回滚到升级前状态
node scripts/cli.js upgrade --rollback

# 查看升级状态
node scripts/cli.js upgrade --status
```
数据与进程解耦，升级不影响文件系统上的数据。中断后通过 `--resume` 自动修复停止的节点并继续升级剩余节点。高危操作（`--run` / `--rollback` / `--resume`）在多用户模式下需先 `user login` 或通过 `--token` 认证；`--check` / `--status` 为只读操作无需认证。

### whitelist - P2P 节点白名单
```bash
# 查看白名单状态
node scripts/cli.js whitelist

# 启用/禁用
node scripts/cli.js whitelist --enable
node scripts/cli.js whitelist --disable

# 添加/移除节点
node scripts/cli.js whitelist --add <peerId>
node scripts/cli.js whitelist --remove <peerId>
```
启用后仅允许白名单内的 PeerId 建立连接，不在名单内的连接会被自动断开。

### user - 多用户管理
```bash
# 注册用户（自动生成认证密钥）
node scripts/cli.js user register <username>
node scripts/cli.js user register <username> --display-name "显示名"

# 用户登录（颁发 24h 有效的 HMAC token，自动保存会话）
node scripts/cli.js user login <username>

# 登出（清除本地会话）
node scripts/cli.js user logout

# 为用户启动节点
node scripts/cli.js user start <username> -n 3

# 列出所有用户及节点统计
node scripts/cli.js user list
```
登录后会话自动保存到 `session.json`，后续 upload/download/delete 自动使用。也可通过 `--token` 参数或 `IPFS_AUTH_TOKEN` 环境变量手动传递。注册用户后系统进入多用户模式，敏感命令必须携带有效认证。

### integrity - 数据完整性
```bash
# 扫描所有文件的 CID 完整性
node scripts/cli.js integrity scan

# 修复降级副本（从健康节点复制到缺失节点）
node scripts/cli.js integrity repair

# 垃圾回收（清理无索引引用的孤立 block）
node scripts/cli.js integrity gc
```

### replica - 副本策略管理
```bash
# 查看当前冗余配置
node scripts/cli.js replica config show

# 设置全局副本数
node scripts/cli.js replica config set --replicas 3

# 使用预设等级（basic/standard/high/paranoid）
node scripts/cli.js replica config preset standard

# 添加文件类型规则
node scripts/cli.js replica config add-rule --pattern "*.mp4" --replicas 2
```

### rebalance - 数据再平衡
```bash
# 检测倾斜并生成迁移计划
node scripts/cli.js rebalance plan

# 执行迁移（安全四步：复制→验证→更新索引→删除源）
node scripts/cli.js rebalance run

# 查看再平衡状态
node scripts/cli.js rebalance status
```
偏差 >20% 或差值 >30% 时触发。

### chunk - 分块存储管理
```bash
# 查看 chunk 分布状态
node scripts/cli.js chunk status

# 修复降级 chunk 副本
node scripts/cli.js chunk repair
```
≥1MB 文件自动切分为 256KB chunk，间隔分散策略分布到不同节点。

### index - 分片索引管理
```bash
# 查看索引状态
node scripts/cli.js index status

# 重建索引
node scripts/cli.js index rebuild
```

### encrypt keygen - 生成密钥
```bash
node scripts/cli.js encrypt keygen
```

### dashboard - 存储状态可视化面板
```bash
node scripts/cli.js dashboard
```
渲染终端可视化面板，包含：网络概览（节点数/文件数/同步覆盖率）、节点存储进度条、文件分布表（副本数/同步状态/加密标记）、容量预测与建议。

### sync full - 全量同步
```bash
node scripts/cli.js sync full
```
将索引中所有文件分发到所有 running 状态的节点，补全缺失副本。

### sync status - 同步覆盖率
```bash
node scripts/cli.js sync status
```
显示文件总数、节点总数、总副本数和同步覆盖率。

### p2p broadcast - floodsub 广播消息
```bash
# 从默认节点 node-0 广播
node scripts/cli.js p2p broadcast "hello network"

# 指定发送节点
node scripts/cli.js p2p broadcast "hello" --node node-1
```
需要先运行 `node daemon` 启动 P2P 网络。

### p2p listen - 监听 floodsub 广播
```bash
# 默认监听 10 秒
node scripts/cli.js p2p listen

# 指定监听时长和节点
node scripts/cli.js p2p listen --duration 30 --node node-1
```
需要先运行 `node daemon` 启动 P2P 网络。

### network status - 网络状态
```bash
node scripts/cli.js network status
```

### network health - 健康检查
```bash
node scripts/cli.js network health
```

### network forecast - 容量预测
```bash
node scripts/cli.js network forecast
```

### acp - ACP 智能体通信协议
```bash
# 注册 Agent
node scripts/cli.js acp register <agent-id>

# 创建会话
node scripts/cli.js acp session create <agent-id>

# 发送消息
node scripts/cli.js acp send <session-id> "message"
```

### activate - 一键激活系统（插件驱动入口）
```bash
node scripts/cli-plugin.js activate [--profile full|storage-only|admin]
```
依赖检查 → 节点初始化 → Profile 加载 → 状态恢复 → 健康检查，一步启动整个分布式存储网络。

### plugin - 插件管理（系统插件层，管理员）
```bash
node scripts/cli-plugin.js plugin list
node scripts/cli-plugin.js plugin mount <name>
node scripts/cli-plugin.js plugin unmount <name>
node scripts/cli-plugin.js plugin reload <name>
node scripts/cli-plugin.js plugin info

# 单插件升级：版本对比 + 失败自动回退
node scripts/cli-plugin.js plugin upgrade <name> --from <path-to-new-version.js> [--force]

# 批量升级：按依赖拓扑顺序重载所有已挂载插件
node scripts/cli-plugin.js plugin upgrade --all
```
`upgrade --all` 先按逆依赖顺序卸载全部插件，再按依赖顺序从注册表重新挂载；某插件失败时级联跳过其依赖者，并输出成功/失败汇总。

### market - 插件市场（用户插件层，普通用户）
```bash
node scripts/cli-plugin.js market list
node scripts/cli-plugin.js market search <keyword>
node scripts/cli-plugin.js market info <file-name>
node scripts/cli-plugin.js market install <file-name>
node scripts/cli-plugin.js market uninstall <file-name>
node scripts/cli-plugin.js market publish <path>
node scripts/cli-plugin.js market sources
node scripts/cli-plugin.js market stats
```

## 典型工作流

```bash
# 1. 初始化网络
node scripts/cli.js init

# 2. 启动节点集群（本地存储模式）
node scripts/cli.js node start

# 3. 启动 P2P 网络（真实 libp2p 互联）
node scripts/cli.js node daemon --duration 30

# 4. 测试 floodsub 广播
node scripts/cli.js p2p broadcast "hello network"

# 5. 上传文件（自动分发到所有在线节点）
node scripts/cli.js upload ./myfile.txt

# 6. 查看容量和同步状态
node scripts/cli.js capacity
node scripts/cli.js sync status

# 7. 查看存储状态面板
node scripts/cli.js dashboard

# 8. 下载文件
node scripts/cli.js download <返回的CID>

# 9. 升级前检查并执行滚动升级
node scripts/cli.js upgrade --check
node scripts/cli.js upgrade --run
```
