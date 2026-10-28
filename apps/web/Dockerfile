# 造物 Creature 用户端镜像：构建接入后端的版本，由 nginx 提供静态文件并把 /v1 反向代理到后端
#   docker build -f apps/web/Dockerfile -t creature-web .
# 需要通过带自签 CA 的代理访问 npm 时：--secret id=npm_ca,src=ca.crt（并传入 HTTPS_PROXY 构建参数）
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci -w @creature/shared -w @creature/web --include-workspace-root --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @creature/web

FROM ${NGINX_IMAGE}
# 后端地址：容器启动时由 nginx 官方镜像的模板机制替换
ENV API_UPSTREAM=http://server:3000
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
