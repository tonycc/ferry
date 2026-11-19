# 第一步:做类型检查并编译服务端代码
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx tsc

# 第二步:只带编译结果和页面文件(这个模板运行时没有依赖)
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
CMD ["node", "dist/server.js"]
