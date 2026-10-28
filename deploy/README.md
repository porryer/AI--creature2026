# staging 环境

一条命令启动接近生产形态的环境：PostgreSQL 16 + 后端（`APP_ENV=staging`）+ 用户端（nginx 提供静态文件并把 `/v1` 反向代理到后端）。

```bash
cd deploy
cp .env.example .env
# 按 .env 中的说明填写密钥：openssl rand -hex 32
docker compose up -d --build
# 打开 http://localhost:8080
```

- **staging 模式**：密钥与 `DATABASE_URL` 按生产要求校验（缺少时拒绝启动），但允许 Mock 的短信（验证码随响应返回）、模拟支付与 Mock 模型，启动日志会给出警告。**不要对外开放**；接入真实短信、支付与模型供应商后改用生产配置。
- **管理员**：在 `.env` 的 `ADMIN_PHONES` 中填写手机号，用该号码登录后可进入管理后台。
- **数据**：数据库与文件分别保存在 `db-data`、`files` 两个卷中，`docker compose down` 不会删除；加 `-v` 会清空。
- **指标**：`curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:8080/v1/metrics`（Prometheus 文本格式，指标说明见 [docs/09-launch-readiness.md](../docs/09-launch-readiness.md)）。
- **访问 Docker Hub 受限**：在 `.env` 中把 `NODE_IMAGE`、`NGINX_IMAGE`、`POSTGRES_IMAGE` 换成镜像站地址；通过带自签证书的代理访问 npm 时，单独构建镜像并传入 CA：

  ```bash
  docker build --network host --build-arg HTTPS_PROXY=$HTTPS_PROXY \
    --secret id=npm_ca,src=/path/to/ca.crt -f apps/server/Dockerfile -t creature-server:staging .
  ```

## 压测

```bash
# 提交接口压测前在 .env 中调高按用户限流：GENERATION_RATE_PER_MIN、MAX_INFLIGHT_TASKS
LOADTEST_ADMIN_PHONE=<ADMIN_PHONES 中的号码> node scripts/loadtest.mjs --base http://localhost:8080 --scenario submit --users 200 --concurrency 100 --duration 30
node scripts/loadtest.mjs --base http://localhost:8080 --scenario read --users 50 --concurrency 100 --duration 30
```

压测结束后脚本会以管理员身份触发一次全量对账，发现不一致时以非零状态退出。

## 横向扩展

`docker compose up -d --scale server=2` 后重启 `web`（nginx 只在启动时解析后端地址，扩缩容后需要重启才能看到新实例；同一实例重启不需要）。

多个后端实例共用同一个 PostgreSQL 即可，不需要额外组件：

- 生成任务以数据库为队列、`FOR UPDATE SKIP LOCKED` 认领，各实例的 Worker 同时处理；
- 推送通过 PostgreSQL `LISTEN / NOTIFY` 在实例之间转发，用户的推送连接与处理任务的实例可以不同；
- 冻结 / 封禁账号会通知所有实例立即失效；提交限流按数据库计数，各实例共享同一个额度；
- 启动时的数据库迁移持有咨询锁，多个实例同时启动不会冲突。

注意：每个实例会占用一条常驻的数据库连接用于 `LISTEN`。如果在后端与数据库之间加 PgBouncer，这条连接必须走 session 模式（transaction 模式不支持 `LISTEN`）。多个环境共用一个数据库时，用 `EVENTS_CHANNEL` 区分通知频道。验证方法与压测结果见 [docs/09-launch-readiness.md](../docs/09-launch-readiness.md#7-多实例部署)。
