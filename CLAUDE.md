# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 Copilot API 网关集群，为 GitHub Copilot API 访问创建高可用系统。它由多个 copilot-api 节点组成，通过一个智能网关进行管理和配额分配。

## 开发命令

### Docker 操作
```bash
# 构建并启动所有服务
docker-compose -f docker-compose.portainer.yml up -d --build

# 查看日志
docker-compose logs -f                    # 所有服务
docker-compose logs -f smart-gateway      # 仅网关
docker-compose logs -f node-2             # 特定节点
```

### 网关开发
```bash
cd gateway
npm install
# 方式1: 使用环境变量指定节点
COPILOT_NODES='[{"url":"http://localhost:4141","token":""}]' node gateway.js
# 方式2: 使用 Docker socket 自动发现（需要挂载 /var/run/docker.sock）
node gateway.js
```

### 认证
```bash
# 首次为节点进行认证
docker run --auth copilot-api
```

## 架构

### 核心组件
1. **智能网关** (`gateway/gateway.js`): 管理多个 copilot-api 节点的 Node.js 服务
   - 通过 Docker API 自动发现带 `copilot.node=true` label 的容器
   - 实现每 5 分钟的主动配额轮询
   - 将请求路由到有可用配额的节点
   - 处理自动故障转移和重试

2. **Copilot API 节点**: 多个 ericc-ch/copilot-api 容器实例
   - 每个节点使用单独的 GitHub Copilot 账户
   - 通过 `copilot.node=true` label 被网关自动发现
   - 认证状态持久化在 Docker 卷中

### 关键模式
- **星型拓扑**: 中央网关管理多个边缘节点
- **主动配额管理**: 主动轮询 + 懒惰失效
- **OpenAI 兼容 API**: 网关暴露 `/v1/chat/completions` 端点

### 环境配置
可选的环境变量：
- `GATEWAY_PORT`: 外部端口（默认: 8080）
- `POLL_INTERVAL`: 配额检查间隔（毫秒，默认: 300000）
- `COPILOT_NODES`: 节点配置的 JSON 数组（可选，不设置则使用 Docker API 自动发现）
- `COPILOT_NODES_URLS`: 逗号分隔的节点地址（Docker API 不可用时的回退方案）

## 重要文件
- `docker-compose.portainer.yml`: 主要编排文件
- `gateway/gateway.js`: 核心网关实现
- `.env`: 包含敏感令牌（切勿提交）
- `entrypoint.sh`: 容器启动脚本
- `gemini-plan.md`: 详细架构文档

## 添加新节点
添加新的 copilot-api 节点：
1. 在 `docker-compose.portainer.yml` 中复制节点定义，修改编号
2. 在 `volumes` 区域添加对应的数据卷
3. 重启服务，网关会自动发现新节点

## API 端点
- `GET /health`: 检查节点状态和配额
- `POST /v1/chat/completions`: OpenAI 兼容的聊天端点