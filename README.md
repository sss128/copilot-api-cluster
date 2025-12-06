# Copilot 智能网关集群

基于 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) 的高可用智能网关系统，支持多节点配额管理和自动故障转移。

## 架构概述

本系统包含以下组件：

1. **Copilot API 节点**：多个 `ericc-ch/copilot-api` 容器实例，每个绑定独立的 GitHub Copilot 账号
2. **智能网关**：基于 Node.js 的调度服务，负责：
   - 监控各节点配额使用情况
   - 智能路由请求到可用节点
   - 自动故障转移和重试
   - 配额耗尽自动切换

## 快速开始

### 前置要求

- Docker 和 Docker Compose
- 至少一个有效的 GitHub Copilot 账号 Token（ghu_ 或 ghp_ 开头）

### 部署步骤

1. **克隆或下载本项目**

2. **配置环境变量**
   ```bash
   cp .env.example .env
   ```
   编辑 `.env` 文件，填入你的 GitHub Copilot Token：
   ```bash
   TOKEN_ACCOUNT_1=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TOKEN_ACCOUNT_2=ghu_yyyyyyyyyyyyyyyyyyyyyyyyyyyy
   ```
   > 注意：Token 可以从现有 VS Code 登录信息中提取，或使用 `copilot-api` 的 auth 命令获取

3. **启动服务**
   ```bash
   docker-compose up -d --build
   ```

4. **验证部署**
   - 健康检查：访问 `http://localhost:8080/health`
   - 应返回 JSON 格式的节点状态信息

5. **配置客户端**
   - **Cursor**：设置 Base URL 为 `http://localhost:8080/v1`
   - **Claude Code**：配置相应的 API 端点
   - **其他 OpenAI 兼容客户端**：使用 `http://localhost:8080/v1` 作为 API 地址

## 配置说明

### 环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `TOKEN_ACCOUNT_1` | 第一个 GitHub Copilot Token | `ghu_xxx...` |
| `TOKEN_ACCOUNT_2` | 第二个 GitHub Copilot Token | `ghu_yyy...` |
| （可选添加更多） | | |

### Docker Compose 配置

- **智能网关**：运行在 `localhost:8080`
- **Copilot 节点**：内部端口 `4141`，不对外暴露
- **数据持久化**：节点数据保存在 `./data/nodeX/` 目录

### 网关配置参数

网关支持以下环境变量（在 `docker-compose.yml` 中配置）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | 网关监听端口 |
| `POLL_INTERVAL` | 300000 (5分钟) | 配额轮询间隔（毫秒） |
| `RETRY_LIMIT` | 3 | 请求失败重试次数 |

## 工作原理

### 配额监控
1. **主动轮询**：网关每 5 分钟查询各节点的 `/usage` 接口
2. **状态缓存**：在内存中维护节点配额状态
3. **惰性失效**：当请求失败时立即刷新节点状态

### 路由策略（主备故障转移模式）
⚠️ **重要**：本系统采用主备故障转移模式，而非负载均衡，以避免触发 GitHub 风控。

1. **顺序使用**：始终优先使用第一个可用节点（主节点），只有在其配额耗尽或故障时才切换到下一个节点
2. **单账号活跃**：在任何时刻，只有一个账号在 active 状态，避免 IP 下多账号并发请求
3. **故障转移**：仅以下情况触发切换：
   - 配额耗尽（HTTP 402/403/429）
   - 网络错误或超时
   - 节点离线
4. **顺序切换**：节点切换遵循固定顺序（0→1→2→...→0）
5. **乐观扣减**：每次成功请求后本地扣减配额计数

### 为何使用主备模式？

在共享 IP 环境（如 NAT、服务器）下，多个账号同时请求会触发 GitHub 的高危风控。主备模式模拟正常用户行为：
- 一个账号使用完毕（配额耗尽）
- 下一个账号才开始使用
- 形成自然的"接力"模式

### 错误处理
- **配额耗尽**：自动标记节点为 `DRAINED`，切换其他节点
- **网络故障**：标记为 `OFFLINE`，定期重试
- **Token 失效**：标记为 `INVALID_TOKEN`，停止轮询
- **限流**：标记为 `RATE_LIMITED`，等待恢复

## API 端点

### 健康检查
```
GET /health
```
返回所有节点的状态和剩余配额，包括：
- 当前活跃节点索引
- 活跃节点 ID
- 模式标识：`active-standby`
- 各节点的详细状态和是否活跃

### 管理接口
```
POST /admin/reset-active-node
```
手动重置活跃节点到第一个可用节点。用于紧急情况下的节点重置。

### Copilot API 代理
```
POST /v1/chat/completions
```
完全兼容 OpenAI API 格式，透传到后端 Copilot 服务。

## 监控与日志

### 查看日志
```bash
# 查看所有服务日志
docker-compose logs -f

# 仅查看网关日志
docker-compose logs -f smart-gateway

# 查看特定节点日志
docker-compose logs -f copilot-node-1
```

### 节点状态
访问 `http://localhost:8080/health` 可实时查看：
- 当前活跃节点（active node）
- 各节点在线状态（READY、DRAINED、OFFLINE等）
- 剩余 Premium Requests 配额
- 最后检查时间
- 节点切换日志

## 扩展与定制

### 添加更多节点
1. 在 `.env` 中添加新的 Token
2. 在 `docker-compose.yml` 中添加新的 `copilot-node-N` 服务
3. 更新 `smart-gateway` 服务的 `COPILOT_NODES` 环境变量
4. 重启服务：`docker-compose up -d`

### 修改轮询间隔
在 `docker-compose.yml` 中修改 `smart-gateway` 的环境变量：
```yaml
environment:
  - POLL_INTERVAL=600000  # 10分钟
```

### 开发模式
如需修改网关代码：
```bash
# 进入网关目录
cd gateway

# 安装依赖（本地开发）
npm install

# 运行网关（需要设置环境变量）
COPILOT_NODES='[{"url":"http://localhost:4141","token":"ghu_xxx"}]' node gateway.js
```

## 故障排除

### 常见问题

1. **健康检查返回空节点列表**
   - 检查 `.env` 文件中的 Token 是否正确
   - 查看网关日志：`docker-compose logs smart-gateway`

2. **所有节点显示 OFFLINE**
   - 检查网络连接
   - 确认 Docker 容器正常运行
   - 查看节点日志：`docker-compose logs copilot-node-1`

3. **客户端连接失败**
   - 确认网关端口 `8080` 可访问
   - 检查防火墙设置
   - 验证客户端配置的 Base URL

4. **配额更新延迟**
   - 默认轮询间隔为 5 分钟
   - 可通过 `POLL_INTERVAL` 调整
   - 实际配额耗尽时会立即触发刷新

5. **频繁切换节点**
   - 检查是否为负载均衡模式（不正确）
   - 确认是否为主备模式（正确）
   - 查看日志中的 "主备模式" 标识

### 日志级别
网关使用 Fastify 内置日志，可通过环境变量调整：
```bash
# 在 docker-compose.yml 中添加
- LOG_LEVEL=debug
```

## 安全注意事项

1. **Token 保护**
   - `.env` 文件包含敏感信息，不要提交到版本控制
   - 生产环境使用 Docker Secrets 或 Kubernetes Secrets

2. **网络隔离**
   - Copilot 节点不对外暴露端口
   - 仅网关服务对外提供服务
   - 使用 Docker 内部网络通信

3. **访问控制**
   - 考虑在网关前添加认证层
   - 限制访问 IP 范围
   - 监控异常请求模式

## 许可证

本项目基于开源组件构建，具体许可证参考各组件文档。

## 技术支持

遇到问题请：
1. 查看日志文件
2. 检查健康状态端点
3. 参考原项目 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) 文档