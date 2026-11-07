import { DurableObject } from "cloudflare:workers";

// ⚠️ 1. API 地址（别带斜杠）
const CLOUD_MAIL_API = "https://mail.yuhang.dpdns.org/api/login";
// ⚠️ 2. 注册跳转地址
const CLOUD_MAIL_REGISTER_URL = "https://mail.yuhang.dpdns.org";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = [];
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(webSocket) {
    webSocket.accept();
    this.sessions.push(webSocket);

    webSocket.addEventListener("message", (msg) => {
      const message = msg.data;
      this.sessions = this.sessions.filter((session) => {
        try {
          session.send(message);
          return true;
        } catch (err) {
          return false;
        }
      });
    });

    webSocket.addEventListener("close", () => {
      this.sessions = this.sessions.filter((s) => s !== webSocket);
    });

    webSocket.addEventListener("error", () => {
      this.sessions = this.sessions.filter((s) => s !== webSocket);
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 登录验证接口
    if (url.pathname === "/api/verify" && request.method === "POST") {
      try {
        const body = await request.json();
        const email = body.email;
        const password = body.password;

        if (!email || !password) {
          return new Response(JSON.stringify({ success: false, msg: "账号或密码不能为空" }), { status: 400 });
        }

        const mailRes = await fetch(CLOUD_MAIL_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, password: password })
        });

        if (mailRes.ok) {
          const mailData = await mailRes.json();
          // 返回真实的 token 和邮箱给前端保存
          const token = mailData.token || "fallback_token_" + Date.now();
          return new Response(JSON.stringify({ 
            success: true, 
            token: token,
            email: email
          }), { headers: { "Content-Type": "application/json" } });
        } else {
          return new Response(JSON.stringify({ success: false, msg: "Cloud Mail 账号或密码错误" }), { status: 401 });
        }
      } catch (err) {
        return new Response(JSON.stringify({ success: false, msg: "验证服务器异常" }), { status: 500 });
      }
    }

    // 2. 网页界面
    if (request.headers.get("Upgrade") !== "websocket") {
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
            #messages { flex: 1; overflow-y: auto; padding: 10px; border-bottom: 1px solid #333; }
            .msg { margin-bottom: 8px; padding: 8px; background: #1e1e1e; border-radius: 6px; }
            #input-area { display: flex; padding: 10px; }
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
            <div id="messages"></div>
            <div id="input-area">
              <input id="chat-input" placeholder="输入消息..." autocomplete="off">
              <button id="send-btn" onclick="sendMsg()">发送</button>
            </div>
          </div>

          <script>
            let ws;

            // 页面一加载，先检查有没有历史登录记录
            window.onload = () => {
              const savedToken = localStorage.getItem('chat_token');
              const savedEmail = localStorage.getItem('chat_email');
              
              if (savedToken && savedEmail) {
                // 如果有记录，直接进聊天室
                goToChat(savedEmail);
              }
            };

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
                  // 把 Token 和邮箱存进浏览器
                  localStorage.setItem('chat_token', data.token);
                  localStorage.setItem('chat_email', data.email);
                  // 进入聊天室
                  goToChat(data.email);
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

            function goToChat(email) {
              document.getElementById('login-box').style.display = 'none';
              document.getElementById('chat-container').style.display = 'flex';
              window.myEmail = email;
              initChat();
            }

            function initChat() {
              const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
              ws = new WebSocket(wsUrl);
              const messages = document.getElementById('messages');

              ws.onmessage = (e) => {
                const d = document.createElement('div');
                d.className = 'msg';
                d.textContent = e.data;
                messages.appendChild(d);
                messages.scrollTop = messages.scrollHeight;
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

    // WebSocket 连接处理
    const stub = env.CHAT_ROOM.getByName("global-room");
    return stub.fetch(request);
  },
};