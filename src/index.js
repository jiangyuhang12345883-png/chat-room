import { DurableObject } from "cloudflare:workers";

// ⚠️ 1. API 地址（别带斜杠）
const CLOUD_MAIL_API = "https://mail.yuhang.dpdns.org/api/login";
// ⚠️ 2. 注册跳转地址
const CLOUD_MAIL_REGISTER_URL = "https://mail.yuhang.dpdns.org";
// ⚠️ 3. 强制要求的邮箱后缀
const ALLOWED_DOMAIN = "@yuhang.dpdns.org";
// ⚠️ 4. Cloud Mail 基础地址（用于 token 校验）
const CLOUD_MAIL_BASE = "https://mail.yuhang.dpdns.org";

// 统一 JSON 响应
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 验证 Cloud Mail token：调受保护接口，2xx 即有效
// Cloud Mail 3.4 的 Authorization 头不加 Bearer 前缀
async function verifyCloudMailToken(token) {
  try {
    const res = await fetch(`${CLOUD_MAIL_BASE}/api/account/list`, {
      headers: { "Authorization": token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export class ChatRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // 从 Worker 传递的 header 中读取已验证的用户邮箱
    const email = request.headers.get("x-user-email");
    if (!email) {
      return new Response("Unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server); // Hibernation API

    // 坑 2 修复：数据绑在 ws 上，DO 休眠醒来后仍能恢复
    server.serializeAttachment({ email, lastMsgTime: 0 });

    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation API 的消息处理器
  async webSocketMessage(ws, message) {
    // 从 ws 自身读取信息，哪怕休眠过也能恢复
    const session = ws.deserializeAttachment();
    if (!session) return;

    // 频率限制：每条消息间隔至少 500ms
    const now = Date.now();
    if (now - session.lastMsgTime < 500) {
      return;
    }
    session.lastMsgTime = now;
    ws.serializeAttachment(session); // 更新限流时间

    // 广播给所有连接（用 ctx.getWebSockets() 获取所有存活连接）
    const allSockets = this.ctx.getWebSockets();
    for (const conn of allSockets) {
      if (conn.readyState === 1) { // WebSocket.OPEN
        try {
          conn.send(message);
        } catch {
          // 发送失败自动忽略
        }
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    ws.close(code, "Durable Object 关闭连接");
  }

  async webSocketError(ws) {
    // 发生错误时无需额外处理，连接会被自动清理
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
          return json({ success: false, msg: "请使用本站专属邮箱后缀登录" }, 400);
        }

        const mailRes = await fetch(CLOUD_MAIL_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        const mailData = await mailRes.json();

        // 只认 token 作为成功标志
        if (mailRes.ok && mailData.token) {
          return json({
            success: true,
            token: mailData.token,
            email: email.toLowerCase(),
          });
        } else {
          return json({ success: false, msg: "账号或密码错误" }, 401);
        }
      } catch (err) {
        return json({ success: false, msg: "验证服务器异常" }, 500);
      }
    }

    // ========== WebSocket 鉴权检查 ==========
    if (request.headers.get("Upgrade") === "websocket") {
      const token = url.searchParams.get("token");
      const email = url.searchParams.get("email");

      if (!token || !email) {
        return new Response("缺少认证信息", { status: 401 });
      }

      const isValid = await verifyCloudMailToken(token);
      if (!isValid) {
        return new Response("认证已失效，请重新登录", { status: 401 });
      }

      // 坑 1 修复：Request headers 是只读的，必须用 new Headers 重组
      const newHeaders = new Headers(request.headers);
      newHeaders.set("x-user-email", email);

      const newRequest = new Request(request.url, {
        method: request.method,
        headers: newHeaders,
        body: request.body,
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
            #error-msg { color: #ef4444; font-size: 14px; margin-bottom: 10px; display: none; }
            #chat-container { display: none; flex-direction: column; height: 100vh; }
            #messages { flex: 1; overflow-y: auto; padding: 10px; }
            .msg { margin-bottom: 8px; padding: 8px; background: #1e1e1e; border-radius: 6px; }
            #input-area { display: flex; padding: 10px; border-top: 1px solid #333; }
            #chat-input { flex: 1; margin-bottom: 0; }
            #send-btn { width: auto; margin-left: 10px; padding: 10px 15px; }
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
              <span style="font-weight: bold; color: #3b82f6;">在线聊天室</span>
              <button onclick="logout()" style="width: auto; padding: 5px 10px; background: #ef4444; font-size: 13px;">退出登录</button>
            </div>
            <div id="messages"></div>
            <div id="input-area">
              <input id="chat-input" placeholder="输入消息..." autocomplete="off">
              <button id="send-btn" onclick="sendMsg()">发送</button>
            </div>
          </div>

          <script>
            let ws;

            window.onload = () => {
              const savedToken = localStorage.getItem('chat_token');
              const savedEmail = localStorage.getItem('chat_email');
              if (savedToken && savedEmail) goToChat(savedEmail, savedToken);
            };

            function logout() {
              localStorage.removeItem('chat_token');
              localStorage.removeItem('chat_email');
              location.reload();
            }

            async function verifyLogin() {
              const email = document.getElementById('email').value;
              const password = document.getElementById('password').value;
              const errorMsg = document.getElementById('error-msg');
              
              if (!email || !password) {
                errorMsg.textContent = "请输入账号密码";
                errorMsg.style.display = 'block';
                return;
              }

              errorMsg.style.display = 'none';
              document.querySelector('#login-box button').textContent = '验证中...';

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
                  document.querySelector('#login-box button').textContent = '验证并进入';
                }
              } catch (err) {
                errorMsg.textContent = "网络错误，请重试";
                errorMsg.style.display = 'block';
                document.querySelector('#login-box button').textContent = '验证并进入';
              }
            }

            function goToChat(email, token) {
              document.getElementById('login-box').style.display = 'none';
              document.getElementById('chat-container').style.display = 'flex';
              window.myEmail = email;
              window.myToken = token;
              initChat();
            }

            function initChat() {
              // WebSocket 连接带上 token 和 email
              const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') 
                + location.host 
                + '?token=' + encodeURIComponent(window.myToken)
                + '&email=' + encodeURIComponent(window.myEmail);
              
              ws = new WebSocket(wsUrl);
              
              const messages = document.getElementById('messages');
              
              ws.onmessage = (e) => {
                const d = document.createElement('div');
                d.className = 'msg';
                d.textContent = e.data;
                messages.appendChild(d);
                messages.scrollTop = messages.scrollHeight;
              };

              ws.onerror = () => {
                alert('连接失败，请重新登录');
                logout();
              };

              ws.onclose = (e) => {
                if (e.code !== 1000) {
                  alert('连接已断开，请重新登录');
                  logout();
                }
              };
            }

            function sendMsg() {
              const input = document.getElementById('chat-input');
              if (input.value.trim() && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(window.myEmail.split('@')[0] + ": " + input.value);
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