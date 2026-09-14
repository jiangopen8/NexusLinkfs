# 加密方案说明

## 概览
使用 AES-256 对称加密算法保护文件内容，密钥由用户自行管理。

## 加密流程

```
原始文件 → Base64 编码 → AES-256 加密 → 存储到节点
```

## 解密流程

```
从节点读取 → AES-256 解密 → Base64 解码 → 原始文件
```

## 密钥生成

```bash
node scripts/cli.js encrypt keygen
```

输出示例：
```
密钥: a3f5c8d9e2b7f1a4...
算法: AES-256
```

## 密钥传递方式（按安全优先级排序）

| 优先级 | 方式 | 示例 | 安全性 |
|--------|------|------|--------|
| 1 | 环境变量 | `IPFS_STORAGE_KEY=xxx node scripts/cli.js upload f.txt -e` | 最高，不留痕迹 |
| 2 | 密钥文件 | `node scripts/cli.js upload f.txt -e --key-file ./my.key` | 高，需 chmod 600 |
| 3 | CLI 参数 | `node scripts/cli.js upload f.txt -e --key xxx` | 低，会留在 shell history |

系统按优先级自动解析：环境变量 > 密钥文件 > CLI 参数。使用 `--key` 时会打印安全警告。

## 加密上传示例

```bash
# 生成密钥
node scripts/cli.js encrypt keygen

# 方式 1：环境变量（推荐）
IPFS_STORAGE_KEY=<密钥> node scripts/cli.js upload secret.txt -e

# 方式 2：密钥文件（推荐）
echo "<密钥>" > my.key && chmod 600 my.key
node scripts/cli.js upload secret.txt -e --key-file ./my.key

# 方式 3：CLI 参数（不推荐）
node scripts/cli.js upload secret.txt --encrypt --key <密钥>
```

## 解密下载示例

```bash
# 环境变量
IPFS_STORAGE_KEY=<密钥> node scripts/cli.js download <cid> -d

# 密钥文件
node scripts/cli.js download <cid> -d --key-file ./my.key
```

## 安全注意事项

| 事项 | 说明 |
|------|------|
| 密钥保管 | 密钥丢失将无法解密文件，务必妥善保存 |
| 密钥传递 | 优先使用环境变量或密钥文件，避免 --key 明文参数 |
| 密钥文件权限 | 密钥文件应设置为 600（仅所有者可读写），系统会检查并警告 |
| 加密粒度 | 整个文件加密，非部分加密 |
| 性能影响 | 加密/解密会增加 CPU 开销，大文件耗时更长 |
| 路径安全 | 上传/下载路径经过安全校验，禁止路径遍历和写入系统目录 |

## 密钥格式
- 长度：64 个十六进制字符（256 位）
- 字符集：0-9, a-f
- 示例：`a3f5c8d9e2b7f1a4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8`

## 最佳实践
1. 为不同文件使用不同密钥
2. 密钥存储在安全的位置（密码管理器）
3. 定期轮换密钥
4. 备份密钥以防丢失
