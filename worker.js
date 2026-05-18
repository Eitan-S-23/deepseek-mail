// @ts-nocheck
/**
 * DeepSeek 注册机 - Cloudflare Email Worker
 *
 * 部署要求：
 *  1. 在 Cloudflare Dashboard 启用 Email Routing，将 *@your-domain.com 路由到本 Worker
 *  2. 创建 KV 命名空间，绑定到本 Worker（变量名 KV_CODES）
 *  3. 在 Worker 环境变量中设置 SHARED_TOKEN（与 config.json 中 api_token 一致）
 *
 * HTTP API：
 *   GET    /healthz              —— 健康检查（无鉴权）
 *   GET    /code?email=xxx       —— 查询验证码（命中后立即从 KV 删除）
 *   DELETE /code?email=xxx       —— 主动清理验证码
 *   GET    /mails                —— 邮件列表（HTML，默认）
 *   GET    /mails?format=json    —— 邮件列表（JSON）
 *   GET    /mails?id=xxx         —— 单封邮件详情（HTML，解码后展示）
 *   GET    /mails?id=xxx&format=raw   —— 单封原文（纯文本，含 MIME 头）
 *   GET    /mails?id=xxx&format=json  —— 单封 JSON
 *   DELETE /mails?id=xxx         —— 删除单封邮件
 *   DELETE /mails                —— 清空所有邮件
 *
 * 鉴权（任选其一）：
 *   - Header：Authorization: Bearer <SHARED_TOKEN>
 *   - URL：  ?token=<SHARED_TOKEN>
 */

const KV_TTL_SECONDS = 60 * 30;
const MAIL_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAIL_LIST_LIMIT = 100;
const MAIL_BODY_LIMIT = 256 * 1024;

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

    if (url.pathname === "/code") return handleCodeRequest(request, url, env);
    if (url.pathname === "/mails") return handleMailsRequest(request, url, env);

    return new Response("Not Found", { status: 404 });
  },

  async email(message, env, ctx) {
    try {
      const to = (message.to || "").toLowerCase();
      const from = (message.from || "").toLowerCase();
      const rawSubject = readHeader(message, "subject");
      const subject = decodeMimeHeader(rawSubject);
      const receivedAt = Date.now();
      const raw = await streamToString(message.raw);

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
        console.log(`已存储邮件 id=${id} from=${from} to=${to} subject=${subject}`);
      }

      if (!isDeepSeekSender(from)) {
        console.log(`非 DeepSeek 发件人，跳过验证码提取: ${from}`);
        return;
      }

      const code = extractVerificationCode(raw);
      if (!code) {
        console.log(`未提取到验证码 to=${to} from=${from}`);
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
// 路由
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

  if (request.method === "DELETE") {
    const list = await env.KV_CODES.list({ prefix: "mail:" });
    await Promise.all(list.keys.map((k) => env.KV_CODES.delete(k.name)));
    return json({ deleted: list.keys.length });
  }

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
// 工具
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

// ───────────────────────────────────────────────────────────
// MIME 解码：encoded-word 头部（=?utf-8?B/Q?...?=）
// ───────────────────────────────────────────────────────────

function decodeMimeHeader(s) {
  if (!s) return "";
  const text = String(s);
  // 把相邻 encoded-word 之间的空白合并掉（RFC 2047 规定 word 之间空白要忽略）
  const compact = text.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return compact.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, encoding, encoded) => {
      try {
        let bytes;
        if (encoding.toUpperCase() === "B") {
          const binary = atob(encoded.replace(/\s/g, ""));
          bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
        } else {
          const decoded = encoded
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
              String.fromCharCode(parseInt(h, 16)),
            );
          bytes = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++) {
            bytes[i] = decoded.charCodeAt(i);
          }
        }
        return new TextDecoder(charset).decode(bytes);
      } catch (_) {
        return encoded;
      }
    },
  );
}

// ───────────────────────────────────────────────────────────
// MIME 解析：邮件结构 + 正文
// ───────────────────────────────────────────────────────────

function parseEmail(raw) {
  const { headers, body } = splitHeadBody(raw);
  return parseNode(headers, body);
}

function splitHeadBody(text) {
  let idx = text.indexOf("\r\n\r\n");
  let sep = 4;
  if (idx < 0) {
    idx = text.indexOf("\n\n");
    sep = 2;
  }
  if (idx < 0) return { headers: {}, body: text };
  return {
    headers: parseHeaders(text.slice(0, idx)),
    body: text.slice(idx + sep),
  };
}

function parseHeaders(headersRaw) {
  const unfolded = headersRaw.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!(name in headers)) headers[name] = value;
  }
  return headers;
}

function matchParam(contentType, name) {
  const re = new RegExp(`${name}\\s*=\\s*"?([^";\\s]+)"?`, "i");
  const m = contentType.match(re);
  return m ? m[1] : null;
}

function parseNode(headers, body) {
  const contentType = headers["content-type"] || "text/plain";
  const encoding = (headers["content-transfer-encoding"] || "7bit")
    .toLowerCase();
  const mainType = contentType.split(";")[0].trim().toLowerCase();

  if (mainType.startsWith("multipart/")) {
    const boundary = matchParam(contentType, "boundary");
    if (boundary) {
      const parts = splitMultipart(body, boundary).map((p) => {
        const sp = splitHeadBody(p);
        return parseNode(sp.headers, sp.body);
      });
      return { kind: "multipart", subtype: mainType, parts };
    }
  }

  const charset = matchParam(contentType, "charset") || "utf-8";
  return {
    kind: "single",
    contentType: mainType,
    charset,
    body: decodeBody(body, encoding, charset),
  };
}

function splitMultipart(body, boundary) {
  const endDelim = `--${boundary}--`;
  let endIdx = body.indexOf(endDelim);
  if (endIdx > -1) body = body.slice(0, endIdx);
  const parts = body.split(`--${boundary}`);
  return parts.slice(1).map((p) => p.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
}

function decodeBody(body, encoding, charset) {
  let bytes;
  try {
    if (encoding === "base64") {
      const binary = atob(body.replace(/\s/g, ""));
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else if (encoding === "quoted-printable") {
      const decoded = body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        );
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    } else {
      // 7bit / 8bit / binary：按原始字节处理
      bytes = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
    }
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch (_) {
    return body;
  }
}

function pickBestBody(parsed) {
  let plain = null;
  let html = null;
  function walk(node) {
    if (!node) return;
    if (node.kind === "multipart") {
      for (const p of node.parts) walk(p);
    } else {
      if (node.contentType === "text/plain" && plain == null) plain = node.body;
      if (node.contentType === "text/html" && html == null) html = node.body;
    }
  }
  walk(parsed);
  if (plain != null) return { type: "text/plain", content: plain };
  if (html != null)
    return { type: "text/html (转为纯文本)", content: stripHtml(html) };
  if (parsed.kind === "single") {
    return { type: parsed.contentType || "unknown", content: parsed.body || "" };
  }
  return { type: "unknown", content: "" };
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(\r?\n)?/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ───────────────────────────────────────────────────────────
// 页面渲染
// ───────────────────────────────────────────────────────────

function mailListPage(items, url) {
  const token = url.searchParams.get("token") || "";
  const tokenQs = token ? `&token=${encodeURIComponent(token)}` : "";
  const rows = items
    .map((it) => {
      const time = it.received_at
        ? new Date(it.received_at).toISOString().replace("T", " ").slice(0, 19)
        : "-";
      const subj = decodeMimeHeader(it.subject || "") || "(无主题)";
      return `<tr data-id="${escapeHtml(it.id)}">
      <td>${escapeHtml(time)}</td>
      <td>${escapeHtml(it.from || "-")}</td>
      <td>${escapeHtml(it.to || "-")}</td>
      <td><a href="/mails?id=${encodeURIComponent(it.id)}${tokenQs}">${escapeHtml(subj)}</a></td>
      <td>${it.size || 0}</td>
      <td><button class="del-row" data-id="${escapeHtml(it.id)}">删除</button></td>
    </tr>`;
    })
    .join("");
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>邮件列表</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1200px;margin:20px auto;padding:0 20px;color:#1f2937;line-height:1.5}
.top{display:flex;justify-content:space-between;align-items:center;margin:8px 0 16px}
.top h1{font-size:20px;margin:0}
button{cursor:pointer;border:1px solid #d1d5db;background:#fff;color:#1f2937;padding:6px 12px;border-radius:4px;font-size:13px}
button:hover{background:#f3f4f6}
button.danger{border-color:#dc2626;color:#dc2626}
button.danger:hover{background:#fee2e2}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top;word-break:break-all}
th{background:#f9fafb;font-weight:600}
tr:hover td{background:#f9fafb}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.empty{text-align:center;color:#6b7280;padding:24px}
</style></head><body>
<div class="top">
  <h1>邮件列表（${items.length} 封，最多展示 ${MAIL_LIST_LIMIT} 封）</h1>
  <div>
    <button onclick="location.reload()">刷新</button>
    <button class="danger" id="del-all">清空全部</button>
  </div>
</div>
<table>
<thead><tr><th>接收时间 (UTC)</th><th>发件人</th><th>收件人</th><th>主题</th><th>大小</th><th>操作</th></tr></thead>
<tbody>${rows || `<tr><td colspan="6" class="empty">暂无邮件</td></tr>`}</tbody>
</table>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const qs = token ? '?token=' + encodeURIComponent(token) : '';
async function delOne(id){
  if(!confirm('确认删除该邮件？')) return;
  const u = '/mails?id=' + encodeURIComponent(id) + (token ? '&token=' + encodeURIComponent(token) : '');
  const r = await fetch(u, { method: 'DELETE' });
  if(r.ok) location.reload();
  else alert('删除失败：' + await r.text());
}
document.getElementById('del-all').addEventListener('click', async () => {
  if(!confirm('确认清空全部邮件？此操作不可撤销。')) return;
  const r = await fetch('/mails' + qs, { method: 'DELETE' });
  if(r.ok) location.reload();
  else alert('清空失败：' + await r.text());
});
document.querySelectorAll('.del-row').forEach(b => {
  b.addEventListener('click', () => delOne(b.dataset.id));
});
</script>
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

  let parsed, best;
  try {
    parsed = parseEmail(raw);
    best = pickBestBody(parsed);
  } catch (e) {
    best = { type: "解析失败", content: String(e) };
  }

  const rootHeaders = (() => {
    try {
      return splitHeadBody(raw).headers;
    } catch (_) {
      return {};
    }
  })();

  const subjectDecoded =
    decodeMimeHeader(rootHeaders.subject || meta.subject || "") ||
    "(无主题)";
  const fromDecoded =
    decodeMimeHeader(rootHeaders.from || meta.from || "") || "-";
  const toDecoded =
    decodeMimeHeader(rootHeaders.to || meta.to || "") || "-";

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>${escapeHtml(subjectDecoded)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1200px;margin:20px auto;padding:0 20px;color:#1f2937;line-height:1.5}
.top{display:flex;justify-content:space-between;align-items:center;margin:8px 0}
.meta{background:#f9fafb;padding:12px 16px;border-radius:6px;margin:12px 0;font-size:14px}
.meta div{margin:3px 0;word-break:break-all}
pre.body{background:#fff;border:1px solid #e5e7eb;padding:16px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6;max-height:60vh}
pre.raw{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.5;max-height:50vh}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:20px;margin:8px 0}
h2{font-size:15px;margin:20px 0 8px;color:#374151}
button{cursor:pointer;border:1px solid #dc2626;color:#dc2626;background:#fff;padding:6px 12px;border-radius:4px;font-size:13px}
button:hover{background:#fee2e2}
details{margin:12px 0}
summary{cursor:pointer;color:#6b7280;font-size:13px;user-select:none}
.tag{display:inline-block;background:#e5e7eb;color:#374151;padding:2px 8px;border-radius:3px;font-size:11px;margin-left:6px}
</style></head><body>
<div class="top">
  <div><a href="/mails${backQs}">← 返回列表</a> ｜ <a href="/mails${rawQs}">查看原文</a></div>
  <button id="del">删除此邮件</button>
</div>
<h1>${escapeHtml(subjectDecoded)}</h1>
<div class="meta">
  <div><strong>ID</strong>：${escapeHtml(id)}</div>
  <div><strong>发件人</strong>：${escapeHtml(fromDecoded)}</div>
  <div><strong>收件人</strong>：${escapeHtml(toDecoded)}</div>
  <div><strong>接收时间 (UTC)</strong>：${escapeHtml(time)}</div>
  <div><strong>原始大小</strong>：${meta.size || 0} bytes</div>
</div>

<h2>正文 <span class="tag">${escapeHtml(best.type)}</span></h2>
<pre class="body">${escapeHtml(best.content || "(空)")}</pre>

<details>
<summary>显示原始邮件（含 MIME 头部、未解码字节）</summary>
<pre class="raw">${escapeHtml(raw)}</pre>
</details>

<script>
const token = new URLSearchParams(location.search).get('token') || '';
document.getElementById('del').addEventListener('click', async () => {
  if(!confirm('确认删除该邮件？')) return;
  const u = '/mails?id=${encodeURIComponent(id)}' + (token ? '&token=' + encodeURIComponent(token) : '');
  const r = await fetch(u, { method: 'DELETE' });
  if(r.ok) location.href = '/mails' + (token ? '?token=' + encodeURIComponent(token) : '');
  else alert('删除失败：' + await r.text());
});
</script>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function isDeepSeekSender(from) {
  if (!from) return false;
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
