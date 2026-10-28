# 造物 Creature 后端镜像（构建上下文为仓库根目录）
#   docker build -f apps/server/Dockerfile -t creature-server .
# 基础镜像可通过 --build-arg NODE_IMAGE=... 换成内网或镜像站地址
# 需要通过带自签 CA 的代理访问 npm 时：--secret id=npm_ca,src=ca.crt（并传入 HTTPS_PROXY 构建参数）
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci -w @creature/shared -w @creature/server --include-workspace-root --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build -w @creature/shared && npm run build -w @creature/server

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/data/files
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# 只安装运行时依赖
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev -w @creature/shared -w @creature/server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/migrations apps/server/migrations
# 文件存储目录（生产环境换成对象存储前，挂载持久卷）
RUN mkdir -p /data/files && chown node:node /data/files
USER node
WORKDIR /app/apps/server
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/v1/healthz >/dev/null || exit 1
CMD ["node", "dist/main.js"]
