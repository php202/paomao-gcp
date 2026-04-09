const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

// ========== 設定 ==========
const PORT = 3881;
const ESP32_IP = '192.168.1.88';
const ESP32_TOKEN = 'DashboardDoorGate';
const API_TOKEN = '1848c61bbc397d0ad30d4a8a66e8991f05bd8edda8a59f63cf145fae488568ad'; // 捷徑用 token
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小時 session

// LINE Login (共用 Dashboard 的 channel)
const LINE_LOGIN_CHANNEL_ID = '2009266159';
const LINE_LOGIN_CHANNEL_SECRET = 'ea42c85549c13a2e0ae55de0f05281bc';
const LINE_CALLBACK_URL = 'https://door.paopaomao.tw/auth/line/callback';

// 總公司授權名單 (line_user_id → name)
const ALLOWED_USERS = {
  'Ud77845386e2e6b3ceb79331978289809': '余宗翰',
  'Uad4c0502b77c034c49a7b035cca8c1c2': '余雪',
  'U4b497a559c3bef984946ab9f119dffe9': '宋丞晏',
  'Ud8a5ed234d183e522c1ecb78ab81f7b7': '林懿霏',
  'Ua28f877e1a64130043d2eab10098bcb4': '王健安',
  'U42ef60fa167a51093123408edc5b5932': '羅丞鈞',
  'U9b2c08d5f7d54ee24eb3647465be8727': '邱建豪',
  'Ub14b7bffeac04a4f964e59b508022674': '韓宥宏',
  'Uda8e60a7dc1f71531a04aca681521d5e': '黃家盈',
  'Uca39b77b520064a61e37bb404d6220c7': '黃翊慈',
};

// 簡易 session store: sid → { created, ip, lineUserId, displayName }
const sessions = new Map();

// Log
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(action, ip, extra = '') {
  const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const line = `[${ts}] ${action} from ${ip} ${extra}\n`;
  console.log(line.trim());
  const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line);
}

function genSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k && v.length) cookies[k] = v.join('=');
  });
  return cookies;
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies['door_session'];
  if (!sid || !sessions.has(sid)) return null;
  const session = sessions.get(sid);
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

// 轉發指令給 ESP32
async function sendToESP32(action) {
  const url = `http://${ESP32_IP}/${action}?token=${ESP32_TOKEN}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const text = await res.text();
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ========== LINE Login ==========
function getLineAuthUrl(state) {
  const params = querystring.stringify({
    response_type: 'code',
    client_id: LINE_LOGIN_CHANNEL_ID,
    redirect_uri: LINE_CALLBACK_URL,
    state,
    scope: 'profile openid',
  });
  return `https://access.line.me/oauth2/v2.1/authorize?${params}`;
}

async function exchangeLineToken(code) {
  const res = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: LINE_CALLBACK_URL,
      client_id: LINE_LOGIN_CHANNEL_ID,
      client_secret: LINE_LOGIN_CHANNEL_SECRET,
    }),
  });
  return res.json();
}

async function getLineProfile(accessToken) {
  const res = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}

// ========== HTML Pages ==========
function getLoginPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>泡泡貓大門控制</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
    h1 { font-size: 1.6rem; margin-bottom: 0.5rem; }
    .subtitle { color: #888; margin-bottom: 2rem; font-size: 0.9rem; }
    .line-btn { display: flex; align-items: center; gap: 10px; padding: 14px 32px; font-size: 1.1rem; font-weight: 700; border: none; border-radius: 12px; cursor: pointer; background: #06C755; color: #fff; text-decoration: none; transition: all 0.2s; }
    .line-btn:hover { background: #05b54d; transform: scale(1.02); }
    .line-btn svg { width: 24px; height: 24px; }
    .error { color: #fab1a0; font-size: 0.9rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>🐱 泡泡貓大門控制</h1>
  <p class="subtitle">僅限總公司人員使用</p>
  <a class="line-btn" href="/auth/line">
    <svg viewBox="0 0 24 24" fill="white"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
    用 LINE 登入
  </a>
</body>
</html>`;
}

function getUnauthorizedPage(name) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>無權限</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
    h1 { font-size: 1.6rem; margin-bottom: 1rem; }
    p { color: #888; margin-bottom: 2rem; }
    a { color: #00b894; }
  </style>
</head>
<body>
  <h1>⛔ 無權限</h1>
  <p>${name}，你不在授權名單中。</p>
  <a href="/">返回</a>
</body>
</html>`;
}

function getControlPage(displayName) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>泡泡貓大門控制</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
    h1 { font-size: 1.8rem; margin-bottom: 0.3rem; color: #e0e0e0; }
    .user { color: #888; margin-bottom: 2rem; font-size: 0.9rem; }
    .btn-group { display: flex; flex-direction: column; gap: 1.2rem; width: 280px; }
    .btn { padding: 1.2rem 2rem; font-size: 1.4rem; font-weight: 700; border: none; border-radius: 16px; cursor: pointer; transition: all 0.2s; color: #fff; letter-spacing: 2px; }
    .btn:active { transform: scale(0.96); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-open { background: linear-gradient(135deg, #00b894, #00cec9); box-shadow: 0 4px 15px rgba(0,184,148,0.4); }
    .btn-open:hover { box-shadow: 0 6px 20px rgba(0,184,148,0.6); }
    .btn-pause { background: linear-gradient(135deg, #fdcb6e, #e17055); box-shadow: 0 4px 15px rgba(225,112,85,0.4); }
    .btn-pause:hover { box-shadow: 0 6px 20px rgba(225,112,85,0.6); }
    .btn-close { background: linear-gradient(135deg, #d63031, #e74c3c); box-shadow: 0 4px 15px rgba(214,48,49,0.4); }
    .btn-close:hover { box-shadow: 0 6px 20px rgba(214,48,49,0.6); }
    #status { margin-top: 2rem; padding: 0.8rem 1.5rem; border-radius: 10px; font-size: 1rem; min-height: 2.8rem; text-align: center; transition: all 0.3s; }
    .status-ok { background: rgba(0,184,148,0.2); color: #55efc4; }
    .status-err { background: rgba(214,48,49,0.2); color: #fab1a0; }
    .status-loading { background: rgba(253,203,110,0.2); color: #ffeaa7; }
    .logout { margin-top: 2rem; color: #888; font-size: 0.85rem; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🐱 泡泡貓大門控制</h1>
  <p class="user">👤 ${displayName}</p>
  <div class="btn-group">
    <button class="btn btn-open" onclick="sendCmd('OPEN')">🔓 開啟</button>
    <button class="btn btn-pause" onclick="sendCmd('PAUSE')">⏸ 暫停</button>
    <button class="btn btn-close" onclick="sendCmd('CLOSE')">🔒 關閉</button>
  </div>
  <div id="status"></div>
  <div class="logout" onclick="location.href='/logout'">登出</div>
  <script>
    async function sendCmd(action) {
      const labels = { OPEN: '開啟', PAUSE: '暫停', CLOSE: '關閉' };
      const statusEl = document.getElementById('status');
      document.querySelectorAll('.btn').forEach(b => b.disabled = true);
      statusEl.className = 'status-loading';
      statusEl.textContent = '⏳ 正在發送' + labels[action] + '指令...';
      try {
        const res = await fetch('/api/door/' + action, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          statusEl.className = 'status-ok';
          statusEl.textContent = '✅ ' + labels[action] + '指令已執行';
        } else {
          statusEl.className = 'status-err';
          statusEl.textContent = '❌ 失敗：' + (data.error || 'ESP32 無回應');
        }
      } catch (err) {
        statusEl.className = 'status-err';
        statusEl.textContent = '❌ 網路錯誤';
      } finally {
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
      }
    }
  </script>
</body>
</html>`;
}

// ========== Server ==========
// CSRF state store
const pendingStates = new Map();

const server = http.createServer(async (req, res) => {
  const clientIp = getClientIp(req);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 首頁
  if (req.method === 'GET' && url.pathname === '/') {
    const session = getSession(req);
    if (session) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getControlPage(session.displayName));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getLoginPage());
    }
    return;
  }

  // LINE Login 導向
  if (req.method === 'GET' && url.pathname === '/auth/line') {
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now());
    // 清理超過 10 分鐘的 state
    for (const [s, t] of pendingStates) {
      if (Date.now() - t > 600000) pendingStates.delete(s);
    }
    res.writeHead(302, { Location: getLineAuthUrl(state) });
    res.end();
    return;
  }

  // LINE Login Callback
  if (req.method === 'GET' && url.pathname === '/auth/line/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state || !pendingStates.has(state)) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    pendingStates.delete(state);

    try {
      const tokenData = await exchangeLineToken(code);
      if (!tokenData.access_token) {
        log('LINE_LOGIN_FAIL', clientIp, 'no access_token');
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

      const profile = await getLineProfile(tokenData.access_token);
      const lineUserId = profile.userId;
      const displayName = profile.displayName;

      log('LINE_LOGIN', clientIp, `${displayName} (${lineUserId})`);

      // 檢查是否在授權名單
      if (!ALLOWED_USERS[lineUserId]) {
        log('UNAUTHORIZED', clientIp, `${displayName} (${lineUserId})`);
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getUnauthorizedPage(displayName));
        return;
      }

      // 建立 session
      const sid = genSessionId();
      sessions.set(sid, {
        created: Date.now(),
        ip: clientIp,
        lineUserId,
        displayName: ALLOWED_USERS[lineUserId], // 用中文名
      });

      res.writeHead(302, {
        'Set-Cookie': `door_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`,
        'Location': '/',
      });
      res.end();
    } catch (err) {
      log('LINE_LOGIN_ERROR', clientIp, err.message);
      res.writeHead(302, { Location: '/' });
      res.end();
    }
    return;
  }

  // 登出
  if (req.method === 'GET' && url.pathname === '/logout') {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies['door_session']) sessions.delete(cookies['door_session']);
    res.writeHead(302, {
      'Set-Cookie': 'door_session=; Path=/; Max-Age=0',
      'Location': '/',
    });
    res.end();
    return;
  }

  // API: 控制大門（session 登入 or Bearer token）
  if (req.method === 'POST' && url.pathname.startsWith('/api/door/')) {
    const bearerToken = (req.headers.authorization || '').replace('Bearer ', '');
    const hasValidToken = bearerToken === API_TOKEN;
    const session = getSession(req);

    if (!hasValidToken && !session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未登入' }));
      return;
    }

    const action = url.pathname.split('/').pop().toUpperCase();
    if (!['OPEN', 'PAUSE', 'CLOSE'].includes(action)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '無效指令' }));
      return;
    }

    const who = hasValidToken ? 'API-token' : session.displayName;
    log(`DOOR_${action}`, clientIp, `by ${who}`);
    const result = await sendToESP32(action);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🚪 Door control server running on port ${PORT}`);
});
