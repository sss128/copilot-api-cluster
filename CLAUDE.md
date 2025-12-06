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
docker-compose logs -f copilot-node-1     # 特定节点
```

### 网关开发
```bash
cd gateway
npm install
COPILOT_NODES='[{"url":"http://localhost:4141","token":"ghu_xxx"}]' node gateway.js
```

### 认证
```bash
# 首次为节点进行认证
docker run --auth copilot-api
```

## 架构

### 核心组件
1. **智能网关** (`gateway/gateway.js`): 管理多个 copilot-api 节点的 Node.js 服务
   - 实现每 5 分钟的主动配额轮询
   - 将请求路由到有可用配额的节点
   - 处理自动故障转移和重试

2. **Copilot API 节点**: 多个 ericc-ch/copilot-api 容器实例
   - 每个节点使用单独的 GitHub Copilot 账户
   - 认证状态持久化在 Docker 卷中
   - 只能通过网关访问

### 关键模式
- **星型拓扑**: 中央网关管理多个边缘节点
- **主动配额管理**: 主动轮询 + 懒惰失效
- **OpenAI 兼容 API**: 网关暴露 `/v1/chat/completions` 端点

### 环境配置
必要的环境变量：
- `TOKEN_ACCOUNT_1`, `TOKEN_ACCOUNT_2` 等: GitHub Copilot 令牌
- `GATEWAY_PORT`: 外部端口（默认: 8080）
- `POLL_INTERVAL`: 配额检查间隔（毫秒）
- `COPILOT_NODES`: 节点配置的 JSON 数组

## 重要文件
- `docker-compose.portainer.yml`: 主要编排文件
- `gateway/gateway.js`: 核心网关实现
- `.env`: 包含敏感令牌（切勿提交）
- `entrypoint.sh`: 容器启动脚本
- `gemini-plan.md`: 详细架构文档

## 添加新节点
添加新的 copilot-api 节点：
1. 将令牌添加到 `.env` 文件
2. 在 `docker-compose.yml` 中添加服务定义
3. 更新 `COPILOT_NODES` 环境变量
4. 重启服务

## API 端点
- `GET /health`: 检查节点状态和配额
- `POST /v1/chat/completions`: OpenAI 兼容的聊天端点