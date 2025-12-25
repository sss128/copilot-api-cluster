# Copilot 智能网关集群

基于 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) 的高可用智能网关系统，支持多节点配额管理和自动故障转移。

## 架构概述

本系统包含以下组件：

1. **Copilot API 节点**：多个 `ericc-ch/copilot-api` 容器实例，每个绑定独立的 GitHub Copilot 账号
2. **智能网关**：基于 Node.js 的调度服务，负责：
   - 通过 Docker API 自动发现带 `copilot.node=true` label 的节点
   - 监控各节点配额使用情况
   - 智能路由请求到可用节点
   - 自动故障转移和重试
   - 配额耗尽自动切换

## 快速开始

### 前置要求

- Docker 和 Docker Compose
- 至少一个有效的 GitHub Copilot 订阅账号

### 部署步骤

#### 1. 克隆项目

```bash
git clone <本项目地址>
cd copilot-api-cluster
```

#### 2. 首次部署 - 节点认证

首次部署需要为每个节点完成 GitHub 账号认证。**必须逐个节点进行认证**，不能同时启动所有节点。

**认证第一个节点：**

```bash
# 单独启动节点2
docker-compose -f docker-compose.portainer.yml up -d node-2

# 查看日志，获取认证链接
docker-compose -f docker-compose.portainer.yml logs -f node-2
```

日志中会显示类似内容：
```
Please visit https://github.com/login/device
and enter code: XXXX-XXXX
```

在**任意浏览器**中：
1. 打开 https://github.com/login/device
2. 输入日志中显示的验证码（如 `XXXX-XXXX`）
3. 登录你的 GitHub Copilot 账号并授权

认证成功后，日志会显示服务已启动，Token 会自动保存到 Docker volume 中。

**认证其他节点：**

重复上述步骤，依次认证其他节点（使用不同的 GitHub 账号）：

```bash
# 节点3
docker-compose -f docker-compose.portainer.yml up -d node-3
docker-compose -f docker-compose.portainer.yml logs -f node-3

# 更多节点...
```

> **注意**：每个节点应绑定不同的 GitHub Copilot 账号，以实现配额叠加。

#### 3. 启动智能网关

所有节点认证完成后，启动网关服务：

```bash
# 启动完整服务（包括网关）
docker-compose -f docker-compose.portainer.yml up -d
```

#### 4. 验证部署

```bash
# 健康检查
curl http://localhost:8080/health
```

应返回 JSON 格式的节点状态信息，包含各节点的配额和在线状态。

#### 5. 配置客户端

- **Cursor**：设置 Base URL 为 `http://localhost:8080/v1`
- **Claude Code**：配置 API 端点为 `http://localhost:8080/v1`
- **其他 OpenAI 兼容客户端**：使用 `http://localhost:8080/v1` 作为 API 地址

### 后续启动

认证信息保存在 Docker volume 中，后续重启无需重新认证：

```bash
# 停止所有服务
docker-compose -f docker-compose.portainer.yml down

# 启动所有服务（无需重新认证）
docker-compose -f docker-compose.portainer.yml up -d
```

> **警告**：如果执行 `docker-compose down -v` 会删除 volume，导致认证信息丢失，需要重新认证。

## 配置说明

### 环境变量（可选）

网关支持通过环境变量进行高级配置，可在启动时传入：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `GATEWAY_PORT` | 8080 | 网关对外暴露的端口 |
| `POLL_INTERVAL` | 300000 | 配额轮询间隔（毫秒，默认5分钟） |
| `RETRY_LIMIT` | 3 | 请求失败重试次数 |

示例：
```bash
GATEWAY_PORT=9000 docker-compose -f docker-compose.portainer.yml up -d
```

### Docker Compose 配置

- **智能网关**：默认运行在 `localhost:8080`
- **Copilot 节点**：内部端口 `4141`，不对外暴露
- **数据持久化**：认证信息保存在 Docker 命名卷中（`data-2`、`data-3` 等）

## 工作原理

### 配额监控
1. **主动轮询**：网关每 5 分钟查询各节点的 `/usage` 接口
2. **状态缓存**：在内存中维护节点配额状态
3. **惰性失效**：当请求失败时立即刷新节点状态

### 路由策略（主备故障转移模式）
⚠️ **重要**：本系统采用主备故障转移模式，而非负载均衡，以避免触发 GitHub 风控。

1. **反向调度**：优先使用索引最大的节点（如节点4），只有在其配额耗尽或故障时才切换到下一个节点
2. **单账号活跃**：在任何时刻，只有一个账号在 active 状态，避免同一 IP 下多账号并发请求
3. **故障转移**：仅以下情况触发切换：
   - 配额耗尽（HTTP 402/403/429）
   - 网络错误或超时
   - 节点离线
4. **切换顺序**：节点切换遵循反向顺序（4→3→2→1→4）
5. **乐观扣减**：每次成功请求后本地扣减配额计数
6. **离线恢复**：每 30 秒检查离线节点是否恢复

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
手动重置活跃节点到最后一个（索引最大的）可用节点。用于紧急情况下的节点重置。

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
docker-compose logs -f node-2
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

1. 在 `docker-compose.portainer.yml` 中复制节点定义，修改编号：
   ```yaml
   node-4: { <<: *copilot-node-template, ports: ["4144:4141"], volumes: ["data-4:/root/.local/share/copilot-api"] }
   ```
2. 在 `volumes` 区域添加对应卷：
   ```yaml
   volumes:
     data-4:
   ```
3. 启动新节点并完成 GitHub 认证
4. 网关会自动发现新节点（无需手动配置）

### 修改轮询间隔

启动时通过环境变量设置：
```bash
POLL_INTERVAL=600000 docker-compose -f docker-compose.portainer.yml up -d
```

### 开发模式
如需修改网关代码：
```bash
# 进入网关目录
cd gateway

# 安装依赖（本地开发）
npm install

# 运行网关
# 方式1：使用环境变量指定节点
COPILOT_NODES='[{"url":"http://localhost:4141","token":""}]' node gateway.js

# 方式2：使用 Docker socket 自动发现（需要挂载 /var/run/docker.sock）
node gateway.js
```

## 故障排除

### 常见问题

1. **认证失败或超时**
   - 确保网络能访问 `github.com`
   - 检查是否在规定时间内完成了浏览器授权
   - 重启节点重新获取认证码：`docker-compose -f docker-compose.portainer.yml restart node-2`

2. **健康检查返回空节点列表**
   - 检查节点是否完成认证
   - 确认节点容器带有 `copilot.node=true` label
   - 确认网关已挂载 Docker socket
   - 查看网关日志：`docker-compose -f docker-compose.portainer.yml logs smart-gateway`

3. **所有节点显示 OFFLINE**
   - 检查网络连接
   - 确认 Docker 容器正常运行
   - 查看节点日志：`docker-compose -f docker-compose.portainer.yml logs node-2`

4. **客户端连接失败**
   - 确认网关端口 `8080` 可访问
   - 检查防火墙设置
   - 验证客户端配置的 Base URL

5. **配额更新延迟**
   - 默认轮询间隔为 5 分钟
   - 可通过 `POLL_INTERVAL` 调整
   - 实际配额耗尽时会立即触发刷新

6. **频繁切换节点**
   - 检查是否为负载均衡模式（不正确）
   - 确认是否为主备模式（正确）
   - 查看日志中的 "主备模式" 标识

### 日志级别
网关使用 Fastify 内置日志，可通过环境变量调整：
```bash
LOG_LEVEL=debug docker-compose -f docker-compose.portainer.yml up -d
```

## 安全注意事项

1. **认证数据保护**
   - 认证信息保存在 Docker volume 中，请勿随意删除
   - 不要将 volume 数据提交到版本控制
   - 生产环境建议定期备份 volume

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