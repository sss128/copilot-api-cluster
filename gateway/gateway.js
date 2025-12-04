/**
 * Copilot Smart Gateway
 *
 * 功能：多节点配额管理、主动轮询、自动故障转移
 * 作者：Domain Expert
 */

const Fastify = require('fastify');
const axios = require('axios');

// --- 配置区域 ---
// 通过环境变量注入配置，格式为 JSON 字符串
// 示例：[{"url": "http://node1:4141", "token": "ghp_xx"}, {"url": "http://node2:4141", "token": "ghp_yy"}]
const NODES_CONFIG = process.env.COPILOT_NODES ? JSON.parse(process.env.COPILOT_NODES) : [];
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = 5 * 60 * 1000; // 5分钟轮询一次
const RETRY_LIMIT = 3; // 最大重试次数

// --- 全局状态注册表 ---
// 在内存中维护节点状态
let nodeRegistry = NODES_CONFIG.map((node, index) => ({
    id: `node-${index}`,
    url: node.url,
    token: node.token,
    status: 'UNKNOWN', // 状态枚举: UNKNOWN, READY, DRAINED, OFFLINE, ERROR
    premiumRemaining: 0,
    lastCheck: 0,
    failureCount: 0
}));

const server = Fastify({
    logger: true,
    connectionTimeout: 60000 // 设置较长的超时以适应 LLM 生成时间
});

// --- 核心功能函数 ---

/**
 * 查询单个节点的配额情况
 * @param {Object} node 节点对象
 */
async function syncNodeQuota(node) {
    try {
        server.log.debug(`Syncing quota for ${node.id} (${node.url})...`);

        // 构造请求，透传 Token
        const response = await axios.get(`${node.url}/usage`, {
            headers: { 'Authorization': `Bearer ${node.token}` },
            timeout: 10000 // 10秒超时
        });

        const data = response.data;

        // 解析 JSON 路径：quota_snapshots.premium_interactions.remaining
        // 注意防御性编程，防止字段不存在导致 Crash
        const snapshots = data.quota_snapshots || {};
        const premium = snapshots.premium_interactions || {};

        let remaining = 0;

        // 逻辑：优先取 remaining，如果不存在则用 limit - usage，如果 limit 为空则视为无限
        if (premium.remaining !== undefined) {
            remaining = premium.remaining;
        } else if (premium.limit !== undefined && premium.limit !== null && premium.usage !== undefined) {
            remaining = premium.limit - premium.usage;
        } else if (premium.limit === null) {
            remaining = 999999; // 无限额度
        }

        // 更新状态
        node.premiumRemaining = remaining;
        node.lastCheck = Date.now();
        node.failureCount = 0;

        if (remaining > 0) {
            node.status = 'READY';
            server.log.info(`Node ${node.id} is READY. Premium Quota: ${remaining}`);
        } else {
            node.status = 'DRAINED';
            server.log.warn(`Node ${node.id} is DRAINED. Premium Quota: 0`);
        }

    } catch (error) {
        node.failureCount++;
        server.log.error(`Node ${node.id} sync failed: ${error.message}`);

        // 区分错误类型
        if (error.response && error.response.status === 401) {
            node.status = 'INVALID_TOKEN'; // Token 失效，无需重试
        } else if (error.response && error.response.status === 429) {
            node.status = 'RATE_LIMITED'; // 暂时被 GitHub 限流
        } else {
            node.status = 'OFFLINE'; // 网络或其他错误
        }
    }
}

/**
 * 调度器：启动后台轮询
 */
function startScheduler() {
    // 1. 立即执行一次全量扫描
    server.log.info("Starting initial quota sweep...");
    Promise.all(nodeRegistry.map(syncNodeQuota));

    // 2. 设置定时器
    setInterval(() => {
        server.log.info("Running periodic quota sweep...");
        // 仅检查非永久失效的节点
        const activeNodes = nodeRegistry.filter(n => n.status !== 'INVALID_TOKEN');
        activeNodes.forEach(syncNodeQuota);
    }, POLL_INTERVAL);
}

/**
 * 路由策略：选择最佳节点
 * 策略：在 READY 状态的节点中，选择剩余额度最大的
 */
function selectBestNode() {
    const candidates = nodeRegistry.filter(n => n.status === 'READY' && n.premiumRemaining > 0);

    if (candidates.length === 0) return null;

    // 按剩余额度降序排列
    candidates.sort((a, b) => b.premiumRemaining - a.premiumRemaining);

    return candidates;
}

// --- 路由定义 ---

// 健康检查
server.get('/health', async () => {
    return {
        status: 'ok',
        nodes: nodeRegistry.map(n => ({ id: n.id, status: n.status, quota: n.premiumRemaining }))
    };
});

// 通用代理处理函数 (匹配 /v1/*)
server.all('/v1/*', async (request, reply) => {
    let attempts = 0;
    let lastError = null;

    // 复制节点列表引用，用于在本次请求中剔除失败节点
    let availableNodes = selectBestNode() || [];

    // 排序（selectBestNode已排序，这里可省略，但保留以防万一）
    availableNodes.sort((a, b) => b.premiumRemaining - a.premiumRemaining);

    while (attempts < RETRY_LIMIT && availableNodes.length > 0) {
        const targetNode = availableNodes[0]; // 取最优
        attempts++;

        try {
            // 构造上游 URL
            const upstreamUrl = `${targetNode.url}${request.url}`;

            server.log.info(`Forwarding request to ${targetNode.id} (Quota: ${targetNode.premiumRemaining})`);

            // 转发请求
            // 注意：使用 responseType: 'stream' 以支持流式输出 (Server-Sent Events)
            const proxyResponse = await axios({
                method: request.method,
                url: upstreamUrl,
                headers: {
                   ...request.headers,
                    host: undefined, // 移除 host 头，避免混淆
                    authorization: `Bearer ${targetNode.token}` // 强制使用节点的 Token
                },
                data: request.body,
                responseType: 'stream',
                validateStatus: () => true // 允许所有状态码通过，手动处理
            });

            // 检查是否是业务层面的拒绝 (如额度耗尽)
            // 通常 GitHub 会返回 402, 403 或特定的 429
            if (proxyResponse.status === 402 || (proxyResponse.status === 403 && checkIsQuotaError(proxyResponse))) {
                throw new Error('QUOTA_EXHAUSTED_RUNTIME');
            }

            // 如果成功 (2xx)，进行乐观扣减
            if (proxyResponse.status >= 200 && proxyResponse.status < 300) {
                // 简单的扣减策略：假设每次调用消耗 1 个单位
                // 实际上 Opus 可能消耗更多，但下一次心跳会修正它
                targetNode.premiumRemaining = Math.max(0, targetNode.premiumRemaining - 1);
            }

            // 透传响应头和状态码
            reply.code(proxyResponse.status);
            Object.keys(proxyResponse.headers).forEach(key => {
                reply.header(key, proxyResponse.headers[key]);
            });

            // 透传数据流
            return reply.send(proxyResponse.data);

        } catch (error) {
            server.log.warn(`Request failed on ${targetNode.id}: ${error.message}`);

            // 惰性失效触发
            if (error.message === 'QUOTA_EXHAUSTED_RUNTIME' || (error.response && error.response.status === 429)) {
                targetNode.premiumRemaining = 0;
                targetNode.status = 'DRAINED';
                // 立即触发异步刷新，确认真实状态
                syncNodeQuota(targetNode);
            }

            // 从当前可用列表中移除，尝试下一个
            availableNodes.shift();
            lastError = error;
        }
    }

    // 所有节点均失败
    server.log.error("All nodes exhausted or failed.");
    reply.code(503).send({
        error: {
            message: "No Copilot premium quota available across all nodes.",
            type: "service_unavailable",
            details: lastError ? lastError.message : "Pool exhausted"
        }
    });
});

/**
 * 辅助函数：判断是否为配额相关的错误
 * 由于 GitHub 错误体是流式的，这里做简化处理，实际生产中可能需要窥探流的前几个字节
 * 或者根据 Header 判断
 */
function checkIsQuotaError(response) {
    // 简单实现：仅根据状态码。
    // 如果需要检查 Body 内容，需要将 stream 转换为 buffer，但这会破坏流式传输的性能。
    // 建议主要依赖状态码 402/403/429。
    return false; // 占位
}

// 启动服务
const start = async () => {
    try {
        await server.listen({ port: PORT, host: '0.0.0.0' });
        startScheduler();
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();