/**
 * DeepSeek 注册机 - Cloudflare Email Worker
 *
 * 部署要求：
 *  1. 在 Cloudflare Dashboard 启用 Email Routing，将 *@your-domain.com 路由到本 Worker
 *  2. 创建 KV 命名空间，绑定到本 Worker（变量名 KV_CODES）
 *  3. 在 Worker 环境变量中设置 SHARED_TOKEN（与 config.json 中 api_token 一致）
 *
 * 该 Worker 同时承担两个职责：
 *   - email 事件：接收邮件、解析验证码、写入 KV
 *   - fetch 事件：暴露 HTTP API 给本地注册机查询/清理
 *
 * HTTP API：
 *   GET    /code?email=xxx       —— 查询验证码（命中后立即从 KV 删除）
 *   DELETE /code?email=xxx       —— 主动清理
 *   GET    /healthz              —— 健康检查
 *
 * 所有 /code 路径需要 Authorization: Bearer <SHARED_TOKEN>
 */

const KV_TTL_SECONDS = 60 * 30; // 验证码在 KV 中最多保留 30 分钟

export default {
  /**
   * HTTP 端点：供本地注册机查询/删除验证码
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return json({
        ok: true,
        token_configured: Boolean(env.SHARED_TOKEN),
        kv_bound: Boolean(env.KV_CODES),
        time: Date.now(),
      });
    }

    // 根路径返回部署状态页（便于一键部署后用户检查配置）
    if (url.pathname === "/" || url.pathname === "/setup") {
      return setupPage(env);
    }

    if (url.pathname !== "/code") {
      return new Response("Not Found", { status: 404 });
    }

    if (!env.SHARED_TOKEN) {
      return json(
        {
          error: "SHARED_TOKEN_not_configured",
          hint: "请到 Dashboard → 本 Worker → Settings → Variables and Secrets，添加 Secret 名为 SHARED_TOKEN",
        },
        503,
      );
    }

    const auth = request.headers.get("Authorization") || "";
    const expected = `Bearer ${env.SHARED_TOKEN}`;
    if (auth !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }

    const email = (url.searchParams.get("email") || "").toLowerCase().trim();
    if (!email) {
      return json({ error: "missing email" }, 400);
    }

    if (request.method === "GET") {
      const code = await env.KV_CODES.get(kvKey(email));
      if (!code) {
        return json({ code: null });
      }
      // 命中后立即清理，避免重复消费
      await env.KV_CODES.delete(kvKey(email));
      return json({ code, email });
    }

    if (request.method === "DELETE") {
      await env.KV_CODES.delete(kvKey(email));
      return json({ deleted: true });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },

  /**
   * Email 端点：接收 Cloudflare Email Routing 转发的邮件
   */
  async email(message, env, ctx) {
    try {
      const to = (message.to || "").toLowerCase();
      const from = (message.from || "").toLowerCase();

      // 只处理 DeepSeek 的邮件，其他来源直接丢弃（如有需要可放宽）
      if (!isDeepSeekSender(from)) {
        console.log(`忽略非 DeepSeek 发件人: ${from}`);
        return;
      }

      const raw = await streamToString(message.raw);
      const code = extractVerificationCode(raw);
      if (!code) {
        console.log(`未在邮件中提取到验证码 to=${to} from=${from}`);
        return;
      }

      await env.KV_CODES.put(kvKey(to), code, { expirationTtl: KV_TTL_SECONDS });
      console.log(`已存储验证码 ${code} -> ${to}`);
    } catch (err) {
      console.error("处理邮件失败:", err);
    }
  },
};

// ───────────────────────────────────────────────────────────
// 工具函数
// ───────────────────────────────────────────────────────────

function kvKey(email) {
  return `code:${email}`;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function setupPage(env) {
  const tokenOk = Boolean(env.SHARED_TOKEN);
  const kvOk = Boolean(env.KV_CODES);
  const item = (ok, text) =>
    `<li style="color:${ok ? "#16a34a" : "#dc2626"}">${ok ? "✅" : "❌"} ${text}</li>`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>DeepSeek Mail Worker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1f2937;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px}
ul{padding-left:1.2em}
.box{background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:4px;margin:16px 0}
.ok{background:#dcfce7;border-left-color:#16a34a}
</style></head>
<body>
<h1>DeepSeek Mail Worker</h1>
<p>该 Worker 用于接收 Cloudflare Email Routing 转发的邮件，自动提取验证码并通过 HTTP API 提供给本地注册机。</p>

<h2>当前状态</h2>
<ul>
  ${item(tokenOk, "SHARED_TOKEN Secret 已配置")}
  ${item(kvOk, "KV 命名空间 KV_CODES 已绑定")}
</ul>

${
  tokenOk && kvOk
    ? `<div class="box ok"><strong>✓ Worker 已就绪。</strong>还需要在 Cloudflare Dashboard → 你的域名 → Email → Email Routing → Routes → <strong>Catch-all address</strong>，把 Action 改为 <strong>Send to a Worker</strong> → 选择本 Worker。</div>`
    : `<div class="box"><strong>⚠ 配置未完成</strong>，请按下面步骤补齐。</div>`
}

<h2>剩余配置步骤</h2>
<ol>
${
  !tokenOk
    ? `<li><strong>添加 SHARED_TOKEN Secret</strong>：Dashboard → 本 Worker → Settings → Variables and Secrets → Add → Type 选 <code>Secret</code> → Name <code>SHARED_TOKEN</code> → Value 一段随机字符串</li>`
    : ""
}
${
  !kvOk
    ? `<li><strong>绑定 KV 命名空间</strong>：Dashboard → 本 Worker → Settings → Bindings → Add → KV Namespace → Variable name <code>KV_CODES</code> → 选已有或新建的命名空间</li>`
    : ""
}
<li><strong>配置 Email Routing catch-all</strong>：域名 → Email → Email Routing → Routes → Catch-all address → Send to a Worker → 选本 Worker</li>
</ol>

<h2>HTTP API</h2>
<ul>
  <li><code>GET /healthz</code> — 健康检查（无需鉴权）</li>
  <li><code>GET /code?email=xxx</code> — 查询并消费验证码（需要 <code>Authorization: Bearer &lt;SHARED_TOKEN&gt;</code>）</li>
  <li><code>DELETE /code?email=xxx</code> — 手动清理</li>
</ul>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function isDeepSeekSender(from) {
  if (!from) return false;
  // 已知 DeepSeek 发件域名；如有变化可在此扩展
  return /(deepseek\.com|deepseek\.ai|noreply.*deepseek)/i.test(from);
}

async function streamToString(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let result = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

/**
 * 从原始邮件内容中抽取验证码
 *
 * 优先按以下顺序匹配：
 *   1. 中文"验证码"/英文 "verification code" 附近的 6 位数字
 *   2. quoted-printable 解码后的内容
 *   3. 全文中独立出现的 6 位数字
 */
function extractVerificationCode(raw) {
  if (!raw) return null;

  let text = raw;
  try {
    text = decodeQuotedPrintable(raw);
  } catch (_) {
    /* ignore */
  }

  const patterns = [
    /(?:verification\s*code|verify\s*code|验证码|校验码|code\s*is|您的[^0-9]{0,15})[^0-9]{0,15}(\d{6})/i,
    /\b(\d{6})\b(?=[^0-9]*?(?:verification|verify|deepseek|有效|expire))/i,
    /^\s*(\d{6})\s*$/m,
    /(\d{6})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function decodeQuotedPrintable(input) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}
