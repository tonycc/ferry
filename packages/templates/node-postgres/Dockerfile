# 第一步:装全部依赖,做类型检查并编译。类型错误会让构建失败,错误信息里有文件名和行号
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx tsc

# 第二步:只带运行需要的东西
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
CMD ["node", "dist/server.js"]
