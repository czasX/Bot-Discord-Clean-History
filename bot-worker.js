/* ==========================================================
   VxC Clean Bot – chạy trong Web Worker
   Kết nối thẳng Discord Gateway WebSocket + REST API
   ========================================================== */

let ws = null;
let token = null;
let heartbeatTimer = null;
let seq = null;
let sessionId = null;
let resumeUrl = null;
let botUserId = null;
let botTag = null;
let running = false;

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2,
  RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11
};

function send(obj){ if(ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function log(msg){ self.postMessage({ type: 'log', data: msg }); }
function status(cls, txt){ self.postMessage({ type: 'status', data: { cls, txt } }); }

// ==== REST helpers ====
async function api(path, method='GET', body=null){
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + token,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if(!res.ok){
    const txt = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${txt.slice(0,150)}`);
  }
  if(res.status === 204) return null;
  return res.json();
}

// ==== Parse thời gian: 30s / 1mins / 2hours / 1d ====
function parseDuration(str){
  if(!str) return 0;
  const m = str.trim().match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days)$/i);
  if(!m) return 0;
  const n = parseInt(m[1]), u = m[2].toLowerCase();
  if(u.startsWith('s')) return n*1000;
  if(u.startsWith('m')) return n*60000;
  if(u.startsWith('h')) return n*3600000;
  if(u.startsWith('d')) return n*86400000;
  return 0;
}

// ==== Đăng ký slash command global ====
async function registerCommand(){
  const appId = decodeTokenAppId(token);
  await api(`/applications/${appId}/commands`, 'POST', {
    name: 'vxcclean',
    description: 'Xoá tin nhắn của user trong khoảng thời gian (chỉ owner)',
    options: [
      { name: 'user', description: 'Người cần xoá tin nhắn', type: 6, required: true },
      { name: 'history', description: 'Thời gian (VD: 1mins, 30s, 2hours)', type: 3, required: true }
    ]
  });
  log('✅ Đã đăng ký /vxcclean (có thể mất ~1 phút để Discord cập nhật).');
}

function decodeTokenAppId(tok){
  try {
    const first = tok.split('.')[0];
    return atob(first);
  } catch { return null; }
}

// ==== Xử lý interaction ====
async function handleInteraction(data){
  if(data.type !== 2) return; // chỉ slash command
  if(data.data.name !== 'vxcclean') return;

  const guildId = data.guild_id;
  const userId = data.member?.user?.id;
  const channelId = data.channel_id;
  const appId = data.application_id;
  const itk = data.token;

  const reply = (content, ephemeral=true) =>
    api(`/interactions/${data.id}/${itk}/callback`, 'POST', {
      type: 4,
      data: { content, flags: ephemeral ? 64 : 0 }
    });

  try {
    // Lấy guild info để check owner
    const guild = await api(`/guilds/${guildId}`);
    if(userId !== guild.owner_id){
      return reply('❌ Chỉ **owner server** mới được dùng lệnh này!');
    }

    const opts = data.data.options || [];
    const userOpt = opts.find(o => o.name === 'user');
    const histOpt = opts.find(o => o.name === 'history');
    const targetId = userOpt.value;
    const histStr = histOpt.value;
    const ms = parseDuration(histStr);
    if(ms <= 0) return reply('❌ Sai thời gian! VD: `1mins`, `30s`, `2hours`, `1d`');

    await reply('⏳ Đang quét và xoá...', true);

    const cutoff = Date.now() - ms;
    let deleted = 0, scanned = 0, lastId = null, keep = true;

    while(keep && scanned < 1000){
      const qs = new URLSearchParams({ limit: '100' });
      if(lastId) qs.set('before', lastId);
      const msgs = await api(`/channels/${channelId}/messages?${qs}`);
      if(!msgs.length) break;

      const toDel = msgs.filter(m =>
        m.author.id === targetId &&
        new Date(m.timestamp).getTime() >= cutoff
      );

      if(toDel.length === 1){
        await api(`/channels/${channelId}/messages/${toDel[0].id}`, 'DELETE');
        deleted++;
      } else if(toDel.length > 1){
        const older = toDel.filter(m => Date.now() - new Date(m.timestamp).getTime() >= 14*86400000);
        const fresh = toDel.filter(m => Date.now() - new Date(m.timestamp).getTime() < 14*86400000);
        if(fresh.length >= 2){
          await api(`/channels/${channelId}/messages/bulk-delete`, 'POST', { messages: fresh.map(m=>m.id) });
          deleted += fresh.length;
        } else if(fresh.length === 1){
          await api(`/channels/${channelId}/messages/${fresh[0].id}`, 'DELETE');
          deleted++;
        }
        for(const m of older){
          try { await api(`/channels/${channelId}/messages/${m.id}`, 'DELETE'); deleted++; } catch{}
        }
      }

      scanned += msgs.length;
      lastId = msgs[msgs.length - 1].id;
      if(new Date(msgs[msgs.length-1].timestamp).getTime() < cutoff) keep = false;
    }

    // Cập nhật tin nhắn ephemeral
    await api(`/webhooks/${appId}/${itk}/messages/@original`, 'PATCH', {
      content: `✅ Đã xoá **${deleted}** tin nhắn của <@${targetId}> trong \`${histStr}\` gần nhất.`
    });
    log(`[CLEAN] Xoá ${deleted} tin của ${targetId} trong ${histStr}`);
  } catch(err){
    log('Lỗi xử lý interaction: ' + err.message);
    try {
      await api(`/webhooks/${appId}/${itk}/messages/@original`, 'PATCH', {
        content: '❌ Lỗi: ' + err.message
      });
    } catch{}
  }
}

// ==== Kết nối Gateway ====
function connect(){
  ws = new WebSocket(resumeUrl || GATEWAY);

  ws.onopen = () => log('🔌 WebSocket mở.');
  ws.onclose = (e) => {
    log(`WebSocket đóng (${e.code}). Thử lại sau 5s...`);
    if(running) setTimeout(connect, 5000);
  };
  ws.onerror = (e) => log('WebSocket lỗi.');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const { op, d, s, t } = msg;
    if(s) seq = s;

    if(op === OP.HELLO){
      const interval = d.heartbeat_interval;
      log('HELLO – heartbeat ' + interval + 'ms');
      startHeartbeat(interval);
      if(sessionId && resumeUrl) sendResume();
      else sendIdentify();
    }
    else if(op === OP.DISPATCH){
      if(t === 'READY'){
        sessionId = d.session_id;
        resumeUrl = d.resume_gateway_url + '/?v=10&encoding=json';
        botUserId = d.user.id;
        botTag = d.user.username;
        log(`✅ Bot online: ${botTag}`);
        status('on', '🟢 Bot đang chạy: ' + botTag);
        registerCommand().catch(e => log('Lỗi đăng ký command: ' + e.message));
      }
      else if(t === 'INTERACTION_CREATE'){
        handleInteraction(d);
      }
    }
    else if(op === OP.HEARTBEAT_ACK){ /* ok */ }
    else if(op === OP.RECONNECT){
      log('Discord yêu cầu reconnect.');
      ws.close();
    }
    else if(op === OP.INVALID_SESSION){
      log('Session invalid – identify lại.');
      sessionId = null; resumeUrl = null;
      setTimeout(sendIdentify, 2000);
    }
  };
}

function startHeartbeat(ms){
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => send({ op: OP.HEARTBEAT, d: seq }), ms);
}

function sendIdentify(){
  send({
    op: OP.IDENTIFY,
    d: {
      token,
      intents: 1 | 512 | 32768, // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
      properties: { os: 'browser', browser: 'VxC', device: 'web' }
    }
  });
  log('Đã gửi IDENTIFY.');
}

function sendResume(){
  send({
    op: 6,
    d: { token, session_id: sessionId, seq }
  });
  log('Đã gửi RESUME.');
}

// ==== Nhận lệnh từ main thread ====
self.onmessage = (e) => {
  const { type } = e.data;
  if(type === 'start'){
    token = e.data.token;
    running = true;
    connect();
  } else if(type === 'stop'){
    running = false;
    clearInterval(heartbeatTimer);
    if(ws){ try{ ws.close(); }catch{} ws = null; }
    log('Worker dừng.');
  }
};
