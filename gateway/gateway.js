/**
 * Copilot Smart Gateway
 *
 * 功能：多节点配额管理、主动轮询、自动故障转移
 * 作者：Domain Expert
 */

const Fastify = require('fastify');
const axios = require('axios');

// --- 配置区域 ---
// 方式1：COPILOT_NODES 环境变量（JSON）- 完整控制每个节点
// 方式2：自动探测模式 - 尝试连接 copilot-node-1, copilot-node-2... 直到连不上
const MAX_NODE_PROBE = 20; // 最多探测20个节点

async function discoverNodes() {
    if (process.env.COPILOT_NODES) {
        const nodes = JSON.parse(process.env.COPILOT_NODES);
        console.log(`[显式配置] 加载 ${nodes.length} 个节点`);
        return nodes;
    }

    console.log('[自动探测] 开始发现节点...');
    const nodes = [];
    let consecutiveNotFound = 0; // 连续未找到计数

    for (let i = 1; i <= MAX_NODE_PROBE; i++) {
        const url = `http://copilot-node-${i}:4141`;
        try {
            await axios.get(url, { timeout: 2000 });
            nodes.push({ url, token: '' });
            console.log(`[自动探测] 发现节点 ${i}: ${url}`);
            consecutiveNotFound = 0; // 重置计数
        } catch (error) {
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                consecutiveNotFound++;
                console.log(`[自动探测] 节点 ${i} 不存在，跳过`);
                // 连续3个节点不存在才停止探测
                if (consecutiveNotFound >= 3) {
                    console.log(`[自动探测] 连续 ${consecutiveNotFound} 个节点不存在，停止探测`);
                    break;
                }
                continue;
            }
            // 其他错误（如超时、HTTP错误）说明节点存在但可能有问题，继续添加
            nodes.push({ url, token: '' });
            console.log(`[自动探测] 发现节点 ${i}: ${url} (响应异常: ${error.code || error.message})`);
            consecutiveNotFound = 0;
        }
    }

    console.log(`[自动探测] 共发现 ${nodes.length} 个节点`);
    return nodes;
}

// 初始为空，启动时填充
let NODES_CONFIG = [];
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 5 * 60 * 1000; // 从环境变量读取，默认5分钟
const HEALTH_CHECK_TIMEOUT = 5000; // 健康检查超时时间（毫秒）
const REQUEST_TIMEOUT = 30000; // 代理请求超时时间（毫秒）

// --- 全局状态注册表 ---
// 初始为空，启动时填充
let nodeRegistry = [];

// 当前活跃节点索引（主备模式的关键）
let activeNodeIndex = 0;

const server = Fastify({
    logger: true,
    connectionTimeout: 60000 // 设置较长的超时以适应 LLM 生成时间
});

// --- 核心功能函数 ---

/**
 * 检查节点是否可达（快速健康检查）
 * 通过 /usage 端点判断节点是否在线
 * @param {Object} node 节点对象
 * @returns {boolean} 节点是否可达
 */
async function checkNodeReachable(node) {
    try {
        await axios.get(`${node.url}/usage`, {
            headers: { 'Authorization': `Bearer ${node.token}` },
            timeout: HEALTH_CHECK_TIMEOUT
        });
        return true;
    } catch (error) {
        // 网络错误（ECONNREFUSED, ETIMEDOUT 等）表示节点不可达
        if (error.code === 'ECONNREFUSED' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'ENOTFOUND' ||
            error.code === 'ECONNRESET' ||
            error.code === 'EHOSTUNREACH') {
            return false;
        }
        // HTTP 错误（如 401, 403, 500）表示节点可达但可能有其他问题
        // 但节点本身是在线的
        if (error.response) {
            return true;
        }
        return false;
    }
}

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
            timeout: HEALTH_CHECK_TIMEOUT
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
        node.consecutiveFailures = 0; // 重置连续失败计数
        node.lastHealthy = Date.now();

        if (remaining > 0) {
            node.status = 'READY';
            server.log.info(`Node ${node.id} is READY. Premium Quota: ${remaining}`);
        } else {
            node.status = 'DRAINED';
            server.log.warn(`Node ${node.id} is DRAINED. Premium Quota: 0`);
        }

    } catch (error) {
        node.failureCount++;
        node.consecutiveFailures++;
        server.log.error(`Node ${node.id} sync failed: ${error.message}`);

        // 区分错误类型
        if (error.code === 'ECONNREFUSED' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'ENOTFOUND' ||
            error.code === 'ECONNRESET' ||
            error.code === 'EHOSTUNREACH') {
            // 网络层错误，节点不可达
            node.status = 'OFFLINE';
            server.log.warn(`Node ${node.id} is OFFLINE (network error: ${error.code})`);
        } else if (error.response && error.response.status === 401) {
            node.status = 'INVALID_TOKEN'; // Token 失效，无需重试
        } else if (error.response && error.response.status === 429) {
            node.status = 'RATE_LIMITED'; // 暂时被 GitHub 限流
        } else if (error.response) {
            // 有 HTTP 响应但是其他错误，节点在线但可能有问题
            // 保持当前状态，不立即标记为 OFFLINE
            server.log.warn(`Node ${node.id} returned HTTP ${error.response.status}`);
        } else {
            node.status = 'OFFLINE'; // 其他未知网络错误
        }
    }
}

/**
 * 判断节点是否可用于请求
 * @param {Object} node 节点对象
 * @returns {boolean} 节点是否可用
 */
function isNodeAvailable(node) {
    // 节点必须是 READY 状态且有配额
    if (node.status !== 'READY') {
        return false;
    }
    if (node.premiumRemaining <= 0) {
        return false;
    }
    // 如果连续失败超过 2 次，暂时不使用该节点
    if (node.consecutiveFailures >= 2) {
        return false;
    }
    return true;
}

/**
 * 调度器：启动后台轮询
 */
function startScheduler() {
    // 1. 立即执行一次全量扫描
    server.log.info("Starting initial quota sweep...");
    Promise.all(nodeRegistry.map(syncNodeQuota));

    // 2. 设置定时器 - 常规配额检查
    setInterval(() => {
        server.log.info("Running periodic quota sweep...");
        // 仅检查非永久失效的节点（INVALID_TOKEN 除外）
        const activeNodes = nodeRegistry.filter(n => n.status !== 'INVALID_TOKEN');
        activeNodes.forEach(syncNodeQuota);
    }, POLL_INTERVAL);

    // 3. 设置定时器 - 离线节点恢复检查（每30秒检查一次）
    const RECOVERY_INTERVAL = 30000; // 30秒
    setInterval(async () => {
        const offlineNodes = nodeRegistry.filter(n => n.status === 'OFFLINE');
        if (offlineNodes.length > 0) {
            server.log.info(`检查 ${offlineNodes.length} 个离线节点是否恢复...`);
            for (const node of offlineNodes) {
                const reachable = await checkNodeReachable(node);
                if (reachable) {
                    server.log.info(`节点 ${node.id} 已恢复在线，重新检查配额...`);
                    node.consecutiveFailures = 0;
                    await syncNodeQuota(node);
                }
            }
        }
    }, RECOVERY_INTERVAL);
}

/**
 * 获取当前活跃节点（主备模式，反向调度）
 * 返回当前应该使用的节点，如果不活跃则尝试切换到下一个可用节点
 * 优先选择索引较大的节点（从末尾开始）
 */
function getActiveNode() {
    // 如果当前活跃节点可用，直接返回
    if (nodeRegistry[activeNodeIndex] && isNodeAvailable(nodeRegistry[activeNodeIndex])) {
        return nodeRegistry[activeNodeIndex];
    }

    // 当前节点不可用，从后往前查找可用节点
    // 从最后一个节点开始，向下查找
    for (let i = nodeRegistry.length - 1; i >= 0; i--) {
        const node = nodeRegistry[i];
        if (node && isNodeAvailable(node)) {
            activeNodeIndex = i; // 更新活跃节点索引
            server.log.info(`切换到活跃节点: ${node.id} (索引: ${i})`);
            return node;
        }
    }

    return null; // 没有可用节点
}

/**
 * 切换到下一个节点（故障转移，反向调度）
 * @param {Object} failedNode - 失败的节点（可选）
 * @param {string} reason - 切换原因
 */
async function switchToNextNode(failedNode, reason) {
    const originalIndex = activeNodeIndex;

    // 如果传入了失败的节点，增加其失败计数
    if (failedNode) {
        failedNode.consecutiveFailures++;
        server.log.info(`节点 ${failedNode.id} 连续失败次数: ${failedNode.consecutiveFailures}`);
    }

    // 从后往前寻找下一个可用节点（优先选择索引更大的节点）
    // 先尝试当前节点之前的节点
    for (let i = originalIndex - 1; i >= 0; i--) {
        const node = nodeRegistry[i];
        if (node && node.status !== 'INVALID_TOKEN' && node.status !== 'OFFLINE') {
            // 快速检查节点是否可达
            const reachable = await checkNodeReachable(node);
            if (reachable) {
                activeNodeIndex = i;
                server.log.info(`故障转移: ${reason}`);
                server.log.info(`从节点 ${originalIndex} 切换到节点 ${i} (${node.id})`);

                // 立即检查新节点的状态
                await syncNodeQuota(node);
                if (isNodeAvailable(node)) {
                    return node;
                }
            } else {
                node.status = 'OFFLINE';
                server.log.warn(`节点 ${node.id} 不可达，标记为 OFFLINE`);
            }
        }
    }

    // 如果前面的节点都不可用，再从最后一个节点开始查找
    for (let i = nodeRegistry.length - 1; i > originalIndex; i--) {
        const node = nodeRegistry[i];
        if (node && node.status !== 'INVALID_TOKEN' && node.status !== 'OFFLINE') {
            // 快速检查节点是否可达
            const reachable = await checkNodeReachable(node);
            if (reachable) {
                activeNodeIndex = i;
                server.log.info(`故障转移: ${reason}`);
                server.log.info(`从节点 ${originalIndex} 切换到节点 ${i} (${node.id})`);

                // 立即检查新节点的状态
                await syncNodeQuota(node);
                if (isNodeAvailable(node)) {
                    return node;
                }
            } else {
                node.status = 'OFFLINE';
                server.log.warn(`节点 ${node.id} 不可达，标记为 OFFLINE`);
            }
        }
    }

    server.log.error('所有节点都不可用');
    return null;
}

// --- 路由定义 ---

// 健康检查
server.get('/health', async () => {
    const activeNode = nodeRegistry[activeNodeIndex];
    const availableNodes = nodeRegistry.filter(n => isNodeAvailable(n));
    return {
        status: availableNodes.length > 0 ? 'ok' : 'degraded',
        activeNodeIndex,
        activeNodeId: activeNode ? activeNode.id : null,
        mode: 'active-standby', // 标识当前模式
        availableNodeCount: availableNodes.length,
        totalNodeCount: nodeRegistry.length,
        nodes: nodeRegistry.map(n => ({
            id: n.id,
            status: n.status,
            quota: n.premiumRemaining,
            isActive: n.id === (activeNode ? activeNode.id : null),
            consecutiveFailures: n.consecutiveFailures,
            lastCheck: n.lastCheck ? new Date(n.lastCheck).toISOString() : null,
            lastHealthy: n.lastHealthy ? new Date(n.lastHealthy).toISOString() : null
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
    const triedNodes = new Set(); // 记录已尝试过的节点，避免重复

    // 主备模式：始终从当前活跃节点开始
    while (attempts < nodeRegistry.length) {
        currentNode = getActiveNode();

        if (!currentNode) {
            server.log.error("没有可用的活跃节点");
            break;
        }

        // 避免重复尝试同一个节点
        if (triedNodes.has(currentNode.id)) {
            server.log.warn(`节点 ${currentNode.id} 已尝试过，跳过`);
            // 标记为不可用，强制 getActiveNode 选择其他节点
            currentNode.consecutiveFailures = 999;
            continue;
        }
        triedNodes.add(currentNode.id);

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
                timeout: REQUEST_TIMEOUT, // 添加超时
                validateStatus: () => true // 允许所有状态码通过，手动处理
            });

            // 请求成功到达节点，重置连续失败计数
            currentNode.consecutiveFailures = 0;
            currentNode.lastHealthy = Date.now();

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
                const nextNode = await switchToNextNode(null, `节点 ${currentNode.id} 配额耗尽`);
                if (!nextNode) {
                    lastError = new Error('所有节点配额都已耗尽');
                    break;
                }

                // 继续下一次尝试
                continue;
            }

            // 404 不是节点故障，正常透传给客户端
            // 这可能是请求了不存在的模型或端点
            if (proxyResponse.status === 404) {
                server.log.info(`节点 ${currentNode.id} 返回 404，正常透传`);
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
            server.log.warn(`节点 ${currentNode.id} 请求失败: ${error.message} (code: ${error.code})`);

            // 区分网络错误和其他错误
            const isNetworkError = error.code === 'ECONNREFUSED' ||
                                   error.code === 'ETIMEDOUT' ||
                                   error.code === 'ENOTFOUND' ||
                                   error.code === 'ECONNRESET' ||
                                   error.code === 'EHOSTUNREACH' ||
                                   error.code === 'ECONNABORTED';

            if (isNetworkError) {
                // 网络错误，节点不可达，立即标记为 OFFLINE
                currentNode.status = 'OFFLINE';
                currentNode.consecutiveFailures++;
                server.log.error(`节点 ${currentNode.id} 网络不可达，标记为 OFFLINE`);
            } else {
                // 其他错误（如超时），增加失败计数
                currentNode.failureCount++;
                currentNode.consecutiveFailures++;
                if (currentNode.consecutiveFailures >= 3) {
                    currentNode.status = 'OFFLINE';
                }
            }

            // 切换到下一个节点
            const nextNode = await switchToNextNode(null, `节点 ${currentNode.id} 发生错误: ${error.message}`);
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
        // 先发现节点
        NODES_CONFIG = await discoverNodes();

        // 初始化节点注册表
        nodeRegistry = NODES_CONFIG.map((node, index) => ({
            id: `node-${index + 1}`,
            url: node.url,
            token: node.token,
            status: 'UNKNOWN',
            premiumRemaining: 0,
            lastCheck: 0,
            failureCount: 0,
            consecutiveFailures: 0,
            lastHealthy: 0
        }));

        // 设置活跃节点索引（反向调度，从最后一个开始）
        activeNodeIndex = nodeRegistry.length > 0 ? nodeRegistry.length - 1 : 0;

        if (nodeRegistry.length === 0) {
            console.error('[错误] 未发现任何可用节点，网关将以降级模式运行');
        }

        await server.listen({ port: PORT, host: '0.0.0.0' });
        startScheduler();
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();