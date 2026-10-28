'use strict';

// 💬 團隊中樞: groups and one-on-one chats with the Claude Code conversations on this
// computer, Gemini and imported web conversations.
//
//   啟動團隊中樞.bat  →  http://localhost:8300
//
// Only this computer can open it (it listens on 127.0.0.1 and checks the Host header, which
// also stops DNS rebinding), and only with the password printed in its window at start. The
// browser it opens itself signs in with a one-time link; a signed-in browser stays signed in
// for 7 days, across restarts. Every Claude or Gemini reply counts toward a daily token limit
// (on by default; changed in ⚙️ 設定). Data lives in data/ (not in git); keys in .env.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Hub } = require('./lib/hub');
const hubhttp = require('./lib/hubhttp');

const PAGE = path.join(__dirname, 'index.html');
const MAX_BODY = 64 * 1024;
const SESSION_DAYS = 7;
const ONCE_MS = 2 * 60 * 1000;
const DEFAULT_CAP = 3_000_000;
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // nothing that looks like something else
const STATUS = Symbol('status');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const token = () => crypto.randomBytes(24).toString('base64url');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
function newPassword() {
  const b = crypto.randomBytes(8);
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''); // typed with or without the dash
const readJson =(file, d) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return d; } };
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(v, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

// 🔢 Today's tokens (input + output of every reply) and the limit. Over the limit, no new
// replies start; one already running finishes.
class Budget {
  constructor(dir) {
    this.file = path.join(dir, 'usage.json');
    this.setFile = path.join(dir, 'settings.json');
    this.u = readJson(this.file, { day: today(), tokens: 0, calls: 0 });
    this.s = { capOn: true, cap: DEFAULT_CAP, ...readJson(this.setFile, {}) };
  }
  roll() { if (this.u.day !== today()) this.u = { day: today(), tokens: 0, calls: 0, by: {} }; }
  check() {
    this.roll();
    if (this.s.capOn && this.u.tokens >= this.s.cap) {
      throw bad(`今天的 Token 用量已到上限（${this.u.tokens.toLocaleString()} / ${this.s.cap.toLocaleString()}），明天會自動歸零；急用的話到「⚙️ 設定」調高上限`, 429);
    }
  }
  // who: 'claude', 'gemini', 'ollama'… — kept per brain too, for the usage block.
  add(r, who = 'other') {
    this.roll();
    const n = Math.max(0, Math.round(Number(r && r.input) || 0)) + Math.max(0, Math.round(Number(r && r.output) || 0));
    this.u.tokens += n;
    this.u.calls += 1;
    this.u.by = this.u.by || {};
    const b = this.u.by[who] || (this.u.by[who] = { tokens: 0, calls: 0 });
    b.tokens += n;
    b.calls += 1;
    writeJson(this.file, this.u);
  }
  view() { this.roll(); return { ...this.s, used: this.u.tokens, calls: this.u.calls, day: this.u.day }; }
  // Today per brain, and the Claude subscription's windows when the CLI has reported them (lib/llm.js).
  usage(limits) { this.roll(); return { day: this.u.day, by: this.u.by || {}, claude: limits || null }; }
  set({ capOn, cap } = {}) {
    if (capOn !== undefined) this.s.capOn = !!capOn;
    if (cap !== undefined) {
      const n = Number(cap);
      if (!Number.isInteger(n) || n < 10_000 || n > 1_000_000_000) throw bad('上限要是 10,000 到 1,000,000,000 之間的整數');
      this.s.cap = n;
    }
    writeJson(this.setFile, this.s);
    return this.view();
  }
  // call: { claude, gemini, ai } → the same, counted and stopped at the limit.
  guard(call) {
    const wrap = (fn, who) => async (a) => { this.check(); const r = await fn(a); this.add(r, typeof who === 'function' ? who(a) : who); return r; };
    return { claude: wrap(call.claude, 'claude'), gemini: wrap(call.gemini, 'gemini'), ai: wrap(call.ai, (a) => String((a && a.provider) || 'other')) };
  }
}

// 🔑 The password (new at every start), one-time sign-in links, and signed-in browsers.
class Auth {
  constructor(dir, password) {
    this.password = password || newPassword();
    this.file = path.join(dir, 'sessions.json');
    this.sessions = readJson(this.file, {}); // sha256(cookie) hex → expires at
    this.once = new Map(); // sha256(link) hex → expires at
    this.fails = [];
  }
  prune() {
    const t = Date.now();
    for (const [k, v] of Object.entries(this.sessions)) if (v < t) delete this.sessions[k];
    for (const [k, v] of this.once) if (v < t) this.once.delete(k);
  }
  onceLink() {
    const t = token();
    this.once.set(sha(t).toString('hex'), Date.now() + ONCE_MS);
    return t;
  }
  // { password } or { once } → a cookie value, or an error.
  login({ password, once } = {}) {
    this.prune();
    const t = Date.now();
    this.fails = this.fails.filter((x) => x > t - 60_000);
    if (this.fails.length >= 5) throw bad('密碼錯太多次了，請一分鐘後再試', 429);
    let ok = false;
    if (once) { const k = sha(once).toString('hex'); ok = this.once.has(k); this.once.delete(k); }
    else if (password) ok = crypto.timingSafeEqual(sha(norm(password)), sha(norm(this.password)));
    if (!ok) { this.fails.push(t); throw bad(once ? '這個登入連結已經用過或過期了，請輸入啟動視窗裡的密碼' : '密碼不對（密碼在「團隊中樞」的啟動視窗裡）', 401); }
    const c = token();
    this.sessions[sha(c).toString('hex')] = t + SESSION_DAYS * 86400_000;
    writeJson(this.file, this.sessions);
    return c;
  }
  logout(cookie) {
    if (!cookie) return;
    delete this.sessions[sha(cookie).toString('hex')];
    writeJson(this.file, this.sessions);
  }
  ok(cookie) {
    if (!cookie) return false;
    const exp = this.sessions[sha(cookie).toString('hex')];
    return !!exp && exp > Date.now();
  }
}

const cookieOf = (req) => (/(?:^|;\s*)lite=([\w-]+)/.exec(req.headers.cookie || '') || [])[1] || '';
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(bad('請求內容過大', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('JSON 格式錯誤')); }
    });
    req.on('error', reject);
  });
}

// dataDir, port, password, call ({ claude, gemini }, tests pass their own).
// limits / probe: the Claude subscription's usage as the CLI last reported it, and a fresh read (tests pass their own).
// 📂 Windows' own "choose a folder" window, opened on this computer. '' = the Chair closed it.
function pickFolderWindows() {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('只有 Windows 有選擇資料夾視窗，請直接貼上路徑'), { status: 400 }));
  // The owner window is shown first (topmost, activated) so the dialog opens in front of the browser, not behind it.
  const script = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $o=New-Object System.Windows.Forms.Form; $o.Text=\"選擇資料夾\"; $o.TopMost=$true; $o.ShowInTaskbar=$true; $o.StartPosition=\"CenterScreen\"; $o.Width=1; $o.Height=1; $o.Opacity=0; $o.Show(); $o.Activate(); $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description=\"選擇助手負責的資料夾\"; if($f.ShowDialog($o) -eq \"OK\"){ Write-Output $f.SelectedPath }; $o.Close()";
  return new Promise((resolve, reject) => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5 * 60 * 1000 }, (err, out) => {
      if (err) return reject(Object.assign(new Error('選擇資料夾視窗沒有成功開啟，請直接貼上路徑'), { status: 500 }));
      resolve(String(out || '').trim());
    });
  });
}

function createLite({ dataDir, port = 8300, password, call, limits, probe, connected, pick } = {}) {
  dataDir = dataDir || process.env.STUDIO_LITE_DATA || path.join(__dirname, 'data');
  if (!call) {
    const llm = require('./lib/llm');
    call = { claude: (a) => llm.claudeSession(a), gemini: (a) => llm.geminiChat(a), ai: (a) => llm.aiChat(a) };
    limits = limits || llm.claudeLimits;
    probe = probe || llm.probeClaudeLimits;
    connected = connected || llm.connected;
  }
  const limitsNow = () => (limits ? limits() : null);
  const budget = new Budget(dataDir);
  const auth = new Auth(dataDir, password);
  const actToken = crypto.randomBytes(24).toString('hex'); // this run only; never written to disk by the server
  const hub = new Hub({ dataDir, call: budget.guard(call), limits: limitsNow, connected, pick: pick === undefined ? pickFolderWindows : pick, act: { url: `http://127.0.0.1:${port}`, token: actToken } });
  const clients = new Set();
  hub.on('change', () => { for (const res of clients) res.write('event: hub\ndata: {}\n\n'); });
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const secure = (cookie, maxAge) => `lite=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

  const routes = {
    ...hubhttp.routes(hub, (r) => ({ [STATUS]: 202, body: r })),
    'GET /api/lite/usage': () => budget.usage(limitsNow()),
    // 📈 The ledger's reports: per chat, per member, per round, and the ten dearest calls.
    'GET /api/lite/ledger': () => {
      const rows = hub.ledger.rows();
      return { calls: rows.filter((r) => !r.event).length, rotations: rows.filter((r) => r.event === 'rotated'), byRoom: hub.ledger.groupBy('room', rows), byMember: hub.ledger.groupBy('member', rows), byRound: hub.ledger.groupBy('round', rows.filter((r) => r.purpose === 'reply')), byPurpose: hub.ledger.groupBy('purpose', rows), top: hub.ledger.topCalls(10, rows) };
    },
    // Reads the subscription's usage fresh: one tiny Claude call (a one-word reply from the small model).
    'POST /api/lite/usage/refresh': async () => {
      if (!probe) throw bad('這次啟動沒有連到 Claude，沒辦法刷新');
      await probe().catch(() => {});
      return budget.usage(limitsNow());
    },
    'GET /api/lite/settings': () => budget.view(),
    'POST /api/lite/settings': (body) => ({ ok: true, ...budget.set(body) }),
  };

  const server = http.createServer(async (req, res) => {
    // This computer only, under its own name (a page elsewhere renamed to 127.0.0.1 is refused).
    if (!LOOPBACK.test(req.socket.remoteAddress || '') || !hosts.has(String(req.headers.host || ''))) { json(res, 403, { error: '只有這台電腦可以開' }); return; }
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      fs.createReadStream(PAGE).pipe(res);
      return;
    }
    // ✋ A member's hands (lib/actserver.js) ask here, with this run's token instead of the password. It only
    // puts a card in front of the Chair; nothing happens until the Chair allows it in the page.
    if (p === '/api/act/ask' && req.method === 'POST') {
      const given = Buffer.from(String(req.headers['x-hub-act'] || ''));
      const real = Buffer.from(actToken);
      if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) { req.resume(); json(res, 403, { ok: false, error: '不認得這個呼叫' }); return; }
      try {
        const r = await hub.ask(await readBody(req));
        json(res, 200, r);
      } catch (e) { json(res, 200, { ok: false, error: e.message }); }
      return;
    }
    // Every write: the custom header (no cross-site form can send it) and, when sent, our own Origin.
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (req.headers['x-studio-hq'] !== 'ceo' || (origin && !hosts.has(origin.replace(/^http:\/\//, '')))) { req.resume(); json(res, 403, { error: '請從團隊中樞的頁面操作' }); return; }
    }
    if (p === '/api/login' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const c = auth.login(body);
        json(res, 200, { ok: true }, { 'set-cookie': secure(c, SESSION_DAYS * 86400) });
      } catch (e) { json(res, e.status || 400, { ok: false, error: e.message }); }
      return;
    }
    const signed = auth.ok(cookieOf(req));
    if (p === '/api/me') { json(res, 200, { ok: true, signedIn: signed }); return; }
    if (!signed) { req.resume(); json(res, 401, { ok: false, error: '請先輸入密碼', login: true }); return; }
    if (p === '/api/logout' && req.method === 'POST') { auth.logout(cookieOf(req)); json(res, 200, { ok: true }, { 'set-cookie': secure('x', 0) }); return; }
    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('event: hub\ndata: {}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (await hubhttp.raw(hub, req, res, url, json)) return;
    const handler = routes[`${req.method} ${p}`];
    if (!handler) { res.writeHead(404).end(); return; }
    try {
      const out = await handler(req.method === 'POST' ? await readBody(req) : {}, url);
      if (out && out[STATUS]) json(res, out[STATUS], out.body);
      else json(res, 200, out);
    } catch (e) {
      json(res, e.status || 400, { ok: false, error: e.message });
    }
  });
  // A quiet heartbeat keeps the event stream from being cut by idle timeouts.
  const beat = setInterval(() => { for (const res of clients) res.write(': \n\n'); }, 25_000);
  beat.unref();
  server.on('close', () => clearInterval(beat));
  return { server, hub, auth, budget, port };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

function main() {
  const argv = process.argv.slice(2);
  const port = Number(process.env.STUDIO_LITE_PORT || 8300);
  const lite = createLite({ port });
  lite.server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`連接埠 ${port} 已經有人在用：團隊中樞可能已經開著了，打開 http://localhost:${port} 就好。`);
    process.exit(3);
  });
  const crashLog = path.join(path.dirname(lite.hub.file), 'crash.log');
  const recent = [];
  const oops = (kind) => (e) => {
    const line = `[${new Date().toISOString()}] ${kind}: ${(e && e.stack) || e}\n`;
    console.error(line);
    try { fs.appendFileSync(crashLog, line); } catch {}
    recent.push(Date.now());
    while (recent.length && recent[0] < Date.now() - 60000) recent.shift();
    if (recent.length > 10) { console.error('一分鐘內錯誤太多，團隊中樞先停下來。'); process.exit(1); }
  };
  process.on('uncaughtException', oops('uncaughtException'));
  process.on('unhandledRejection', oops('unhandledRejection'));
  lite.server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`💬 團隊中樞 → ${url}`);
    console.log(`🔑 這次的密碼：${lite.auth.password}（只有這台電腦打得開；別的瀏覽器第一次開要輸入）`);
    const b = lite.budget.view();
    console.log(`🔢 今天的 Token：${b.used.toLocaleString()}${b.capOn ? ` / 上限 ${b.cap.toLocaleString()}` : '（沒有上限）'}`);
    if (!argv.includes('--no-open')) openBrowser(`${url}/#once=${lite.auth.onceLink()}`);
  });
  const bye = (code) => { lite.server.close(); process.exit(code); };
  process.on('SIGINT', () => bye(0));
  process.on('SIGTERM', () => bye(0));
}

if (require.main === module) main();

module.exports = { createLite, newPassword };
