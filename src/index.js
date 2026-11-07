import { DurableObject } from "cloudflare:workers";

// ⚠️ 1. API 地址（别带斜杠）
const CLOUD_MAIL_API = "https://mail.yuhang.dpdns.org/api/login";
// ⚠️ 2. 注册跳转地址
const CLOUD_MAIL_REGISTER_URL = "https://mail.yuhang.dpdns.org";
// ⚠️ 3. 强制要求的邮箱后缀
const ALLOWED_DOMAIN = "@yuhang.dpdns.org";
// ⚠️ 4. Cloud Mail 基础地址
const CLOUD_MAIL_BASE = "https://mail.yuhang.dpdns.org";

// 统一 JSON 响应
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 从登录返回里挖 token
function extractToken(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.token,
    obj.access_token,
    obj.data?.token,
    obj.data?.access_token,
    obj.result?.token,
  ];
  for (const t of candidates) {
    if (typeof t === "string" && t.length >= 10) return t;
  }
  return null;
}

// 验证 Cloud Mail token —— 真实校验
// endpoint: /api/account/list，Authorization 裸 token（实测确认）
// 同时检查 HTTP 状态 + body.code，兼容 Cloud Mail 用 HTTP 200 包装业务错误
async function verifyCloudMailToken(token) {
  try {
    const res = await fetch(`${CLOUD_MAIL_BASE}/api/account/list`, {
      headers: { Authorization: token },
    });

    if (!res.ok) return false;

    let body;
    try {
      body = await res.json();
    } catch {
      return false;
    }

    if (body && body.code === 200) return true;
    return false;
  } catch {
    return false;
  }
}

export class ChatRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const email = request.headers.get("x-user-email");
    if (!email) {
      return new Response("Unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({ email, lastMsgTime: 0 });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const session = ws.deserializeAttachment();
    if (!session) return;

    const now = Date.now();
    if (now - session.lastMsgTime < 500) return;
    session.lastMsgTime = now;
    ws.serializeAttachment(session);

    if (typeof message !== "string") return;
    const text = message.slice(0, 500);
    if (!text.trim()) return;

    const payload = JSON.stringify({
      name: session.email.split("@")[0],
      email: session.email,
      text,
      ts: now,
    });

    const allSockets = this.ctx.getWebSockets();
    for (const conn of allSockets) {
      if (conn.readyState === 1) {
        try {
          conn.send(payload);
        } catch {
          // 忽略
        }
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // 无需再 close
  }

  async webSocketError(ws) {
    // 自动清理
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ========== 登录验证接口 ==========
    if (url.pathname === "/api/verify" && request.method === "POST") {
      try {
        const body = await request.json();
        const email = body.email;
        const password = body.password;

        if (!email || !password || !email.toLowerCase().endsWith(ALLOWED_DOMAIN.toLowerCase())) {
          return json(
            { success: false, msg: `请使用 ${ALLOWED_DOMAIN} 结尾的邮箱登录` },
            400
          );
        }

        const mailRes = await fetch(CLOUD_MAIL_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        const rawText = await mailRes.text();
        console.log("MAIL STATUS:", mailRes.status);

        let mailData = {};
        try {
          mailData = JSON.parse(rawText);
        } catch {
          mailData = {};
        }

        const token = extractToken(mailData);
        // 只认实测确认的成功码，不再为"无 code"留后门
        const bizOk = mailData?.code === 200;

        if (mailRes.ok && token && bizOk) {
          return json({
            success: true,
            token,
            email: email.toLowerCase(),
          });
        } else {
          const bizMsg = mailData?.message || mailData?.msg || "账号或密码错误";
          return json({ success: false, msg: bizMsg }, 401);
        }
      } catch (err) {
        console.log("VERIFY ERROR:", err.message);
        return json({ success: false, msg: "验证服务器异常" }, 500);
      }
    }

    // ========== token 有效性探测（自动重连用） ==========
    if (url.pathname === "/api/check-token" && request.method === "POST") {
      try {
        const body = await request.json();
        const token = body.token;
        if (!token || typeof token !== "string") {
          return json({ valid: false }, 401);
        }

        const ok = await verifyCloudMailToken(token);
        return ok ? json({ valid: true }) : json({ valid: false }, 401);
      } catch {
        return json({ valid: false }, 400);
      }
    }

    // ========== WebSocket 鉴权检查 ==========
    if (request.headers.get("Upgrade") === "websocket") {
      const token = url.searchParams.get("token");
      const email = url.searchParams.get("email");

      if (!token || !email) {
        return new Response("缺少认证信息", { status: 401 });
      }

      if (!email.toLowerCase().endsWith(ALLOWED_DOMAIN.toLowerCase())) {
        return new Response(`仅支持 ${ALLOWED_DOMAIN} 结尾的邮箱`, { status: 400 });
      }

      const isValid = await verifyCloudMailToken(token);
      if (!isValid) {
        return new Response("登录已过期，请重新登录", { status: 401 });
      }

      const newHeaders = new Headers(request.headers);
      newHeaders.set("x-user-email", email);

      const newRequest = new Request(request.url, {
        method: request.method,
        headers: newHeaders,
      });

      const stub = env.CHAT_ROOM.getByName("global-room");
      return stub.fetch(newRequest);
    }

    // ========== 前端页面 ==========
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>聊天室</title>
          <style>
            body { font-family: sans-serif; background: #121212; color: #fff; display: flex; flex-direction: column; height: 100vh; margin: 0; }
            #login-box { padding: 20px; max-width: 300px; margin: 50px auto; background: #1e1e1e; border-radius: 8px; }
            input { width: 100%; box-sizing: border-box; padding: 10px; margin-bottom: 10px; border: none; border-radius: 4px; background: #2a2a2a; color: #fff; }
            button { width: 100%; padding: 10px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; }
            #error-msg { color: #ef4444; font-size: 14px; margin-bottom: 10px; display: none; word-break: break-all; }
            #chat-container { display: none; flex-direction: column; height: 100vh; }
            #messages { flex: 1; overflow-y: auto; padding: 10px; }
            .msg { margin-bottom: 8px; padding: 8px; background: #1e1e1e; border-radius: 6px; }
            .msg .name { color: #3b82f6; font-weight: bold; margin-right: 6px; }
            #input-area { display: flex; padding: 10px; border-top: 1px solid #333; }
            #chat-input { flex: 1; margin-bottom: 0; }
            #send-btn { width: auto; margin-left: 10px; padding: 10px 15px; }
            #conn-status { font-size: 12px; }
          </style>
        </head>
        <body>
          <div id="login-box">
            <h3 style="margin-top:0;">登录聊天室</h3>
            <div id="error-msg"></div>
            <input type="email" id="email" placeholder="Cloud Mail 邮箱" autocomplete="off">
            <input type="password" id="password" placeholder="密码">
            <button onclick="verifyLogin()">验证并进入</button>
            <div style="text-align: center; margin-top: 15px; font-size: 13px; color: #9ca3af;">
              第一次使用？<a href="${CLOUD_MAIL_REGISTER_URL}" target="_blank" style="color: #3b82f6; text-decoration: none;">注册</a>
            </div>
          </div>

          <div id="chat-container">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #1e1e1e; border-bottom: 1px solid #333;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-weight: bold; color: #3b82f6;">在线聊天室</span>
                <span id="conn-status" style="color:#9ca3af;">已连接</span>
              </div>
              <button onclick="logout()" style="width: auto; padding: 5px 10px; background: #ef4444; font-size: 13px;">退出登录</button>
            </div>
            <div id="messages"></div>
            <div id="input-area">
              <input id="chat-input" placeholder="输入消息..." autocomplete="off">
              <button id="send-btn" onclick="sendMsg()">发送</button>
            </div>
          </div>

          <script>
            let ws = null;
            let reconnectAttempts = 0;
            let reconnectTimer = null;
            let manualClose = false;
            const MAX_RECONNECT_DELAY = 30000;

            window.onload = () => {
              const savedToken = localStorage.getItem('chat_token');
              const savedEmail = localStorage.getItem('chat_email');
              if (savedToken && savedEmail) goToChat(savedEmail, savedToken);
            };

            function logout() {
              manualClose = true;
              if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
              if (ws) { try { ws.close(1000, "logout"); } catch {} }
              localStorage.removeItem('chat_token');
              localStorage.removeItem('chat_email');
              location.reload();
            }

            function setStatus(text, color) {
              const el = document.getElementById('conn-status');
              if (!el) return;
              el.textContent = text;
              el.style.color = color || '#9ca3af';
            }

            async function verifyLogin() {
              const email = document.getElementById('email').value;
              const password = document.getElementById('password').value;
              const errorMsg = document.getElementById('error-msg');
              const btn = document.querySelector('#login-box button');

              if (!email || !password) {
                errorMsg.textContent = "请输入账号密码";
                errorMsg.style.display = 'block';
                return;
              }

              errorMsg.style.display = 'none';
              btn.textContent = '验证中...';

              try {
                const res = await fetch('/api/verify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email, password })
                });
                const data = await res.json();

                if (data.success) {
                  localStorage.setItem('chat_token', data.token);
                  localStorage.setItem('chat_email', data.email);
                  goToChat(data.email, data.token);
                } else {
                  errorMsg.textContent = data.msg || "验证失败";
                  errorMsg.style.display = 'block';
                  btn.textContent = '验证并进入';
                }
              } catch (err) {
                errorMsg.textContent = "网络错误，请重试";
                errorMsg.style.display = 'block';
                btn.textContent = '验证并进入';
              }
            }

            function goToChat(email, token) {
              document.getElementById('login-box').style.display = 'none';
              document.getElementById('chat-container').style.display = 'flex';
              window.myEmail = email;
              window.myToken = token;
              manualClose = false;
              reconnectAttempts = 0;
              connect();
            }

            function connect() {
              if (manualClose) return;
              if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

              const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://')
                + location.host
                + '?token=' + encodeURIComponent(window.myToken)
                + '&email=' + encodeURIComponent(window.myEmail);

              ws = new WebSocket(wsUrl);
              const messages = document.getElementById('messages');

              ws.onopen = () => {
                reconnectAttempts = 0;
                setStatus("已连接", "#22c55e");
              };

              ws.onmessage = (e) => {
                let data;
                try { data = JSON.parse(e.data); } catch { data = { text: e.data, name: '' }; }
                const d = document.createElement('div');
                d.className = 'msg';
                if (data.name) {
                  const n = document.createElement('span');
                  n.className = 'name';
                  n.textContent = data.name + ':';
                  d.appendChild(n);
                }
                const t = document.createElement('span');
                t.textContent = data.text;
                d.appendChild(t);
                messages.appendChild(d);
                messages.scrollTop = messages.scrollHeight;
              };

              ws.onclose = async (e) => {
                if (manualClose) return;
                if (e.code === 1000) return;

                setStatus("连接断开，检查登录状态...", "#f59e0b");
                const stillValid = await probeToken(window.myToken);
                if (!stillValid) {
                  alert("登录已过期，请重新登录");
                  logout();
                  return;
                }
                scheduleReconnect();
              };

              ws.onerror = () => {
                // 交给 onclose 统一处理
              };
            }

            function scheduleReconnect() {
              if (manualClose) return;
              reconnectAttempts++;
              const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
              setStatus(`连接断开，${Math.round(delay / 1000)} 秒后重连（第 ${reconnectAttempts} 次）`, "#f59e0b");
              reconnectTimer = setTimeout(() => {
                if (!manualClose) connect();
              }, delay);
            }

            async function probeToken(token) {
              try {
                const res = await fetch('/api/check-token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token }),
                });
                const data = await res.json();
                return res.ok && data.valid === true;
              } catch {
                // 探测请求本身失败（断网）→ 认为 token 可能还有效，允许重试
                return true;
              }
            }

            function sendMsg() {
              const input = document.getElementById('chat-input');
              if (input.value.trim() && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(input.value);
                input.value = '';
              }
            }

            document.getElementById('chat-input').addEventListener("keypress", (e) => {
              if (e.key === "Enter") sendMsg();
            });
          </script>
        </body>
        </html>
      `;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
};