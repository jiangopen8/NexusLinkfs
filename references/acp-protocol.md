# ACP 智能体通信协议

## 概览
ACP (Agent Communication Protocol) 是智能体间通信协作的标准协议，本技能基于 AgentUnion ACP 规范实现本地化版本。

## 协议栈

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

**P2P 网络集成**：当 `node daemon` 启动 P2P 网络后，ACP 消息会自动通过 floodsub 广播到所有订阅节点。`sendMessage` 在本地持久化的同时触发 floodsub 广播，消息的 `metadata.p2pBroadcast.recipients` 字段记录实际接收节点数。

## 核心概念

### AID (Agent Identifier)
每个 Agent 的唯一身份标识，格式：`{agent-name}.{ap-domain}`

```
示例：storage-node-0.local.acp
```

### AgentProfile
Agent 的能力描述"名片"，包含：
- 名称和描述
- 核心能力列表
- 输入/输出格式
- 授权模式

### 会话 (Session)
Agent 间的通信通道，支持：
- 创建/关闭
- 加密传输
- 消息计数

## 消息类型

| 类型 | 说明 |
|------|------|
| hello | 上线广播 |
| discover | 能力发现 |
| session.create | 创建会话 |
| message | 普通消息 |
| task | 任务委派 |
| storage.request | 存储请求 |
| storage.response | 存储响应 |
| heartbeat | 心跳 |
| bye | 下线通知 |

## 通信流程

```
Agent A                    Agent B
   │                          │
   │  1. create_session()     │
   │─────────────────────────>│
   │                          │
   │  2. send_message()       │
   │─────────────────────────>│
   │                          │
   │  3. receive_message()    │
   │<─────────────────────────│
   │                          │
   │  4. close_session()      │
   │─────────────────────────>│
```

## CLI 命令

```bash
# 初始化 ACP 协议层
node scripts/cli.js acp init

# 注册 Agent
node scripts/cli.js acp register node-0 storage-agent -c "storage,retrieval"

# 发现 Agent
node scripts/cli.js acp discover
node scripts/cli.js acp discover -c storage

# 创建会话
node scripts/cli.js acp session create agent-a.local.acp agent-b.local.acp

# 发送消息
node scripts/cli.js acp send <session-id> '{"action":"query"}' -t task

# 接收消息
node scripts/cli.js acp receive <session-id>

# 广播
node scripts/cli.js acp broadcast my-agent.local.acp "hello network"

# 网络状态
node scripts/cli.js acp status
```

## 与存储网络的集成

ACP 协议层与 IPFS 存储网络深度集成：
- 每个存储节点可注册为 ACP Agent
- 通过 ACP 协议发起存储请求（upload/download）
- 节点间通过 ACP 消息同步状态
- 支持加密会话保护敏感通信

## 安全机制

- 会话级 AES-256 加密
- 消息签名验证
- 能力授权控制
