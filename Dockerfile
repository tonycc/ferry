# syntax=docker/dockerfile:1
#
# Ferry 发布服务的镜像(任务 3.6):发布服务、构建好的控制台、应用模板、固定版本的 gitleaks。
# 部署方法见 deploy/README.md。在仓库根目录构建:
#   docker build -t ferry:<版本> .
# 给 amd64 服务器构建(本机是 Apple 芯片时):
#   docker buildx build --platform linux/amd64 -t ferry:<版本> .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 依赖和控制台构建 ----
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/publisher/package.json apps/publisher/
COPY apps/console/package.json apps/console/
COPY packages/manifest/package.json packages/manifest/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @ferry/console build

# 只装运行需要的依赖(发布服务用 tsx 直接运行 TypeScript)
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# ---- gitleaks:按目标架构下载固定版本,校验文件 ----
FROM debian:bookworm-slim AS gitleaks
ARG TARGETARCH
ARG GITLEAKS_VERSION=8.30.1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x64;   sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      arm64) arch=arm64; sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      *) echo "不支持的架构 $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -sSfL -o /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz"; \
    echo "$sum  /tmp/gitleaks.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
    gitleaks version

# ---- 运行镜像 ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ARCHIVE_DIR=/data/archives
WORKDIR /app
COPY --from=gitleaks /usr/local/bin/gitleaks /usr/local/bin/gitleaks
# 运行时的目录结构和仓库一样:发布服务按相对路径找控制台、模板和数据库迁移
COPY --from=prod-deps /app /app
COPY --from=build /app/apps/publisher/src apps/publisher/src
COPY --from=build /app/apps/publisher/drizzle apps/publisher/drizzle
COPY --from=build /app/apps/publisher/tsconfig.json apps/publisher/tsconfig.json
COPY --from=build /app/apps/console/dist apps/console/dist
COPY --from=build /app/packages/manifest/src packages/manifest/src
COPY --from=build /app/packages/templates packages/templates
COPY --from=build /app/tsconfig.base.json tsconfig.base.json
# 代码包目录:命名卷第一次挂上来时沿用这里的属主,不然第一次上传就没有写权限
RUN mkdir -p /data/archives && chown -R node:node /data
USER node
WORKDIR /app/apps/publisher
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/main.ts"]
