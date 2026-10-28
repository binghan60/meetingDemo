'use strict';
/*
 * 簡報伺服器：提供 index.html（簡報）、/remote（手機遙控與講稿），並用 WebSocket 同步兩邊。
 *
 *   簡報頁（role=deck）  → 傳目前頁碼、標題、講稿給伺服器
 *   手機頁（role=remote）→ 傳翻頁指令，收到簡報目前的頁碼與講稿
 *
 * 環境變數
 *   PORT        監聽埠（Zeabur 會自動帶入），預設 3000
 *   ACCESS_KEY  存取金鑰。設定後，第一次要用 ?key=金鑰 開啟網址，之後靠 cookie 記住。
 *               沒設定就不檢查，只適合在自己電腦上測試。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const ROOT = __dirname;
const COOKIE = 'deck_key';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

if (!ACCESS_KEY) {
  console.warn('[警告] 沒有設定 ACCESS_KEY，任何知道網址的人都能看簡報、看講稿、遙控翻頁。部署到外網前請先設定。');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}
function keyOk(candidate) {
  if (!ACCESS_KEY) return true;
  return crypto.timingSafeEqual(digest(candidate), digest(ACCESS_KEY));
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* 忽略壞掉的 cookie */ }
  });
  return out;
}

// 只提供 index.html 裡實際用到的圖片，避免把 img/ 裡沒放進簡報的原始截圖也公開出去
function referencedImages() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const found = new Set();
  const re = /img\/[^"'()\s<>]+\.(?:png|jpe?g|gif|webp|svg)/gi;
  let m;
  while ((m = re.exec(html))) found.add(m[0]);
  return found;
}

function sendFile(res, file, type, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到檔案'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  // 帶著 ?key= 進來：驗證後種 cookie，再導到不含金鑰的網址（避免金鑰留在網址列與瀏覽紀錄）
  const given = url.searchParams.get('key');
  if (given !== null && ACCESS_KEY && keyOk(given)) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    url.searchParams.delete('key');
    res.writeHead(302, {
      'Set-Cookie': COOKIE + '=' + encodeURIComponent(ACCESS_KEY) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + COOKIE_MAX_AGE + secure,
      Location: url.pathname + (url.search || '')
    });
    res.end();
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  if (!keyOk(cookies[COOKIE] || '')) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('需要存取金鑰。請用 ?key=金鑰 開啟網址。');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return sendFile(res, path.join(ROOT, 'index.html'), MIME['.html'], 'no-cache');
  }
  if (url.pathname === '/remote' || url.pathname === '/remote.html') {
    return sendFile(res, path.join(ROOT, 'remote.html'), MIME['.html'], 'no-cache');
  }
  if (url.pathname.startsWith('/img/')) {
    let rel;
    try { rel = decodeURIComponent(url.pathname.slice(1)); } catch (e) { rel = ''; }
    let allowed = false;
    try { allowed = referencedImages().has(rel); } catch (e) { /* 讀不到 index.html 就當作不允許 */ }
    if (allowed) {
      return sendFile(res, path.join(ROOT, rel), MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream', 'no-cache');
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('找不到頁面');
});

// ---- WebSocket ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const decks = new Set();
const remotes = new Set();
let lastState = null;

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(set, obj) {
  set.forEach((ws) => send(ws, obj));
}
function cleanString(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
function cleanState(m) {
  const index = Number.isInteger(m.index) ? m.index : 0;
  const total = Number.isInteger(m.total) ? m.total : 0;
  const lines = Array.isArray(m.lines) ? m.lines.slice(0, 500).map((l) => cleanString(l, 2000)) : [];
  return { type: 'state', index, total, title: cleanString(m.title, 200), lines };
}
function cleanCmd(m) {
  if (['next', 'prev', 'first', 'last'].includes(m.action)) return { type: 'cmd', action: m.action };
  if (m.action === 'goto' && Number.isInteger(m.index)) return { type: 'cmd', action: 'goto', index: m.index };
  return null;
}

function refuse(socket, code, text) {
  socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');

  // 只接受從本站頁面發起的連線，避免別的網站偷連
  if (req.headers.origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch (e) { /* 視為不同來源 */ }
    if (!sameOrigin) return refuse(socket, 403, 'Forbidden');
  }
  const cookies = parseCookies(req.headers.cookie);
  if (!keyOk(cookies[COOKIE] || '')) return refuse(socket, 401, 'Unauthorized');

  const role = url.searchParams.get('role');
  if (role !== 'deck' && role !== 'remote') return refuse(socket, 400, 'Bad Request');

  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, role));
});

function onConnect(ws, role) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const mine = role === 'deck' ? decks : remotes;
  mine.add(ws);

  if (role === 'remote') {
    send(ws, { type: 'presence', deck: decks.size > 0 });
    if (lastState) send(ws, lastState);
  } else {
    broadcast(remotes, { type: 'presence', deck: true });
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (role === 'deck' && msg.type === 'state') {
      lastState = cleanState(msg);
      broadcast(remotes, lastState);
    } else if (role === 'remote' && msg.type === 'cmd') {
      const cmd = cleanCmd(msg);
      if (cmd) broadcast(decks, cmd);
    }
  });

  ws.on('close', () => {
    mine.delete(ws);
    if (role === 'deck' && decks.size === 0) broadcast(remotes, { type: 'presence', deck: false });
  });
  ws.on('error', () => { /* close 事件會接著處理 */ });
}

// 定時 ping：偵測斷線的手機，也避免雲端代理因閒置而切線
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000).unref();

server.listen(PORT, () => {
  console.log('簡報伺服器已啟動：http://localhost:' + PORT + '/');
  console.log('手機遙控頁：http://localhost:' + PORT + '/remote' + (ACCESS_KEY ? '（第一次請加 ?key=你的金鑰）' : ''));
});
