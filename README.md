# deepseek-mail-worker

Cloudflare Email Worker：接收 Email Routing 转发的邮件，自动提取 6 位验证码并通过 HTTP API 提供给本地程序。

本仓库是 [DeepSeek 注册机](https://github.com/) 的配套组件，也可独立用于"任意收件 → 提取验证码 → HTTP 查询"场景。

---

## 🚀 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Eitan-S-23/email-worker)

> 把上面链接里的 `YOUR-USERNAME/YOUR-REPO` 改成**你 fork 或新建后**的仓库路径（例如 `alice/deepseek-mail-worker`），然后点按钮。

### 部署向导会自动做

- ✅ Fork 仓库到你的 GitHub
- ✅ 创建 KV 命名空间并绑定为 `KV_CODES`
- ✅ 读取 `.dev.vars.example`，提示填 `SHARED_TOKEN`
- ✅ 部署 Worker 到 `https://<worker-name>.workers.dev`

### 部署后还要做 1 件事（Cloudflare 平台限制，必须手动）

- Dashboard → 你的域名 → **Email → Email Routing → Routes**
- **Catch-all address** → Action 改为 **Send to a Worker** → 选择刚部署的 Worker → Save

### 检查配置

直接在浏览器打开 Worker URL（`https://<name>.workers.dev/`），会看到**配置状态页**：

- ✅ SHARED_TOKEN Secret 已配置
- ✅ KV 命名空间 KV_CODES 已绑定
- ⏭ Email Routing catch-all（去 Dashboard 配）

---

## 其他部署方式

### 方式 1：Wrangler CLI（本地命令行）

```bash
# 1. 安装 wrangler
npm install -g wrangler
wrangler login

# 2. 创建 KV，把返回的 id 填入 wrangler.toml 的 <KV_NAMESPACE_ID> 位置
wrangler kv namespace create "KV_CODES"

# 3. 设置 Secret
wrangler secret put SHARED_TOKEN
# 提示输入：粘贴一段强随机字符串

# 4. 部署
wrangler deploy

# 5. Dashboard 里配 Email Routing catch-all（同上）
```

### 方式 2：Dashboard 粘贴代码

1. Workers & Pages → Create → Workers → Deploy（先部署默认模板）
2. Edit Code → 粘贴 `worker.js` 全部内容 → Save and Deploy
3. Settings → Bindings → Add → KV Namespace：Variable name `KV_CODES`
4. Settings → Variables and Secrets → Add → Secret：`SHARED_TOKEN`
5. Email Routing 配 catch-all

---

## HTTP API

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` 或 `/setup` | 否 | 配置状态页（HTML） |
| GET | `/healthz` | 否 | 健康检查（JSON，含 token/KV 配置状态） |
| GET | `/code?email=xxx` | `Authorization: Bearer <SHARED_TOKEN>` | 查询验证码（命中后自动从 KV 删除） |
| DELETE | `/code?email=xxx` | 同上 | 手动清理 |

### 用法示例

```bash
# 健康检查
curl https://<your-worker>.workers.dev/healthz
# {"ok":true,"token_configured":true,"kv_bound":true,"time":...}

# 取验证码
curl -H "Authorization: Bearer <SHARED_TOKEN>" \
     "https://<your-worker>.workers.dev/code?email=test@your-domain.com"
# {"code":"123456","email":"test@your-domain.com"}
```

---

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `worker.js` | Worker 主代码（fetch + email 双处理器） |
| `wrangler.toml` | Wrangler 配置；KV ID 用占位符，一键部署时自动回填 |
| `.dev.vars.example` | 声明需要的 Secret（仅 `SHARED_TOKEN`），供部署向导识别 |
| `.gitignore` | 忽略本地 wrangler 缓存、真实 `.dev.vars` 等 |

---

## 验证码提取逻辑

`extractVerificationCode(raw)` 按以下顺序匹配：

1. "验证码"/"verification code" 关键字附近的 6 位数字
2. 6 位数字后紧跟 "verification" / "deepseek" / "有效" 等
3. 单独成行的 6 位数字
4. 全文首个 6 位数字

如果 DeepSeek 邮件格式变更导致提取失败，在 Worker 日志（Dashboard → Logs）观察原始邮件后调整 `patterns` 数组。

## 发件人过滤

`isDeepSeekSender()` 默认只接受 deepseek 域名的来信。调试时可在 Worker 编辑器里临时改成 `return true;`。

## 配置项

| 常量 / 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KV_TTL_SECONDS` | `1800` | 验证码在 KV 中的过期时间（秒），30 分钟 |
| `SHARED_TOKEN` | （Secret） | 本地程序访问 `/code` 时的 Bearer Token |
| `KV_CODES` | （KV binding） | 存储 `code:<email> -> verification_code` 的命名空间 |

---

## 安全建议

- `SHARED_TOKEN` 用 `python -c "import secrets;print(secrets.token_hex(32))"` 或 `openssl rand -hex 32` 生成
- 一旦 `SHARED_TOKEN` 泄露，任何人都能读取你域名收到的验证码 → 立即在 Dashboard 改并 Deploy
- 担心 Worker URL 被扫到，可加 WAF 规则限制 IP 来源
- KV 中验证码 30 分钟自动过期；本地程序取后立即删除

---

## 拆除部署

1. Email Routing → Routes → Catch-all → 改回原来的转发邮箱或禁用
2. Workers & Pages → 本 Worker → Manage → **Delete**
3. KV → `KV_CODES` → **Delete**

---

## 许可

MIT
