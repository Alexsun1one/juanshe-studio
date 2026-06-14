# 卷舍 SaaS · 托管部署(P0-3 · 单实例 MVP)

把卷舍从"本地单机"跑成"托管多租户网页版":用户开浏览器 → 邮箱密码注册 → 免码即写(轻档)→ 输 Pro/Ultra 升级码解锁中/重档。复用 `nextapi-vps`(与发卡服务 `/opt/juanshe-activation` 共机)。

> **状态诚实交代**:本机没有 docker,以下 Dockerfile/compose **没做过本地 `docker build` 验证**。但应用本身的生产产物(Next standalone web + studio dist api)已在本地以 **prod node 进程 + `HARDWRITE_SAAS_MODE=1`** 烟测通过——**浏览器→web→api 三跳 cookie、注册→会话→只见自己的书→无 cookie 401** 全过。容器只是把同一产物装进 `node:22`。**首次 `docker compose build` 必须在 VPS 上按本文第 4 节逐步验证。**

---

## 1. 拓扑

```
浏览器 ──HTTPS──> nginx(TLS) ──> web(Next standalone :3100) ──/api──> api(studio :4569) ──> 各租户 /data/.saas/tenants/<tid>/
```
- 隔离全部 gated 在 `HARDWRITE_SAAS_MODE=1`;不设这个 = 退回桌面单机行为。
- 每租户:书稿/大纲/记忆/故事图谱(sqlite)/BYOK 密钥 物理隔离到独立目录,互不可见(P0-1 内核)。

## 2. ⚠️ 上线前 checklist(逐条核对,踩一条全盘崩)

1. **平台工作区的 LLM key 必须留空**。`/data/hardwrite.json` 的 `llm.apiKey` 若有真 key,会被 `ensureTenantWorkspace` 复制进每个租户 → 全员共用你的 key 烧你的钱。**留空,强制租户 BYOK**(经各自 secrets.json)。
2. **`HARDWRITE_ACTIVATION_SECRET` 与发卡服务逐字一致**(`/opt/juanshe-activation/.env` 里那把),否则用户 Pro/Ultra 码在 SaaS 这边验不过。
3. **`HARDWRITE_COOKIE_SECURE=1` + 全程 HTTPS**(compose 已设)。HTTP 下 Secure cookie 不回传 = 登录形同虚设。
4. **端口/域名不撞发卡服务**:`api.nextapi.top` 已占宿主 80/443。见第 3 节——**共机别用 compose 自带 nginx,挂到宿主 nginx**。
5. `HARDWRITE_SAAS_MAX_BATCH_CHAPTERS`(默认 20)按机器算力调;共机务必留着这道墙,否则一个用户挂机连写吃满 CPU 连发卡服务一起拖垮。
6. `deploy/.env` 与 `deploy/certs/` **不入库**(已在 .gitignore)。

## 3. 共机部署(推荐:挂宿主 nginx,不用 compose nginx)

`nextapi-vps` 已有宿主 nginx 在跑 `api.nextapi.top`。**注释掉 compose 里的 `nginx` 服务**,让 web 只在内网暴露,由宿主 nginx 加一个 server block 反代:

```nginx
# 宿主 /etc/nginx/sites-available/juanshe-saas.conf — 新子域,如 app.nextapi.top
server {
    listen 443 ssl;
    server_name app.nextapi.top;             # ← 你的 SaaS 子域
    ssl_certificate     /etc/letsencrypt/live/app.nextapi.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.nextapi.top/privkey.pem;
    client_max_body_size 20m;
    location /api/ {                          # SSE 命门:关缓冲 + 长超时
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1; proxy_set_header Host $host;
        proxy_buffering off; proxy_cache off; proxy_read_timeout 1800s;
        chunked_transfer_encoding on;
    }
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1; proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
配套:compose 的 `web` 服务把 `expose: ["3100"]` 改成 `ports: ["127.0.0.1:3100:3100"]`(只绑回环,宿主 nginx 可达、外网不可达)。

> 干净独立机器才用 compose 自带 nginx + `deploy/certs/`(放 fullchain.pem/privkey.pem)。

## 4. 部署步骤

```bash
# 0. 上传代码到 VPS(私有库 juanshe-studio)
git clone <repo> /opt/juanshe-saas && cd /opt/juanshe-saas

# 1. 配 env
cp deploy/.env.example deploy/.env && vim deploy/.env   # 填 ACTIVATION_SECRET(与发卡服务一致)

# 2. 平台工作区(key 留空!)
docker volume create juanshe-saas-data
docker run --rm -v juanshe-saas-data:/data node:22-slim \
  sh -c 'printf "{\"name\":\"juanshe-saas\",\"language\":\"zh\",\"llm\":{\"provider\":\"openai\",\"baseUrl\":\"\",\"apiKey\":\"\",\"model\":\"\"},\"notify\":[]}" > /data/hardwrite.json'

# 3. 构建 + 起(共机已注释 nginx 服务)
cd deploy && docker compose build        # ← 首次在这验证 build 能过(本地没验过)
docker compose up -d api web

# 4. 首跑自检(对照本地烟测,务必全绿)
curl -s localhost:3100/api/v1/auth/me                  # 期望 {"saas":true,"authenticated":false}
curl -s -D- -X POST localhost:3100/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"a@t.test","password":"password-aa"}'   # 期望 200 + Set-Cookie hardwrite_saas_session
# 再注册 b@t.test,各自带 cookie 打 /api/v1/books → 只见自己的(空),互不可见 = 隔离 OK
curl -s -o/dev/null -w '%{http_code}\n' localhost:3100/api/v1/books/x/chapters  # 无 cookie 期望 401

# 5. 宿主 nginx 子域(第 3 节)+ certbot 签证 + reload nginx

# 6. 每日备份 cron
crontab -e   # 加: 0 4 * * * /opt/juanshe-saas/deploy/scripts/backup-saas.sh >> /var/log/juanshe-backup.log 2>&1
```

## 5. 引流闭环接上(部署成功后)

公众号「领码」自动回复改成:发 **SaaS 访问链接(app.nextapi.top)+ 一个限时 Pro 体验码**。用户开链接免码注册即写,Pro 码升级 —— 门槛归零。发卡服务铸限时 Pro 码的逻辑在 `/opt/juanshe-activation`(VPS,独立改)。

## 6. 已知 followup(非阻断,记在案)

- `/api/v1/engine/*` 直写路由已计费+租户隔离,但未进"每租户并发墙"(主流程 `write-batch` 已 walled)。
- tier→写作强度限档(轻/中/重)未接 per-user(目前 SaaS Pro 用户拿到的是 credits+免扣,强度档仍读平台全局激活);如需按等级限档,write-batch 改读 `saasUser.tier`。
- 密码重置/邮箱验证邮件链路(P1);saas.json→数据库(P1);水平扩展/分布式锁(P2)。
- `max-duration` 触发后批次标 needs-repair,前端需给"继续"入口(P1 前端适配)。
