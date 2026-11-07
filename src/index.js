import { DurableObject } from "cloudflare:workers";

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
    if (request.headers.get("Upgrade") !== "websocket") {
      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>聊天室</title>
<style>
body{font-family:sans-serif;background:#121212;color:#fff;display:flex;flex-direction:column;height:100vh;margin:0}
#messages{flex:1;overflow-y:auto;padding:10px;border-bottom:1px solid #333}
.msg{margin-bottom:8px;padding:8px;background:#1e1e1e;border-radius:6px}
#input-area{display:flex;padding:10px}
input{flex:1;padding:10px;border:none;border-radius:4px;background:#2a2a2a;color:#fff}
button{padding:10px 15px;margin-left:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px}
</style></head>
<body>
<div id="messages"></div>
<div id="input-area"><input id="input" placeholder="输入消息..." autocomplete="off"><button onclick="send()">发送</button></div>
<script>
const wsUrl=(location.protocol==='https:'?'wss://':'ws://')+location.host;
const ws=new WebSocket(wsUrl);
const messages=document.getElementById('messages');
const input=document.getElementById('input');
ws.onmessage=(e)=>{const d=document.createElement('div');d.className='msg';d.textContent=e.data;messages.appendChild(d);messages.scrollTop=messages.scrollHeight};
ws.onclose=()=>{const d=document.createElement('div');d.className='msg';d.textContent='【连接已断开，刷新页面重连】';messages.appendChild(d)};
function send(){if(input.value.trim()&&ws.readyState===WebSocket.OPEN){ws.send(input.value);input.value=''}}
input.addEventListener("keypress",(e)=>{if(e.key==="Enter")send()});
</script>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    const stub = env.CHAT_ROOM.getByName("global-room");
    return stub.fetch(request);
  },
};
