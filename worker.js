// @ts-nocheck
/**
 * DeepSeek 注册机 - Cloudflare Email Worker
 *
 * 部署要求：
 *  1. 在 Cloudflare Dashboard 启用 Email Routing，将 *@your-domain.com 路由到本 Worker
 *  2. 创建 KV 命名空间，绑定到本 Worker（变量名 KV_CODES）
 *  3. 在 Worker 环境变量中设置 SHARED_TOKEN（与 config.json 中 api_token 一致）
 *
 * 该 Worker 同时承担两个职责：
 *   - email 事件：接收邮件、解析验证码、写入 KV，并保留原始邮件供在线查看
 *   - fetch 事件：暴露 HTTP API（验证码查询 + 邮件查看）
 *
 * HTTP API：
 *   GET    /healthz              —— 健康检查（无鉴权）
 *   GET    /code?email=xxx       —— 查询验证码（命中后立即从 KV 删除）
 *   DELETE /code?email=xxx       —— 主动清理验证码
 *   GET    /mails                —— 邮件列表（HTML，默认）
 *   GET    /mails?format=json    —— 邮件列表（JSON）
 *   GET    /mails?id=xxx         —— 单封邮件详情（HTML）
 *   GET    /mails?id=xxx&format=raw   —— 单封原文（纯文本）
 *   GET    /mails?id=xxx&format=json  —— 单封 JSON（含 metadata + raw）
 *   DELETE /mails?id=xxx         —— 删除单封邮件
 *   DELETE /mails                —— 清空所有邮件
 *   其余路径一律返回 404（不暴露任何信息）
 *
 * 鉴权方式（任选其一，/code 与 /mails 均需）：
 *   - Header：Authorization: Bearer <SHARED_TOKEN>
 *   - URL：  ?token=<SHARED_TOKEN>（便于浏览器直接打开 /mails）
 */

const KV_TTL_SECONDS = 60 * 30;              // 验证码在 KV 中最多保留 30 分钟
const MAIL_TTL_SECONDS = 60 * 60 * 24 * 7;   // 邮件原文保留 7 天
const MAIL_LIST_LIMIT = 100;                  // 列表最多展示 100 封
const MAIL_BODY_LIMIT = 256 * 1024;           // 单封原文最多存 256KB

export default {
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

    if (url.pathname === "/code") {
      return handleCodeRequest(request, url, env);
    }

    if (url.pathname === "/mails") {
      return handleMailsRequest(request, url, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async email(message, env, ctx) {
    try {
      const to = (message.to || "").toLowerCase();
      const from = (message.from || "").toLowerCase();
      const subject = readHeader(message, "subject");
      const receivedAt = Date.now();
      const raw = await streamToString(message.raw);

      // 1. 全部邮件落到 KV，便于在 Worker 上查看（不区分发件人）
      if (env.KV_CODES) {
        const id = mailId(receivedAt);
        const body =
          raw.length > MAIL_BODY_LIMIT
            ? raw.slice(0, MAIL_BODY_LIMIT) +
              `\n... [已截断 ${raw.length - MAIL_BODY_LIMIT} 字节]`
            : raw;
        await env.KV_CODES.put(`mail:${id}`, body, {
          expirationTtl: MAIL_TTL_SECONDS,
          metadata: {
            from,
            to,
            subject: clip(subject, 200),
            received_at: receivedAt,
            size: raw.length,
          },
        });
        console.log(
          `已存储邮件 id=${id} from=${from} to=${to} subject=${subject}`,
        );
      }

      // 2. 仅 DeepSeek 邮件继续提取验证码
      if (!isDeepSeekSender(from)) {
        console.log(`非 DeepSeek 发件人，跳过验证码提取: ${from}`);
        return;
      }

      const code = extractVerificationCode(raw);
      if (!code) {
        console.log(`未在邮件中提取到验证码 to=${to} from=${from}`);
        return;
      }

      await env.KV_CODES.put(kvKey(to), code, {
        expirationTtl: KV_TTL_SECONDS,
      });
      console.log(`已存储验证码 ${code} -> ${to}`);
    } catch (err) {
      console.error("处理邮件失败:", err);
    }
  },
};

// ───────────────────────────────────────────────────────────
// 路由处理
// ───────────────────────────────────────────────────────────

async function handleCodeRequest(request, url, env) {
  const authError = checkAuth(request, url, env);
  if (authError) return authError;

  const email = (url.searchParams.get("email") || "").toLowerCase().trim();
  if (!email) return json({ error: "missing email" }, 400);

  if (request.method === "GET") {
    const code = await env.KV_CODES.get(kvKey(email));
    if (!code) return json({ code: null });
    await env.KV_CODES.delete(kvKey(email));
    return json({ code, email });
  }

  if (request.method === "DELETE") {
    await env.KV_CODES.delete(kvKey(email));
    return json({ deleted: true });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

async function handleMailsRequest(request, url, env) {
  const authError = checkAuth(request, url, env);
  if (authError) return authError;

  const id = url.searchParams.get("id");
  const format = url.searchParams.get("format") || "html";

  // 单封操作
  if (id) {
    const key = `mail:${id}`;
    if (request.method === "DELETE") {
      await env.KV_CODES.delete(key);
      return json({ deleted: true, id });
    }
    const { value, metadata } = await env.KV_CODES.getWithMetadata(key);
    if (value === null) return new Response("Not Found", { status: 404 });
    if (format === "raw") {
      return new Response(value, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (format === "json") {
      return json({ id, metadata: metadata || {}, raw: value });
    }
    return mailDetailPage(id, metadata || {}, value, url);
  }

  // 批量删除
  if (request.method === "DELETE") {
    const list = await env.KV_CODES.list({ prefix: "mail:" });
    await Promise.all(list.keys.map((k) => env.KV_CODES.delete(k.name)));
    return json({ deleted: list.keys.length });
  }

  // 列表
  const list = await env.KV_CODES.list({
    prefix: "mail:",
    limit: MAIL_LIST_LIMIT,
  });
  const items = list.keys
    .map((k) => ({
      id: k.name.replace(/^mail:/, ""),
      ...(k.metadata || {}),
    }))
    .sort((a, b) => (b.received_at || 0) - (a.received_at || 0));

  if (format === "json") {
    return json({ count: items.length, items });
  }
  return mailListPage(items, url);
}

function checkAuth(request, url, env) {
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
  const tokenParam = url.searchParams.get("token") || "";
  if (
    auth !== `Bearer ${env.SHARED_TOKEN}` &&
    tokenParam !== env.SHARED_TOKEN
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// 工具函数
// ───────────────────────────────────────────────────────────

function kvKey(email) {
  return `code:${email}`;
}

function mailId(ts = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function readHeader(message, name) {
  try {
    return (message.headers && message.headers.get(name)) || "";
  } catch (_) {
    return "";
  }
}

function clip(s, max) {
  s = String(s == null ? "" : s);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );
}

function mailListPage(items, url) {
  const token = url.searchParams.get("token") || "";
  const tokenQs = token ? `&token=${encodeURIComponent(token)}` : "";
  const rows = items
    .map((it) => {
      const time = it.received_at
        ? new Date(it.received_at).toISOString().replace("T", " ").slice(0, 19)
        : "-";
      return `<tr>
      <td>${escapeHtml(time)}</td>
      <td>${escapeHtml(it.from || "-")}</td>
      <td>${escapeHtml(it.to || "-")}</td>
      <td><a href="/mails?id=${encodeURIComponent(it.id)}${tokenQs}">${escapeHtml(it.subject || "(无主题)")}</a></td>
      <td>${it.size || 0}</td>
    </tr>`;
    })
    .join("");
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>邮件列表</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1200px;margin:20px auto;padding:0 20px;color:#1f2937;line-height:1.5}
h1{font-size:20px;margin:8px 0 16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top;word-break:break-all}
th{background:#f9fafb;font-weight:600}
tr:hover td{background:#f9fafb}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.empty{text-align:center;color:#6b7280;padding:24px}
</style></head><body>
<h1>邮件列表（${items.length} 封，最多展示 ${MAIL_LIST_LIMIT} 封）</h1>
<table>
<thead><tr><th>接收时间 (UTC)</th><th>发件人</th><th>收件人</th><th>主题</th><th>大小</th></tr></thead>
<tbody>${rows || `<tr><td colspan="5" class="empty">暂无邮件</td></tr>`}</tbody>
</table>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function mailDetailPage(id, meta, raw, url) {
  const token = url.searchParams.get("token") || "";
  const backQs = token ? `?token=${encodeURIComponent(token)}` : "";
  const rawQs = token
    ? `?id=${encodeURIComponent(id)}&format=raw&token=${encodeURIComponent(token)}`
    : `?id=${encodeURIComponent(id)}&format=raw`;
  const time = meta.received_at
    ? new Date(meta.received_at).toISOString().replace("T", " ").slice(0, 19)
    : "-";
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>${escapeHtml(meta.subject || "(无主题)")}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1200px;margin:20px auto;padding:0 20px;color:#1f2937;line-height:1.5}
.meta{background:#f9fafb;padding:12px 16px;border-radius:6px;margin:12px 0;font-size:14px}
.meta div{margin:3px 0;word-break:break-all}
pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.5;max-height:70vh}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:20px;margin:8px 0}
</style></head><body>
<p><a href="/mails${backQs}">← 返回列表</a> ｜ <a href="/mails${rawQs}">查看纯文本</a></p>
<h1>${escapeHtml(meta.subject || "(无主题)")}</h1>
<div class="meta">
  <div><strong>ID</strong>：${escapeHtml(id)}</div>
  <div><strong>发件人</strong>：${escapeHtml(meta.from || "-")}</div>
  <div><strong>收件人</strong>：${escapeHtml(meta.to || "-")}</div>
  <div><strong>接收时间 (UTC)</strong>：${escapeHtml(time)}</div>
  <div><strong>原始大小</strong>：${meta.size || 0} bytes</div>
</div>
<h2>原始邮件内容</h2>
<pre>${escapeHtml(raw)}</pre>
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
  const decoder = new TextDecoder();
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
