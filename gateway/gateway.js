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
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 5 * 60 * 1000; // 从环境变量读取，默认5分钟
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

// 当前活跃节点索引（主备模式的关键）
// 初始化为最后一个节点，实现反向调度
let activeNodeIndex = NODES_CONFIG.length > 0 ? NODES_CONFIG.length - 1 : 0;

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
 * 获取当前活跃节点（主备模式，反向调度）
 * 返回当前应该使用的节点，如果不活跃则尝试切换到下一个可用节点
 * 优先选择索引较大的节点（从末尾开始）
 */
function getActiveNode() {
    // 如果当前活跃节点可用，直接返回
    if (nodeRegistry[activeNodeIndex] &&
        nodeRegistry[activeNodeIndex].status === 'READY' &&
        nodeRegistry[activeNodeIndex].premiumRemaining > 0) {
        return nodeRegistry[activeNodeIndex];
    }

    // 当前节点不可用，从后往前查找可用节点
    // 从最后一个节点开始，向下查找
    for (let i = nodeRegistry.length - 1; i >= 0; i--) {
        const node = nodeRegistry[i];
        if (node && node.status === 'READY' && node.premiumRemaining > 0) {
            activeNodeIndex = i; // 更新活跃节点索引
            server.log.info(`切换到活跃节点: ${node.id} (索引: ${i})`);
            return node;
        }
    }

    return null; // 没有可用节点
}

/**
 * 切换到下一个节点（故障转移，反向调度）
 * @param {string} reason - 切换原因
 */
function switchToNextNode(reason) {
    const originalIndex = activeNodeIndex;

    // 从后往前寻找下一个可用节点（优先选择索引更大的节点）
    // 从当前节点的前一个节点开始，一直查找到第一个节点
    for (let i = originalIndex - 1; i >= 0; i--) {
        const node = nodeRegistry[i];
        if (node && node.status !== 'INVALID_TOKEN') {
            activeNodeIndex = i;
            server.log.info(`故障转移: ${reason}`);
            server.log.info(`从节点 ${originalIndex} 切换到节点 ${i} (${node.id})`);

            // 立即检查新节点的状态
            syncNodeQuota(node);
            return node;
        }
    }

    // 如果前面的节点都不可用，再从最后一个节点开始查找
    for (let i = nodeRegistry.length - 1; i > originalIndex; i--) {
        const node = nodeRegistry[i];
        if (node && node.status !== 'INVALID_TOKEN') {
            activeNodeIndex = i;
            server.log.info(`故障转移: ${reason}`);
            server.log.info(`从节点 ${originalIndex} 切换到节点 ${i} (${node.id})`);

            // 立即检查新节点的状态
            syncNodeQuota(node);
            return node;
        }
    }

    server.log.error('所有节点都不可用');
    return null;
}

// --- 路由定义 ---

// 健康检查
server.get('/health', async () => {
    const activeNode = nodeRegistry[activeNodeIndex];
    return {
        status: 'ok',
        activeNodeIndex,
        activeNodeId: activeNode ? activeNode.id : null,
        mode: 'active-standby', // 标识当前模式
        nodes: nodeRegistry.map(n => ({
            id: n.id,
            status: n.status,
            quota: n.premiumRemaining,
            isActive: n.id === (activeNode ? activeNode.id : null)
        }))
    };
});

// 重置活跃节点到最后一个可用节点（管理接口，反向调度）
server.post('/admin/reset-active-node', async () => {
    // 从后往前查找，选择最后一个可用节点
    for (let i = nodeRegistry.length - 1; i >= 0; i--) {
        const node = nodeRegistry[i];
        if (node && node.status === 'READY' && node.premiumRemaining > 0) {
            activeNodeIndex = i;
            server.log.info(`手动重置活跃节点到: ${node.id} (索引: ${i})`);
            return {
                success: true,
                message: `活跃节点已重置到 ${node.id}`,
                activeNodeIndex: i,
                activeNodeId: node.id
            };
        }
    }

    return {
        success: false,
        message: '没有可用的节点'
    };
});

// 通用代理处理函数 (匹配 /v1/*)
server.all('/v1/*', async (request, reply) => {
    let attempts = 0;
    let lastError = null;
    let currentNode = null;

    // 主备模式：始终从当前活跃节点开始
    while (attempts < nodeRegistry.length) {
        currentNode = getActiveNode();

        if (!currentNode) {
            server.log.error("没有可用的活跃节点");
            break;
        }

        attempts++;

        try {
            // 构造上游 URL
            const upstreamUrl = `${currentNode.url}${request.url}`;

            server.log.info(`[主备模式] 转发请求到 ${currentNode.id} (索引: ${activeNodeIndex}, 剩余配额: ${currentNode.premiumRemaining})`);

            // 转发请求
            // 注意：使用 responseType: 'stream' 以支持流式输出 (Server-Sent Events)
            const proxyResponse = await axios({
                method: request.method,
                url: upstreamUrl,
                headers: {
                   ...request.headers,
                    host: undefined, // 移除 host 头，避免混淆
                    authorization: `Bearer ${currentNode.token}` // 强制使用节点的 Token
                },
                data: request.body,
                responseType: 'stream',
                validateStatus: () => true // 允许所有状态码通过，手动处理
            });

            // 检查是否是业务层面的拒绝 (如额度耗尽)
            // 通常 GitHub 会返回 402, 403 或特定的 429
            if (proxyResponse.status === 402 ||
                (proxyResponse.status === 403 && checkIsQuotaError(proxyResponse)) ||
                (proxyResponse.status === 429)) {

                server.log.warn(`节点 ${currentNode.id} 配额耗尽或被限流 (状态码: ${proxyResponse.status})`);

                // 标记当前节点为耗尽
                currentNode.premiumRemaining = 0;
                currentNode.status = 'DRAINED';

                // 切换到下一个节点
                const nextNode = switchToNextNode(`节点 ${currentNode.id} 配额耗尽`);
                if (!nextNode) {
                    lastError = new Error('所有节点配额都已耗尽');
                    break;
                }

                // 继续下一次尝试
                continue;
            }

            // 如果成功 (2xx)，进行乐观扣减
            if (proxyResponse.status >= 200 && proxyResponse.status < 300) {
                // 简单的扣减策略：假设每次调用消耗 1 个单位
                // 实际上 Opus 可能消耗更多，但下一次心跳会修正它
                currentNode.premiumRemaining = Math.max(0, currentNode.premiumRemaining - 1);
            }

            // 透传响应头和状态码
            reply.code(proxyResponse.status);
            Object.keys(proxyResponse.headers).forEach(key => {
                reply.header(key, proxyResponse.headers[key]);
            });

            // 透传数据流
            return reply.send(proxyResponse.data);

        } catch (error) {
            server.log.warn(`节点 ${currentNode.id} 请求失败: ${error.message}`);

            // 网络错误或其他异常
            currentNode.failureCount++;
            if (currentNode.failureCount >= 3) {
                currentNode.status = 'OFFLINE';
            }

            // 切换到下一个节点
            const nextNode = switchToNextNode(`节点 ${currentNode.id} 发生错误: ${error.message}`);
            if (!nextNode) {
                lastError = error;
                break;
            }

            lastError = error;
        }
    }

    // 所有节点均失败
    server.log.error("所有节点都已耗尽或失败");
    reply.code(503).send({
        error: {
            message: "所有 Copilot 节点的配额都已耗尽或不可用",
            type: "service_unavailable",
            details: lastError ? lastError.message : "节点池耗尽"
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