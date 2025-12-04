# 使用轻量级 Alpine 镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制依赖定义
COPY package.json .

# 安装生产依赖
RUN npm install --omit=dev

# 复制源码
COPY gateway.js .

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "gateway.js"]