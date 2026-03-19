// ============================================================
//  CHAT APP — Cloudflare Worker + Durable Objects
//  Deploy with: wrangler deploy
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket upgrade → hand off to Durable Object
    if (request.headers.get("Upgrade") === "websocket") {
      const roomName = url.searchParams.get("room") || "general";
      const id = env.CHAT_ROOM.idFromName(roomName);
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(request);
    }

    // Serve the chat UI for all other requests
    return new Response(HTML, {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  },
};

// ============================================================
//  DURABLE OBJECT — one instance per room, holds all sockets
// ============================================================
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map(); // id → { socket, name, color }
    this.messageHistory = []; // last 50 messages
  }

  async fetch(request) {
    const url = new URL(request.url);
    const nickname = decodeURIComponent(url.searchParams.get("nick") || "Anonymous");

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);

    const sessionId = crypto.randomUUID();
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    this.sessions.set(server, { id: sessionId, name: nickname, color });

    // Send history to new joiner
    server.send(JSON.stringify({
      type: "history",
      messages: this.messageHistory,
    }));

    // Announce join
    this.broadcast(server, {
      type: "system",
      text: `${nickname} joined the room`,
      ts: Date.now(),
    });

    // Send current user list
    this.broadcastUserList();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the Workers runtime for each incoming WS message
  async webSocketMessage(ws, raw) {
    const session = this.sessions.get(ws);
    if (!session) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "chat") {
      const outgoing = {
        type: "chat",
        id: crypto.randomUUID(),
        from: session.name,
        color: session.color,
        text: msg.text,
        ts: Date.now(),
      };
      this.messageHistory.push(outgoing);
      if (this.messageHistory.length > 50) this.messageHistory.shift();
      this.broadcast(null, outgoing); // send to everyone including sender
    }
  }

  async webSocketClose(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session) {
      this.broadcast(null, {
        type: "system",
        text: `${session.name} left the room`,
        ts: Date.now(),
      });
      this.broadcastUserList();
    }
  }

  broadcast(exclude, data) {
    const json = JSON.stringify(data);
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try { ws.send(json); } catch {}
      }
    }
    // Also send to excluded sender if it's a chat msg
    if (exclude && data.type === "chat") {
      try { exclude.send(json); } catch {}
    }
  }

  broadcastUserList() {
    const users = [...this.sessions.values()].map(s => ({
      name: s.name,
      color: s.color,
    }));
    const json = JSON.stringify({ type: "users", users });
    for (const [ws] of this.sessions) {
      try { ws.send(json); } catch {}
    }
  }
}

const COLORS = [
  "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF",
  "#FF922B", "#CC5DE8", "#20C997", "#F06595",
];

// ============================================================
//  FRONTEND HTML (embedded — no separate hosting needed)
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d0d0f;
    --surface: #141417;
    --border: #222228;
    --text: #e8e8f0;
    --muted: #6b6b7a;
    --accent: #7c6af7;
    --accent2: #f7a06a;
    --radius: 10px;
    --font-ui: 'Syne', sans-serif;
    --font-mono: 'DM Mono', monospace;
  }

  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font-ui); }

  /* ── LOBBY ── */
  #lobby {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .lobby-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 40px 36px;
    width: 100%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .lobby-card h1 {
    font-size: 2rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .lobby-card h1 span { color: var(--accent); }
  .lobby-card p { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; }
  .field input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.95rem;
    padding: 12px 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .field input:focus { border-color: var(--accent); }
  .btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    font-family: var(--font-ui);
    font-size: 0.95rem;
    font-weight: 700;
    padding: 13px;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
  }
  .btn:hover { opacity: 0.88; }
  .btn:active { transform: scale(0.98); }

  /* ── APP LAYOUT ── */
  #app {
    height: 100%;
    display: none;
    grid-template-rows: 54px 1fr 64px;
    grid-template-columns: 1fr 200px;
    grid-template-areas:
      "header header"
      "messages sidebar"
      "input   sidebar";
  }
  @media (max-width: 600px) {
    #app { grid-template-columns: 1fr; grid-template-areas: "header" "messages" "input"; }
    #sidebar { display: none; }
  }

  /* ── HEADER ── */
  #header {
    grid-area: header;
    display: flex;
    align-items: center;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }
  #header .room-name {
    font-weight: 700;
    font-size: 1rem;
    letter-spacing: -0.01em;
  }
  #header .room-name span { color: var(--accent); }
  #header .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #4caf50;
    box-shadow: 0 0 6px #4caf50;
    flex-shrink: 0;
  }
  #status { margin-left: auto; font-size: 0.75rem; color: var(--muted); font-family: var(--font-mono); }

  /* ── MESSAGES ── */
  #messages {
    grid-area: messages;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    scroll-behavior: smooth;
  }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }

  .msg-wrap { display: flex; flex-direction: column; gap: 2px; }
  .msg-wrap.own { align-items: flex-end; }

  .msg-meta {
    font-size: 0.7rem;
    color: var(--muted);
    padding: 0 10px;
    display: flex;
    gap: 6px;
  }
  .msg-meta .name { font-weight: 700; }

  .bubble {
    max-width: min(80%, 500px);
    padding: 9px 14px;
    border-radius: 14px;
    font-size: 0.92rem;
    line-height: 1.5;
    word-break: break-word;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .own .bubble {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .system-msg {
    text-align: center;
    font-size: 0.75rem;
    color: var(--muted);
    font-family: var(--font-mono);
    padding: 4px 0;
  }

  /* ── INPUT ── */
  #input-area {
    grid-area: input;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    border-top: 1px solid var(--border);
  }
  #msg-input {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 22px;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 0.92rem;
    padding: 10px 16px;
    outline: none;
    resize: none;
    max-height: 44px;
    transition: border-color 0.15s;
  }
  #msg-input:focus { border-color: var(--accent); }
  #send-btn {
    background: var(--accent);
    border: none;
    border-radius: 50%;
    width: 40px; height: 40px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }
  #send-btn:hover { opacity: 0.85; }
  #send-btn svg { fill: white; }

  /* ── SIDEBAR ── */
  #sidebar {
    grid-area: sidebar;
    border-left: 1px solid var(--border);
    padding: 16px 12px;
    overflow-y: auto;
  }
  #sidebar h2 { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; margin-bottom: 12px; }
  .user-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    font-size: 0.83rem;
    font-weight: 600;
  }
  .user-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
</style>
</head>
<body>

<!-- LOBBY -->
<div id="lobby">
  <div class="lobby-card">
    <h1>chat<span>.</span></h1>
    <p>Ephemeral, real-time chat. No accounts. No logs beyond 50 messages.</p>
    <div class="field">
      <label>Your name</label>
      <input id="nick-input" maxlength="30" placeholder="e.g. alice" autocomplete="off">
    </div>
    <div class="field">
      <label>Room name</label>
      <input id="room-input" maxlength="40" value="general" autocomplete="off">
    </div>
    <button class="btn" id="join-btn">Join room →</button>
  </div>
</div>

<!-- APP -->
<div id="app">
  <div id="header">
    <div class="dot"></div>
    <div class="room-name">room: <span id="room-label"></span></div>
    <div id="status">connecting…</div>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="msg-input" rows="1" placeholder="Message…" maxlength="2000"></textarea>
    <button id="send-btn" aria-label="Send">
      <svg width="16" height="16" viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
    </button>
  </div>
  <div id="sidebar">
    <h2>Online</h2>
    <div id="user-list"></div>
  </div>
</div>

<script>
  let ws, myName;

  const $ = id => document.getElementById(id);

  $('join-btn').onclick = join;
  $('nick-input').onkeydown = e => e.key === 'Enter' && join();
  $('room-input').onkeydown = e => e.key === 'Enter' && join();

  function join() {
    const nick = $('nick-input').value.trim() || 'Anonymous';
    const room = $('room-input').value.trim() || 'general';
    myName = nick;
    $('room-label').textContent = room;
    $('lobby').style.display = 'none';
    $('app').style.display = 'grid';
    connect(nick, room);
  }

  function connect(nick, room) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = \`\${proto}://\${location.host}?room=\${encodeURIComponent(room)}&nick=\${encodeURIComponent(nick)}\`;
    ws = new WebSocket(url);

    ws.onopen = () => $('status').textContent = 'connected';
    ws.onclose = () => {
      $('status').textContent = 'disconnected — retrying…';
      setTimeout(() => connect(nick, room), 3000);
    };
    ws.onerror = () => ws.close();

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'history') {
        msg.messages.forEach(renderMsg);
      } else if (msg.type === 'chat') {
        renderMsg(msg);
      } else if (msg.type === 'system') {
        renderSystem(msg.text);
      } else if (msg.type === 'users') {
        renderUsers(msg.users);
      }
      scrollBottom();
    };
  }

  function renderMsg(msg) {
    const isOwn = msg.from === myName;
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap' + (isOwn ? ' own' : '');

    if (!isOwn) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = \`<span class="name" style="color:\${msg.color}">\${esc(msg.from)}</span><span>\${timeStr(msg.ts)}</span>\`;
      wrap.appendChild(meta);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.text;
    wrap.appendChild(bubble);
    $('messages').appendChild(wrap);
  }

  function renderSystem(text) {
    const el = document.createElement('div');
    el.className = 'system-msg';
    el.textContent = text;
    $('messages').appendChild(el);
  }

  function renderUsers(users) {
    $('user-list').innerHTML = users.map(u =>
      \`<div class="user-pill"><div class="user-dot" style="background:\${u.color}"></div>\${esc(u.name)}</div>\`
    ).join('');
  }

  function scrollBottom() {
    const el = $('messages');
    el.scrollTop = el.scrollHeight;
  }

  $('msg-input').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMsg();
    }
  };
  $('send-btn').onclick = sendMsg;

  function sendMsg() {
    const text = $('msg-input').value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', text }));
    $('msg-input').value = '';
  }

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function timeStr(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>
</body>
</html>`;
