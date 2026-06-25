# Maton 登录助手 - Vercel 版

## 架构（无需 Cron）
- **前端轮询** `/api/wait-link` 每 3 秒一次
- **后端按需扫描** — 发现有等待中的请求时，当场连 IMAP 查邮件
- **Upstash Redis** — 存储登录等待状态和预提取链接
- **零 Cron 依赖**，延迟 ~3 秒，跟本地版一样快

## 部署步骤

### 1. 创建 Upstash Redis（免费）
1. 登录 https://console.upstash.com（GitHub 登录）
2. 创建 Redis 数据库（免费 10K req/day）
3. 记下 `REST URL` 和 `REST Token`

### 2. 部署到 Vercel
```bash
cd maton-login-vercel
npm install
vercel
```

### 3. 配置环境变量
Vercel Dashboard → Settings → Environment Variables：

| 变量 | 值 |
|------|-----|
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST Token |
| `MAIL_IMAP_HOST` | mail.seek.li |
| `MAIL_USER` | cloudns@seek.li |
| `MAIL_PASSWORD` | IMAP 密码 |
| `DEFAULT_DOMAIN` | iosos.cloudns.biz |
| `MATON_BASE_URL` | https://www.maton.ai |
| `MATON_CALLBACK_BASE_URL` | https://maton.ai |

## API 端点
- `POST /api/send-login-email` — 请求 Maton 发送登录邮件
- `GET /api/wait-link?email=xxx` — 轮询等待链接（**触发 IMAP 扫描**）
- `GET /api/random-alias` — 生成随机邮箱
- `POST /api/extract-link` — 手动提取链接
- `GET /api/debug` — 调试状态

## 流程
1. 前端点"请求发邮件" → 后端调 Maton API 发登录邮件，存 wait 到 Redis
2. 前端每 3 秒轮询 `/api/wait-link`
3. 后端发现有 wait 但没 link → 立即连 IMAP 查最新邮件 → 匹配到就存 earlyLink
4. 下次轮询拿到 link → 前端自动跳转

## 对比
| | 本地版 | Vercel 版 |
|---|---|---|
| 延迟 | ~2 秒 | ~3 秒 |
| 内存 | 42MB | 0 |
| 可用性 | 开机才有 | 7×24 |
| Cron | 不需要 | 不需要 |
| 费用 | 0 | 0 |

## 注意
- Vercel 免费版函数最长 10 秒，IMAP 短查询通常 2-3 秒够用
- 设置了 `maxDuration: 30` 以防 IMAP 慢
- Upstash 免费版 10K req/day，每次登录约消耗 5-10 个请求
