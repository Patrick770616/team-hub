'use strict';

// 💬 Team Chat Hub: group chats and one-on-one chats with the Chair's own AI conversations.
//
// Members are the Claude Code conversations already on this computer (found in
// ~/.claude/projects) and Gemini. A Claude member joins a chat as a fork of its
// conversation (`claude --resume <id> --fork-session`), made once and reused: it
// remembers everything said there, but nothing said in the hub is written to the
// original record (its hash is checked around every turn). Forks only read (Read,
// Glob, Grep). Gemini is called directly, with the group's project notes as its
// background, and everything sent to it is masked for keys and local paths.
//
// "💾 總結並寫入記憶" has Gemini boil a chat down; the summary is written to each Claude
// member's project memory folder (~/.claude/projects/<project>/memory/), where its next
// conversation picks it up, never to CLAUDE.md (that one is in git). Chats live in
// data/hub.json (not in git) and only the Chair sees them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const webimport = require('./webimport');

const PROJECTS = () => process.env.STUDIO_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const FORK_PREFIX = '💬 群組分身';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GEMINI = { id: 'gemini', kind: 'gemini', name: 'Gemini', title: 'Gemini（API）' };
const CONSENSUS = /【(達成共識|無其他異議)】/;
const MAX_ROUNDS = 3; // 自主協商: each member speaks at most this many times per topic
const MAX_MESSAGES = 500; // kept per chat
const HASH_LIMIT = 2 * 1024 ** 3; // bigger records are compared by size and time only
const NOTES = ['PROJECT_NOTES.md', 'CLAUDE.md', 'README.md'];
// 📎 Attachments: screenshots, PDFs and text files the Chair drops into a chat.
const MAX_FILE = 15 * 1024 * 1024;
const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const DOC = { pdf: 'application/pdf' };
const TEXT = /^(txt|md|markdown|json|csv|tsv|log|xml|ya?ml|toml|ini|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|kt|go|rs|rb|php|cs|cpp|c|h|hpp|swift|dart|sql|sh|bat|ps1)$/;
const { isSecretPath } = require('./secrets');
const act = require('./act');
// 🔄 When a Claude conversation is started over (STUDIO_ROTATE=0 turns this off). Numbers are in tokens of context
// growth since the member's first turn in that conversation; they are estimates — tune them with the ledger.
const ROT = { growth: 30_000, turns: 25, turnsGrowth: 8_000, idleMs: 5 * 60_000, idleGrowth: 15_000 };
const RECENT = 12; // messages kept verbatim after a restart; older ones go into the summary
const SUMMARY_CHARS = 800;
const ROLE_CHARS = 600; // a generated role prompt (a role may be up to 1000)
const { Ledger } = require('./ledger');
const AUTO_MAX = 40; // most actions one member may run on its own in a single turn
const CARD_MS =Number(process.env.STUDIO_CARD_MS || 10 * 60_000); // an unanswered card is cancelled after this
const AI_NAMES = { ollama: 'Ollama（本機）', openai: 'OpenAI 相容服務', antigravity: 'Antigravity（Google AI Pro）' };
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build', 'venv']);
const WS_FILES = 3000; // an assistant's folder copy: at most this many files…
const WS_BYTES = 100 * 1024 * 1024; // …and this many bytes
const extOf = (name) => ((/\.([A-Za-z0-9]+)$/.exec(name) || [])[1] || '').toLowerCase();
const kindOf = (name) => { const e = extOf(name); return IMAGE[e] ? 'image' : DOC[e] ? 'pdf' : TEXT.test(e) ? 'text' : null; };
const mimeOf = (name) => { const e = extOf(name); return IMAGE[e] || DOC[e] || 'text/plain; charset=utf-8'; };

// ------------------------------------------------------------ masking (what goes to Gemini)

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];
const KEY_LINE = /\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|_PIN)[A-Za-z0-9_]*)(\s*[=:]\s*)["']?[^\s"'<]{4,}["']?/gi;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mask(text) {
  let s = String(text || '');
  for (const re of SECRETS) s = s.replace(re, '<已遮蔽的金鑰>');
  s = s.replace(KEY_LINE, '$1$2<已遮蔽>');
  const home = os.homedir();
  for (const h of new Set([home, home.replace(/\\/g, '/')])) s = s.replace(new RegExp(escRe(h), 'gi'), '<LOCAL_PATH>');
  return s.replace(/\b[A-Z]:[\\/]Users[\\/][^\\/\s"'<>]+/gi, '<LOCAL_PATH>').replace(/\/(?:Users|home)\/[^/\s"'<>]+/g, '<LOCAL_PATH>');
}

// ------------------------------------------------------------ the conversations on this computer

function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}
const lines = (text) => text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const userText = (j) => {
  const c = j && j.message && j.message.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text : '';
  return String(t || '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim();
};

// One record: only its first and last stretch are read (records reach hundreds of MB).
function sessionInfo(file, st) {
  const head = lines(readSlice(file, 0, Math.min(st.size, 256 * 1024)));
  const tail = st.size > 256 * 1024 ? lines(readSlice(file, Math.max(0, st.size - 512 * 1024), 512 * 1024)) : head;
  const cwd = (head.find((j) => j.cwd) || tail.find((j) => j.cwd) || {}).cwd;
  if (!cwd) return null;
  const titled = [...tail].reverse().find((j) => j.type === 'custom-title' && j.customTitle);
  const first = head.find((j) => j.type === 'user' && userText(j));
  const title = titled ? titled.customTitle : first ? userText(first).slice(0, 40) : '（沒有標題）';
  return { id: path.basename(file, '.jsonl'), title, cwd, project: path.basename(path.dirname(file)), size: st.size, mtime: st.mtimeMs };
}

let scanCache = new Map(); // file → { key, info }
function scanSessions() {
  const root = PROJECTS();
  const out = [];
  const next = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.jsonl') && SESSION_ID.test(f.slice(0, -6))); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, d.name, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const key = `${st.size}:${st.mtimeMs}`;
      const hit = scanCache.get(file);
      let info = hit && hit.key === key ? hit.info : null;
      if (!info) { try { info = sessionInfo(file, st); } catch { info = null; } }
      next.set(file, { key, info });
      if (info && !info.title.startsWith(FORK_PREFIX)) out.push({ ...info, file });
    }
  }
  scanCache = next;
  return out.sort((a, b) => b.mtime - a.mtime);
}

// A record's fingerprint: the full SHA-1 (small enough) or its size and time.
function fingerprint(file) {
  return new Promise((resolve) => {
    let st;
    try { st = fs.statSync(file); } catch { return resolve(null); }
    if (st.size > HASH_LIMIT) return resolve(`size:${st.size}:${st.mtimeMs}`);
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(null));
  });
}

// ------------------------------------------------------------ the hub

const now = () => Date.now();
const rid = () => crypto.randomBytes(6).toString('hex');
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

class Hub extends EventEmitter {
  // call: { claude(args) → { text, sessionId }, gemini(args) → { text } } (tests pass their own)
  // act: { url, token } — where a member's hands (lib/actserver.js) call back; without it nobody can be given them.
  // limits: () → the Claude subscription's usage as last reported (for the ledger's before/after).
  // connected: () → { claude, gemini, ollama, openai, antigravity: true/false } — which brains are set up (tests: all).
  constructor({ dataDir, call, act, limits, connected, pick } = {}) {
    super();
    this.pick = pick || null; // () => Promise<folder path or ''>: the computer's own folder dialog
    this.connected = connected || null;
    this.limitsNow = limits || null;
    this.actCfg = act || null;
    this.pending = new Map(); // card id → { card, c, m, root, input, resolve, timer }: only in memory
    this.file = path.join(dataDir || path.join(__dirname, 'data'), 'hub.json');
    this.filesDir = path.join(path.dirname(this.file), 'hub', 'files');
    if (!call) {
      const llm = require('./llm');
      call = { claude: (a) => llm.claudeSession(a), gemini: (a) => llm.geminiChat(a), ai: (a) => llm.aiChat(a) };
      this.connected = this.connected || llm.connected;
    }
    this.call = call;
    this.ledger = new Ledger(path.join(path.dirname(this.file), 'hub', 'usage.jsonl'));
    this.assistantsDir = path.join(path.dirname(this.file), 'hub', 'assistants');
    this.members = [];
    this.channels = [];
    this.geminiWeb = false; // may Gemini use Google Search
    this.busy = new Map(); // channel id → member id speaking now
    this.autoN = new Map(); // member id → actions run on its own this turn (see AUTO_MAX)
    this.stopped = new Set();
    this.queues = new Map();
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.members = Array.isArray(j.members) ? j.members : [];
      this.channels = Array.isArray(j.channels) ? j.channels : [];
      this.geminiWeb = !!j.geminiWeb;
      // A card nobody answered before the last stop can never be allowed any more.
      for (const c of this.channels) for (const x of c.messages) if (x.card && x.card.status === 'pending') { x.card.status = 'expired'; x.card.result = '中樞重開了，這張卡已作廢'; }
    } catch {}
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ members: this.members, channels: this.channels, geminiWeb: this.geminiWeb }, null, 1));
    fs.renameSync(tmp, this.file);
  }
  changed() { this.save(); this.emit('change'); }

  member(id) {
    if (id === 'gemini') return { ...GEMINI, web: this.geminiWeb };
    return this.members.find((m) => m.id === id) || null;
  }
  channel(id) {
    const c = this.channels.find((x) => x.id === id);
    if (!c) throw bad('找不到這個聊天室', 404);
    return c;
  }

  // The left column: members, chats (without their messages) and the conversations that can be bound.
  view() {
    return {
      members: [this.member('gemini'), ...this.members],
      channels: this.channels.map((c) => ({
        id: c.id, kind: c.kind, name: c.name, members: c.members, mode: c.mode,
        last: c.messages.length ? { from: c.messages[c.messages.length - 1].from, text: c.messages[c.messages.length - 1].text.slice(0, 60), at: c.messages[c.messages.length - 1].at } : null,
        busy: this.busy.get(c.id) || null,
      })),
    };
  }
  sessions() {
    const bound = new Set(this.members.map((m) => m.sessionId));
    return scanSessions().map(({ file, ...s }) => ({ ...s, bound: bound.has(s.id) }));
  }
  channelView(id) {
    const c = this.channel(id);
    return { ...c, busy: this.busy.get(c.id) || null, members: c.members.map((m) => this.member(m)).filter(Boolean) };
  }

  // 📥 Bind a conversation on this computer as a member.
  bind(sessionId) {
    if (!SESSION_ID.test(String(sessionId || ''))) throw bad('對話編號格式不正確');
    const have = this.members.find((m) => m.sessionId === sessionId);
    if (have) return have;
    const s = scanSessions().find((x) => x.id === sessionId);
    if (!s) throw bad('這台電腦上找不到這個 Claude 對話', 404);
    const m = { id: `c-${sessionId.slice(0, 8)}`, kind: 'claude', sessionId, name: s.title.slice(0, 24), title: s.title, cwd: s.cwd, project: s.project, at: now() };
    this.members.push(m);
    this.changed();
    return m;
  }
  // 📚 Phase 2: conversations from the web versions (claude.ai, ChatGPT, Gemini) can't be forked —
  // they don't live on this computer. The Chair's data export is read here, and each chosen
  // conversation becomes a member answered by Gemini from a summary of it (its "memory").
  importFile(name, buf) {
    const list = webimport.parse(buf, name);
    const id = rid();
    const dir = path.join(path.dirname(this.file), 'hub', 'imports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(list));
    const have = new Set(this.members.map((m) => m.key).filter(Boolean));
    return {
      importId: id,
      conversations: list.map((c) => ({ key: c.key, title: c.title, source: c.source, date: c.date, count: c.messages.length, chars: c.messages.reduce((n, m) => n + m.text.length, 0), bound: have.has(c.key) })),
    };
  }
  async importPick(importId, keys) {
    if (!/^[0-9a-f]{12}$/.test(String(importId || ''))) throw bad('匯入編號不正確');
    let list;
    try { list = JSON.parse(fs.readFileSync(path.join(path.dirname(this.file), 'hub', 'imports', `${importId}.json`), 'utf8')); } catch { throw bad('找不到這次匯入，請重新選檔案', 404); }
    const chosen = list.filter((c) => (keys || []).includes(c.key)).slice(0, 10);
    if (!chosen.length) throw bad('請至少勾一段對話（一次最多 10 段）');
    const out = [];
    for (const c of chosen) {
      const had = this.members.find((m) => m.key === c.key);
      if (had) { out.push(had); continue; }
      out.push(await this.webMember(c));
    }
    return out;
  }
  async importPaste({ title, text, source } = {}) {
    title = String(title || '').trim().slice(0, 60);
    text = String(text || '').trim();
    if (!title) throw bad('請幫這段對話取個名字');
    if (text.length < 20) throw bad('貼上的內容太短了');
    const c = { key: `paste:${rid()}`, title, source: String(source || '網頁版').slice(0, 20), date: new Date().toISOString().slice(0, 10), messages: [{ role: 'user', text: text.slice(0, 200_000) }] };
    return this.webMember(c);
  }
  async webMember(c) {
    const res = await this.call.gemini({
      system: '你在幫主席整理他在 AI 網頁版上的一段對話，做成之後討論用的背景記憶。用繁體中文，最多 1500 字，只寫對話裡真的有的內容，不要推測。格式：\n## 主題\n## 已經決定的事\n## 重要細節（名稱、數字、規格、網址）\n## 還沒完成的事\n## 主席的偏好與習慣',
      prompt: mask(`對話「${c.title}」（${c.source}，${c.date}）：\n\n${webimport.transcript(c)}`), maxTokens: 2500,
    });
    this.record({ room: `匯入：${c.title}`, kind: 'import', mode: 'summary', round: 0, member: 'Gemini', memberId: 'gemini', brain: 'gemini', purpose: 'summary' }, res, null, 0);
    const digest = String(res.text || '').trim();
    if (!digest) throw bad(`「${c.title}」整理不出摘要，先略過`);
    const m = { id: `w-${rid().slice(0, 8)}`, kind: 'web', key: c.key, name: c.title.slice(0, 24), title: c.title, source: c.source, date: c.date, digest, at: now() };
    this.members.push(m);
    this.changed();
    return m;
  }

  // 🤖 A brand-new Claude assistant: a role, optionally a folder to read (a filtered, read-only copy,
  // see syncWorkspace) and its own conversation, kept so it remembers what it said in the chats.
  // brain: who answers — 'claude' (default: folder copy, own memory, can be given hands) or 'gemini' / 'ollama' /
  // 'openai' / 'antigravity' (role and chat only; Gemini may also search the web). Chosen once: a Claude assistant
  // has its own conversation, so switching brains would make it someone else.
  addAssistant({ name, role, folder, web, brain, model } = {}) {
    brain = String(brain || 'claude');
    if (!BRAINS[brain]) throw bad('不認得這個大腦');
    model = String(model || '');
    if (model && !CLAUDE_MODELS[model]) throw bad('不認得這個模型');
    if (model && brain !== 'claude') throw bad('只有 Claude 助手可以選模型（其他大腦的模型在 .env 設定）');
    this.needBrain(brain);
    name = String(name || '').trim().slice(0, 24);
    role = String(role || '').trim().slice(0, 1000);
    if (!name) throw bad('助手要有名字');
    if (!role) throw bad('請寫下助手的角色（它負責做什麼）');
    if (this.members.some((m) => m.name === name) || name === GEMINI.name) throw bad('已經有同名的成員了');
    folder = String(folder || '').trim();
    if (folder && brain !== 'claude') throw bad('只有 Claude 助手可以指定負責的資料夾（其他大腦沒有只讀的檔案工具）');
    if (web && brain !== 'claude' && brain !== 'gemini') throw bad(`${BRAINS[brain]}不能上網`);
    if (folder) this.checkFolder(folder);
    const m = { id: `a-${rid().slice(0, 8)}`, kind: 'assistant', brain, model, name, title: name, role, folder: folder ? path.resolve(folder) : '', web: !!web, sessionId: null, at: now() };
    this.members.push(m);
    this.changed();
    return m;
  }
  updateAssistant(id, { role, web, model, folder } = {}) {
    const m = this.members.find((x) => x.id === id && x.kind === 'assistant');
    if (!m) throw bad('找不到這位助手', 404);
    if (role !== undefined) {
      role = String(role || '').trim().slice(0, 1000);
      if (!role) throw bad('角色不能是空的');
      m.role = role;
    }
    if (model !== undefined) {
      model = String(model || '');
      if (model && !CLAUDE_MODELS[model]) throw bad('不認得這個模型');
      if (model && brainOf(m) !== 'claude') throw bad('只有 Claude 助手可以選模型');
      m.model = model;
    }
    if (folder !== undefined) {
      if (brainOf(m) !== 'claude') throw bad('只有 Claude 助手可以指定負責的資料夾');
      folder = String(folder || '').trim();
      const dir = folder ? this.checkFolder(folder) : '';
      if (dir !== m.folder) {
        m.folder = dir;
        // The permission to change files was given for the old folder; a new folder needs a fresh yes.
        if (m.act) this.setAct(m.id, false);
      }
    }
    if (web !== undefined) {
      if (web && brainOf(m) !== 'claude' && brainOf(m) !== 'gemini') throw bad(`${BRAINS[brainOf(m)]}不能上網`);
      m.web = !!web;
    }
    this.changed();
    return m;
  }
  // 📂 The computer's own folder dialog, for the Chair to pick a folder instead of typing its path.
  async pickFolder() {
    if (!this.pick) throw bad('這台電腦的選擇資料夾視窗無法使用，請直接貼上路徑');
    return { ok: true, folder: String(await this.pick() || '') };
  }
  // ✨ From the Chair's plain description of the job, a role prompt for a new assistant. Gemini writes it
  // (the free allowance, not the Claude subscription); the Chair edits it before creating the assistant.
  async draftRole({ name, job, brain } = {}) {
    job = String(job || '').trim();
    name = String(name || '').trim().slice(0, 24);
    brain = String(brain || 'claude');
    if (!BRAINS[brain]) throw bad('不認得這個大腦');
    if (job.length < 4) throw bad('請先用幾句話寫下助手的主要工作');
    if (job.length > 1500) throw bad('描述太長了（最多 1500 字）');
    const claude = brain === 'claude';
    const res = await this.call.gemini({
      system: `你幫主席替一位 AI 助手（大腦：${BRAINS[brain]}）寫「角色提示詞」。助手在一個多人 AI 群組討論程式裡，會被 @ 點名回答，也可能一對一聊天${claude ? '，可以讀它負責的資料夾（唯讀副本）' : '，只能依聊天室最近的對話回答，沒有檔案工具'}。
寫法：用第二人稱（「你是…」），繁體中文，${ROLE_CHARS} 字以內，不要標題、不要說明、不要程式碼區塊。
內容依序涵蓋：1. 身分與主要工作 2. 具體該做的事（3 到 5 點，從主席的描述推導，不要憑空增加主席沒提的職責） 3. 回答風格（精簡、先講結論、不確定就說不確定、不編造） 4. 界線（沒有主席同意不修改檔案或執行指令；看不到的內容不要猜）。${claude ? `
最後另起一行，依工作難度建議 Claude 模型，格式固定：【建議模型】haiku【理由】一句話
選法：haiku＝機械性、整理、分類、翻譯、短回應；sonnet＝一般分析、寫程式、審查；opus＝複雜架構取捨、深度推理、高風險判斷。拿不準就選 sonnet。` : ''}`,
      prompt: mask(`助手的名字：${name || '（未命名）'}
主席描述的主要工作：
${job}`), maxTokens: 1200,
    });
    this.record({ room: '（設定角色）', kind: 'setup', mode: 'summary', round: 0, member: 'Gemini', memberId: 'gemini', brain: 'gemini', purpose: 'role', promptChars: job.length }, res, null, 0);
    let text = String(res.text || '').replace(/^```[a-z]*\n?|\n?```$/gi, '').trim();
    // The suggested model rides on the last line; it is a suggestion only (the Chair can change it).
    let model = '';
    let modelReason = '';
    const tag = /【建議模型】\s*(haiku|sonnet|opus)\s*(?:【理由】\s*([^\n]*))?/i.exec(text);
    if (tag) {
      if (claude) { model = tag[1].toLowerCase(); modelReason = (tag[2] || '').trim().slice(0, 80); }
      text = text.replace(tag[0], '').trim();
    }
    const role = text.slice(0, 1000);
    if (!role) throw bad('沒有生成出內容，請再試一次或自己寫');
    return { role, model, modelReason };
  }
  // The brains that can be chosen, and whether each is set up. The page offers only the ones that are.
  brains() {
    let on = {};
    try { on = this.connected ? this.connected() : null; } catch { on = {}; }
    const llm = require('./llm');
    return Object.entries(BRAINS).map(([id, name]) => ({ id, name, ok: on === null ? true : !!on[id], hint: llm.CONNECT_HINT[id], ...(id === 'claude' ? { defaultModel: llm.defaults().claude, models: Object.entries(MODEL_NOTE).map(([k, note]) => ({ id: k, name: note })) } : {}) }));
  }
  // 🔌 Another brain as a member (answers from the chat only; no files, no commands).
  addAi(provider) {
    if (!AI_NAMES[provider]) throw bad('這種 AI 不能加入團隊中樞');
    this.needBrain(provider);
    const id = `ai-${provider}`;
    const have = this.members.find((m) => m.id === id);
    if (have) return have;
    const m = { id, kind: 'ai', provider, name: AI_NAMES[provider], title: AI_NAMES[provider], at: now() };
    this.members.push(m);
    this.changed();
    return m;
  }
  // 🌐 Let a member look things up on the web. Claude members: WebSearch／WebFetch; Gemini: Google Search.
  setWeb(id, on) {
    if (id === 'gemini') this.geminiWeb = !!on;
    else {
      const m = this.members.find((x) => x.id === id);
      if (!m) throw bad('找不到這位成員', 404);
      if (!isClaudeish(m) && !(m.kind === 'assistant' && m.brain === 'gemini')) throw bad('這位成員不能上網');
      m.web = !!on;
    }
    this.changed();
    return { ok: true, web: !!on };
  }
  // ✋ Phase 3. Let a Claude member change files and run commands — only ever through a card: the hub shows
  // what it wants (the real content), the Chair presses ✅ once, and the hub itself does exactly that and
  // nothing else. Claude's own Edit/Write/Bash stay off; its hands are the three tools of lib/actserver.js.
  setAct(id, on) {
    const m = this.members.find((x) => x.id === id);
    if (!m || !isClaudeish(m)) throw bad('只有 Claude 成員可以改檔和執行指令');
    if (on && !this.actCfg) throw bad('這次啟動沒有開啟改檔功能');
    if (on && !this.rootOf(m)) throw bad('這位助手沒有指定負責的資料夾，沒有地方可以改');
    m.act = !!on;
    if (!on) { m.safe = false; m.auto = false; this.denyPending((p) => p.m.id === m.id, '主席關掉了這位成員的改檔權限'); }
    this.changed();
    return { ok: true, act: m.act };
  }
  // 🛡 "Safe commands run without a card": only the look-only list of act.isSafe, only while hands are on.
  setSafe(id, on) {
    const m = this.members.find((x) => x.id === id);
    if (!m || !isClaudeish(m)) throw bad('只有 Claude 成員可以改檔和執行指令');
    if (on && !m.act) throw bad('要先開啟「✋ 可動手」');
    m.safe = !!on;
    this.changed();
    return { ok: true, safe: m.safe };
  }
  // ⚡ Full auto: what passes the program's rules runs without a card; the rest (danger, secrets, outside the folder) still asks.
  setAuto(id, on) {
    const m = this.members.find((x) => x.id === id);
    if (!m || !isClaudeish(m)) throw bad('只有 Claude 成員可以改檔和執行指令');
    if (on && !m.act) throw bad('要先開啟「✋ 可動手」');
    m.auto = !!on;
    this.changed();
    return { ok: true, auto: m.auto };
  }
  rootOf(m) { return m.kind === 'assistant' ? m.folder : m.cwd; }
  // What the CLI needs to start this member's hands for this turn (undefined = none).
  actArgs(c, m) { return m.act && this.actCfg ? { url: this.actCfg.url, token: this.actCfg.token, channelId: c.id, memberId: m.id } : undefined; }

  // A hand reaches out: { channelId, memberId, tool, input } → resolves { ok, text } once the Chair decides.
  async ask({ channelId, memberId, tool, input } = {}) {
    const c = this.channels.find((x) => x.id === channelId);
    const m = this.members.find((x) => x.id === memberId);
    if (!c || !m || !m.act || !c.members.includes(m.id) || this.busy.get(c.id) !== m.id) return { ok: false, error: '現在沒有開放這位成員改檔' };
    const root = this.rootOf(m);
    if (!root || !fs.existsSync(root)) return { ok: false, error: '專案資料夾不見了' };
    input = input && typeof input === 'object' ? input : {};
    const card = { id: rid() + rid(), tool, member: m.id, status: 'pending', danger: [], at: now() };
    const why = String(input.why ?? '').trim().slice(0, 300); // the member's own words: shown, never trusted
    if (why) card.why = why;
    const refuse = (why) => { card.status = 'auto-denied'; card.result = why; this.say(c, 'system', `✋ ${m.name} 想要動手，被程式規則擋下：${why}`, { card }); this.changed(); return { ok: false, error: `被擋下：${why}` }; };
    try {
      if (tool === 'edit_file' || tool === 'write_file') {
        const { abs, rel } = act.resolveInside(root, input.path);
        card.path = rel;
        if (tool === 'edit_file') {
          const old = String(input.old ?? '');
          const neu = String(input.new ?? '');
          if (!old) throw new Error('要取代的原文不能是空的');
          if (old.length > 100_000 || neu.length > 100_000) throw new Error('一次改的內容太長了');
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('找不到這個檔案');
          const text = fs.readFileSync(abs, 'utf8');
          const n = text.split(old).length - 1;
          if (n !== 1) throw new Error(n ? '要取代的原文在檔案裡出現了不只一次，請多帶一些前後文' : '檔案裡找不到要取代的原文');
          card.line = text.slice(0, text.indexOf(old)).split('\n').length;
          card.old = old; card.new = neu;
        } else {
          const content = String(input.content ?? '');
          if (content.length > 200_000) throw new Error('檔案內容太長了（最多 20 萬字）');
          card.existed = fs.existsSync(abs);
          if (card.existed && !fs.statSync(abs).isFile()) throw new Error('這個路徑是資料夾');
          if (card.existed) { const cur = fs.readFileSync(abs, 'utf8'); card.before = cur.slice(0, 20_000); card.beforeLen = cur.length; }
          card.content = content.slice(0, 20_000); card.contentLen = content.length;
        }
      } else if (tool === 'run_command') {
        const command = String(input.command ?? '').trim();
        if (!command) throw new Error('指令是空的');
        if (command.length > 4000) throw new Error('指令太長了');
        card.command = command;
        card.danger = act.classify(command, root);
      } else throw new Error('不支援這個動作');
    } catch (e) { return refuse(e.message); }
    // Runs without a card when the Chair allowed it: a look-only command (🛡), or anything that passed the program's
    // rules (⚡ full auto: no danger mark, nothing outside the folder, no secret file — those still ask). Edits are
    // backed up either way. A runaway member falls back to asking after AUTO_MAX of these in one turn.
    const safeCmd = tool === 'run_command' && m.safe && !card.danger.length && act.isSafe(card.command, root);
    const fullAuto = m.auto && !card.danger.length;
    if ((safeCmd || fullAuto) && (this.autoN.get(m.id) || 0) < AUTO_MAX) {
      this.autoN.set(m.id, (this.autoN.get(m.id) || 0) + 1);
      card.auto = true; card.status = 'allowed'; card.result = '執行中…';
      this.say(c, 'system', `✋ ${m.name} ${tool === 'run_command' ? '執行了一個指令' : tool === 'write_file' ? `${card.existed ? '覆蓋' : '建立'}了檔案` : '修改了檔案'}（${safeCmd && !m.auto ? '唯讀安全指令，自動放行' : '⚡ 全自動'}）。`, { card });
      try {
        const text = await this.perform({ card, root, input });
        card.status = 'allowed'; card.result = String(text).slice(0, 4000); card.decidedAt = now();
        this.changed();
        return { ok: true, text: String(text) };
      } catch (e) {
        card.status = 'error'; card.result = `執行失敗：${e.message}`; card.decidedAt = now();
        this.changed();
        return { ok: false, error: card.result };
      }
    }
    const what = tool === 'run_command' ? '執行指令' : tool === 'write_file' ? `${card.existed ? '覆蓋' : '建立'}檔案` : '修改檔案';
    this.say(c, 'system', `✋ ${m.name} 想要${what}，等主席按「允許」或「拒絕」。`, { card });
    this.changed();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.close(card.id, 'expired', '主席沒有在 10 分鐘內處理，已取消'), CARD_MS);
      timer.unref();
      this.pending.set(card.id, { card, c, m, root, input, resolve, timer });
    });
  }
  // Settle a pending card for good (once): the member hears the answer.
  close(id, status, result, ok = false) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.card.status = status;
    p.card.result = String(result).slice(0, 4000);
    p.card.decidedAt = now();
    this.changed();
    p.resolve({ ok, text: ok ? String(result) : `主席沒有同意：${result}`, error: ok ? undefined : String(result) });
    return true;
  }
  denyPending(match, why) {
    for (const p of [...this.pending.values()]) if (!p.running && match(p)) this.close(p.card.id, 'denied', why);
  }
  // The Chair's answer to one card. Each card id works once; what is done is what the card shows.
  async decide(cardId, decision, { confirmDanger = false } = {}) {
    const p = this.pending.get(String(cardId || ''));
    if (!p || p.running) throw bad('這張卡已經處理過、取消或過期了', 404);
    if (decision !== 'allow') { this.close(p.card.id, 'denied', '主席拒絕了'); return { ok: true, status: 'denied' }; }
    if (p.card.danger.length && !confirmDanger) throw bad('這是危險動作：請勾選「我看過完整指令，了解風險」才能允許');
    p.running = true; // a second click on the same card finds it taken
    clearTimeout(p.timer);
    let text;
    try { text = await this.perform(p); } catch (e) {
      this.close(p.card.id, 'error', `執行失敗：${e.message}`);
      return { ok: true, status: 'error' };
    }
    this.close(p.card.id, 'allowed', text, true);
    return { ok: true, status: 'allowed' };
  }
  async perform({ card, root, input }) {
    if (card.tool === 'run_command') {
      const r = await act.runCommand(card.command, root);
      const out = mask(r.out).trim();
      card.exit = r.code;
      return `${r.timedOut ? '（超過 60 秒，已強制結束）' : ''}結束代碼 ${r.code}${out ? `\n${out}` : '（沒有輸出）'}`;
    }
    const { abs, rel } = act.resolveInside(root, card.path); // checked again at the moment of acting
    const backup = path.join(path.dirname(this.file), 'hub', 'backups', card.id);
    const save = (text) => { const tmp = `${abs}.hub-tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, abs); };
    if (card.tool === 'edit_file') {
      const text = fs.readFileSync(abs, 'utf8');
      if (text.split(card.old).length - 1 !== 1) throw new Error('檔案在這段時間內被改過，找不到原文了');
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, path.basename(abs)), text);
      save(text.replace(card.old, () => card.new));
      return `已修改 ${rel}（第 ${card.line} 行附近）`;
    }
    const content = String(input.content ?? '');
    if (fs.existsSync(abs)) { fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(abs, path.join(backup, path.basename(abs))); }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    save(content);
    return `已${card.existed ? '覆蓋' : '建立'} ${rel}（${content.length} 字）`;
  }

  needBrain(id) {
    const b = this.brains().find((x) => x.id === id);
    if (b && !b.ok) throw bad(`${b.name} 還沒串接（${b.hint}）`);
  }
  checkFolder(folder) {
    const dir = path.resolve(folder);
    let st;
    try { st = fs.statSync(dir); } catch { throw bad('找不到這個資料夾'); }
    if (!st.isDirectory()) throw bad('這不是資料夾');
    const home = os.homedir();
    const within = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
    if (path.parse(dir).root === dir || path.relative(dir, home) === '') throw bad('範圍太大了，請指定專案資料夾（不是磁碟機根目錄或使用者主資料夾）');
    if (within(dir, path.dirname(this.file)) || within(path.dirname(this.file), dir)) throw bad('不能指定通訊中樞自己的資料夾');
    return dir;
  }
  // The assistant's working copy of its folder: data/hub/assistants/<id>/workspace. Only files that pass
  // isSecretPath (the one shared rule, with the path relative to the folder) and the upload types
  // (text, images, PDF) are copied, so the assistant's Read/Glob/Grep simply cannot reach the rest. Refreshed
  // before every turn. Links are not followed.
  syncWorkspace(m) {
    const dest = path.join(this.assistantsDir, m.id, 'workspace');
    fs.mkdirSync(dest, { recursive: true });
    if (!m.folder) return { dir: dest, files: 0, skipped: 0 };
    const want = new Map(); // relative path → source stat
    let skipped = 0;
    let bytes = 0;
    const walk = (rel) => {
      let list = [];
      try { list = fs.readdirSync(path.join(m.folder, rel), { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (isSecretPath(r) || e.isSymbolicLink() || SKIP_DIRS.has(e.name)) { skipped++; continue; }
        if (e.isDirectory()) { walk(r); continue; }
        if (!e.isFile() || !kindOf(e.name)) { skipped++; continue; }
        const st = fs.statSync(path.join(m.folder, r));
        if (st.size > MAX_FILE || want.size >= WS_FILES || bytes + st.size > WS_BYTES) { skipped++; continue; }
        bytes += st.size;
        want.set(r, st);
      }
    };
    walk('');
    // Drop what is gone or no longer allowed, copy what is new or changed.
    const prune = (rel) => {
      for (const e of fs.readdirSync(path.join(dest, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { prune(r); if (!fs.readdirSync(path.join(dest, r)).length) fs.rmdirSync(path.join(dest, r)); } else if (!want.has(r)) fs.rmSync(path.join(dest, r), { force: true });
      }
    };
    prune('');
    for (const [r, st] of want) {
      const to = path.join(dest, r);
      let have = null;
      try { have = fs.statSync(to); } catch {}
      if (have && have.size === st.size && have.mtimeMs >= st.mtimeMs) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(m.folder, r), to);
    }
    return { dir: dest, files: want.size, skipped };
  }

  unbind(id) {
    if (this.channels.some((c) => c.kind === 'group' && c.members.includes(id))) throw bad('先把他從群組移出（或刪掉群組）再解除綁定');
    const gone = this.members.find((m) => m.id === id);
    this.denyPending((p) => p.m.id === id, '成員被移除了');
    if (gone && gone.kind === 'assistant') fs.rmSync(path.join(this.assistantsDir, gone.id), { recursive: true, force: true });
    this.members = this.members.filter((m) => m.id !== id);
    this.channels = this.channels.filter((c) => !(c.kind === 'dm' && c.members[0] === id));
    this.changed();
    return { ok: true };
  }

  createGroup({ name, members, mode = 'mention' } = {}) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) throw bad('群組要有名字');
    const ids = [...new Set(Array.isArray(members) ? members : [])].filter((id) => this.member(id));
    if (ids.length < 2) throw bad('群組至少要有兩位成員');
    const c = { id: `g-${rid()}`, kind: 'group', name, members: ids, mode: mode === 'auto' ? 'auto' : 'mention', messages: [], forks: {}, seen: {}, at: now() };
    this.channels.push(c);
    this.say(c, 'system', `群組「${name}」成立，成員：${ids.map((id) => this.member(id).name).join('、')}。${c.mode === 'auto' ? '自主協商模式：你出題，大家輪流發言。' : '點名模式：@ 誰誰就發言。'}`);
    this.changed();
    return c;
  }
  // 1 對 1: one chat per member, made on first open.
  dm(memberId) {
    const m = this.member(memberId);
    if (!m) throw bad('找不到這位成員', 404);
    let c = this.channels.find((x) => x.kind === 'dm' && x.members[0] === m.id);
    if (!c) {
      c = { id: `d-${m.id}`, kind: 'dm', name: m.name, members: [m.id], mode: 'mention', messages: [], forks: {}, seen: {}, at: now() };
      this.channels.push(c);
      this.changed();
    }
    return c;
  }
  // 👥 Add or remove members of a group. A newcomer reads the chat so far on its first turn;
  // someone who comes back reuses the fork it had.
  setMembers(id, members) {
    const c = this.channel(id);
    if (c.kind !== 'group') throw bad('私聊不能加成員，請另外建群組');
    const ids = [...new Set(Array.isArray(members) ? members : [])].filter((x) => this.member(x));
    if (ids.length < 2) throw bad('群組至少要有兩位成員');
    const added = ids.filter((x) => !c.members.includes(x));
    const gone = c.members.filter((x) => !ids.includes(x));
    c.members = ids;
    if (added.length) this.say(c, 'system', `👋 ${added.map((x) => this.member(x).name).join('、')} 加入群組（第一次發言時會看到之前的對話）。`);
    if (gone.length) this.say(c, 'system', `👋 ${gone.map((x) => this.member(x).name).join('、')} 離開群組。`);
    this.changed();
    return { ok: true, members: ids };
  }
  setMode(id, mode) {
    const c = this.channel(id);
    c.mode = mode === 'auto' ? 'auto' : 'mention';
    this.say(c, 'system', c.mode === 'auto' ? '切換成自主協商：你出題後，大家輪流發言（最多 3 輪）。' : '切換成點名模式：@ 誰誰才發言。');
    this.changed();
    return { ok: true, mode: c.mode };
  }
  remove(id) {
    const c = this.channel(id);
    this.denyPending((p) => p.c === c, '聊天室被刪除了');
    this.channels = this.channels.filter((x) => x !== c);
    this.changed();
    return { ok: true };
  }
  stop(id) {
    this.channel(id);
    this.stopped.add(id);
    this.denyPending((p) => p.c.id === id, '主席按了停止');
    return { ok: true };
  }

  // 📎 Keep an uploaded file for a chat: data/hub/files/<id>/<name>. → { id, name, kind, size }
  upload(channelId, name, buf) {
    this.channel(channelId);
    name = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(-120) || 'file';
    if (isSecretPath(name)) throw bad('這個檔名看起來是金鑰、密碼檔或隱藏檔，為了安全不收');
    const kind = kindOf(name);
    if (!kind) throw bad('只收圖片（png、jpg、gif、webp）、PDF 和文字檔（txt、md、json、csv、程式碼…）');
    if (!buf || !buf.length) throw bad('檔案是空的');
    if (buf.length > MAX_FILE) throw bad('檔案太大了（最多 15 MB）');
    const id = rid();
    fs.mkdirSync(path.join(this.filesDir, id), { recursive: true });
    fs.writeFileSync(path.join(this.filesDir, id, name), buf);
    return { id, name, kind, size: buf.length };
  }
  fileOf(id) {
    if (!/^[0-9a-f]{12}$/.test(String(id || ''))) return null;
    const dir = path.join(this.filesDir, id);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    if (names.length !== 1) return null;
    const name = names[0];
    return { id, name, kind: kindOf(name), mime: mimeOf(name), path: path.join(dir, name), size: fs.statSync(path.join(dir, name)).size };
  }

  say(c, from, text, extra = {}) {
    const msg = { id: rid(), from, text: String(text), at: now(), ...extra };
    c.messages.push(msg);
    if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
    return msg;
  }

  // The Chair speaks. Who answers: the member of a 1 對 1; in a group, whoever is @-mentioned
  // (@全部 for everyone) or, in 自主協商, everyone in turn. → { queued: [member ids] }
  post(id, text, fileIds = []) {
    const c = this.channel(id);
    text = String(text || '').trim();
    const files = (Array.isArray(fileIds) ? fileIds : []).slice(0, 10).map((f) => this.fileOf(f)).filter(Boolean)
      .map(({ id: fid, name, kind, size }) => ({ id: fid, name, kind, size }));
    if (!text && !files.length) throw bad('訊息是空的');
    if (text.length > 8000) throw bad('訊息太長了（最多 8000 字）');
    this.say(c, 'chair', text, files.length ? { files } : {});
    this.stopped.delete(c.id);
    let who = [];
    if (c.kind === 'dm') who = [c.members[0]];
    else if (c.mode === 'auto') who = c.members;
    else who = /@(全部|all)(?![A-Za-z0-9_])/i.test(text) ? c.members : c.members.filter((m) => text.includes(`@${this.member(m).name}`));
    if (c.kind === 'group' && c.mode === 'mention' && !who.length) this.say(c, 'system', '沒有 @ 任何人，所以沒有人回覆。用 @名字 點名，或 @全部。');
    this.changed();
    const run = c.mode === 'auto' && c.kind === 'group' ? () => this.discuss(c, who) : () => this.turns(c, who);
    const prev = this.queues.get(c.id) || Promise.resolve();
    const done = prev.then(run, run).catch(() => {});
    this.queues.set(c.id, done);
    return { ok: true, queued: who, done };
  }

  async turns(c, who) {
    for (const m of who) {
      if (this.stopped.has(c.id)) break;
      await this.turn(c, m);
    }
  }
  // 自主協商: rounds of everyone in turn, until all say 【達成共識】 in the same round, the
  // round limit, or the Chair presses stop.
  async discuss(c, who) {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const replies = [];
      for (const m of who) {
        if (this.stopped.has(c.id)) { this.say(c, 'system', '⏹ 主席喊停，討論先到這裡。'); this.changed(); return; }
        replies.push(await this.turn(c, m, { round }));
      }
      if (replies.every((r) => r && CONSENSUS.test(r.text))) { this.say(c, 'system', `🤝 第 ${round} 輪大家都表示達成共識，討論結束。可以按「💾 總結並寫入記憶」。`); this.changed(); return; }
    }
    this.say(c, 'system', `⏱ 到了回合上限（${MAX_ROUNDS} 輪），討論先停在這裡。要繼續就再丟一句話。`);
    this.changed();
  }

  // What a member hasn't seen yet, as one prompt.
  // reset: the member's conversation was just restarted (see rotateCheck) — it gets the summary and the
  // last stretch of the chat, its own lines included, instead of only what it hasn't seen.
  // What a member has missed since it last spoke (its own words and system lines left out).
  missed(c, m) {
    const from = c.seen[m.id] || 0;
    return c.messages.filter((x) => x.at > from).filter((x) => x.from !== m.id && x.from !== 'system');
  }
  // 📬 Catch-up cap: a Claude member that missed a lot is not fed all of it, only the summary of the older part
  // plus the last RECENT messages (its live conversation re-reads everything it is given, every turn).
  // Gemini and the other brains already get just the last 30 messages, so this is for Claude members only.
  needsCatchup(c, m) {
    return process.env.STUDIO_CATCHUP !== '0' && isClaudeish(m) && this.missed(c, m).length > RECENT;
  }
  promptFor(c, m, { round, reset = false, summary = '', catchup = false } = {}) {
    const missed = this.missed(c, m);
    const capped = !reset && catchup && missed.length > RECENT;
    const fresh = reset
      ? c.messages.filter((x) => x.from !== 'system' && !x.error).slice(-RECENT)
      : capped ? missed.slice(-RECENT) : missed;
    const names = c.members.map((id) => (this.member(id) || { name: id }).name).join('、');
    const attach = (x) => (x.files || []).map((f) => {
      const file = this.fileOf(f.id);
      if (!file) return `\n📎 附件「${f.name}」（檔案已不在）`;
      return isClaudeish(m) ? `\n📎 附件「${f.name}」（${f.kind === 'image' ? '圖片' : f.kind === 'pdf' ? 'PDF' : '文字檔'}）：${file.path} ← 請用 Read 工具打開來看` : `\n📎 附件「${f.name}」（內容附在這則訊息裡）`;
    }).join('');
    const lines = fresh.map((x) => `[${x.from === 'chair' ? '主席' : (this.member(x.from) || { name: x.from }).name}] ${x.text}${attach(x)}`).join('\n\n');
    const said = reset
      ? `（你的對話剛被重新開始，以節省訂閱額度。下面是前情摘要和最近的對話，請接續討論。）\n\n${summary ? `【前情摘要】\n${summary}\n\n` : ''}【最近的對話】\n${lines}`
      : capped
      ? `（你有一陣子沒發言，漏掉了 ${missed.length} 則訊息；為了節省額度，只給你前情摘要和最近 ${RECENT} 則。）\n\n${summary ? `【前情摘要】\n${summary}\n\n` : ''}【最近的對話】\n${lines}`
      : lines;
    const first = !c.forks[m.id] && m.kind === 'claude';
    const can = `這裡只能看檔案${m.web ? '和上網查資料（WebSearch／WebFetch）' : ''}，不能修改檔案或執行指令。`;
    const abilities = first ? `你現在是原本對話的分身：帶著原本的記憶，但在這裡說的話不會回到原本的對話。${can}` : m.kind === 'assistant' && isClaudeish(m) && !m.sessionId ? can : '';
    const hands = this.actArgs(c, m)
      ? `你有三個工具可以動手：edit_file（改檔）、write_file（寫檔）、run_command（執行指令），路徑都相對於專案資料夾${m.kind === 'assistant' ? '（你看到的是資料夾的副本，改動會套用到真正的資料夾，副本在你下次發言前更新）' : ''}。每一次都要主席在畫面上按「允許」才會執行（主席若開了安全放行或全自動，不危險的動作會直接執行，但危險指令、金鑰檔、資料夾以外的路徑一定還是要問）。請每次都在 why 欄位用一句白話說明你為什麼要做、做完會怎樣，主席不一定看得懂程式。也可能被拒絕或被程式規則擋下；被拒絕就不要用同樣的方式再試。除此之外你不能改檔或執行指令。` : '';
    const intro = c.kind === 'group'
      ? `（這是「💬 團隊通訊中樞」的群組「${c.name}」，成員：主席、${names}。你是「${m.name}」。${abilities}${hands}用繁體中文、精簡回覆（300 字內），針對別人的論點回應。${c.mode === 'auto' ? `這是自主協商第 ${round} 輪；如果你認為已經沒有異議，在回覆最後寫【達成共識】。` : ''}）`
      : `（這是「💬 團隊通訊中樞」的 1 對 1 聊天。${abilities}${hands}用繁體中文回覆。）`;
    return { intro, said, fresh };
  }

  async turn(c, memberId, opts = {}) {
    const m = this.member(memberId);
    if (!m) return null;
    this.busy.set(c.id, m.id);
    this.autoN.delete(m.id);
    this.emit('change');
    // A Claude conversation that has grown a lot costs more every turn: start it over, then catch it up.
    const rot = isClaudeish(m) ? this.rotateCheck(c, m) : null;
    const catchup = !rot && this.needsCatchup(c, m);
    const summary = rot || catchup ? await this.summarize(c) : '';
    const { intro, said, fresh } = this.promptFor(c, m, { ...opts, reset: !!rot, summary, catchup });
    const upto = c.messages.length ? c.messages[c.messages.length - 1].at : 0; // seen up to here
    const before = this.pct();
    const t0 = now();
    const meta = { room: c.name, roomId: c.id, kind: c.kind, mode: c.kind === 'dm' ? 'dm' : c.mode, round: opts.round || 1, member: m.name, memberId: m.id, brain: brainOf(m), purpose: 'reply', ...(catchup ? { catchup: true } : {}), promptChars: said.length + intro.length, attachmentBytes: fresh.flatMap((x) => x.files || []).reduce((n, f) => n + (f.size || 0), 0) };
    try {
      let reply;
      if (m.kind === 'claude') reply = await this.claudeTurn(c, m, `${intro}\n\n${said || '（請接著發言）'}`);
      else if (isClaudeish(m)) reply = await this.assistantTurn(c, m, `${intro}\n\n${said || '（請接著發言）'}`);
      else reply = await this.geminiTurn(c, m, intro, fresh);
      c.seen[m.id] = upto;
      this.record(meta, reply.usage, before, now() - t0);
      return this.say(c, m.id, reply.text.trim() || '（沒有回覆內容）', reply.extra || {});
    } catch (e) {
      c.seen[m.id] = upto;
      this.record({ ...meta, error: true }, null, before, now() - t0);
      return this.say(c, m.id, `${m.name}這次沒有回覆成功：${String(e.message || e).slice(0, 300)}`, { error: true });
    } finally {
      this.denyPending((p) => p.c === c && p.m.id === m.id, '這一輪已經結束');
      this.busy.delete(c.id);
      this.changed();
    }
  }

  // 🔄 Session rotation. A Claude conversation re-reads its whole context each turn (cheap while cached, dear when
  // it grows or goes cold), and the chat log here is the real record, so rather than compress it we start over:
  // a bound member forks the ORIGINAL conversation again (never the grown fork), an assistant opens a new one.
  // What counts is the growth since the first turn (a big original conversation is big from the start, and
  // restarting from it would gain nothing): context (input + cache) now minus context at the first turn.
  stateOf(c, m) { return m.kind === 'assistant' ? m.state : (c.fstate || {})[m.id]; }
  trackCtx(c, m, res) {
    let st = this.stateOf(c, m);
    if (!st) {
      st = { turns: 0, base: (res && res.input) || 0 };
      if (m.kind === 'assistant') m.state = st; else (c.fstate || (c.fstate = {}))[m.id] = st;
    }
    st.turns++;
    st.ctx = (res && res.input) || 0;
    st.at = now();
  }
  rotateCheck(c, m) {
    if (process.env.STUDIO_ROTATE === '0') return null;
    const live = m.kind === 'assistant' ? m.sessionId : c.forks[m.id];
    const st = this.stateOf(c, m);
    if (!live || !st) return null;
    const grown = (st.ctx || 0) - (st.base || 0);
    let why = null;
    if (grown > ROT.growth) why = '累積的內容太多了';
    else if (st.turns >= ROT.turns && grown > ROT.turnsGrowth) why = '已經聊了很多輪';
    else if (now() - st.at > ROT.idleMs && grown > ROT.idleGrowth) why = '閒置太久（快取已過期）而且內容不少';
    if (!why) return null;
    if (m.kind === 'assistant') { m.sessionId = null; m.state = null; } else { delete c.forks[m.id]; delete (c.fstate || {})[m.id]; }
    this.ledger.log({ event: 'rotated', room: c.name, roomId: c.id, member: m.name, memberId: m.id, reason: why, ctx: st.ctx, base: st.base, turns: st.turns });
    this.say(c, 'system', `🔄 ${m.name} 的 Claude 對話${why}，已重新開始：用摘要和最近的對話接續（省訂閱額度，聊天紀錄不受影響）。`);
    this.changed();
    return why;
  }
  // The chat before the last RECENT messages, boiled down by Gemini (not Claude: that is the allowance being saved).
  // Kept on the chat, so the next restart only adds what is new. No Gemini → the recent messages alone.
  async summarize(c) {
    const talk = c.messages.filter((x) => x.from !== 'system' && !x.error);
    const old = talk.slice(0, Math.max(0, talk.length - RECENT));
    if (!old.length) return '';
    const upTo = old[old.length - 1].at;
    if (c.summaryUpTo === upTo) return c.summary || '';
    const fresh = old.filter((x) => x.at > (c.summaryUpTo || 0));
    const name = (x) => (x.from === 'chair' ? '主席' : (this.member(x.from) || { name: x.from }).name);
    try {
      const res = await this.call.gemini({
        system: `把群組討論壓成「前情摘要」，繁體中文，${SUMMARY_CHARS} 字內。只留：已做的決定、還沒解決的問題、各人的立場、重要的數字和名稱。不要寒暄。`,
        prompt: mask(`【舊摘要】\n${c.summary || '（無）'}\n\n【新的對話】\n${fresh.map((x) => `[${name(x)}] ${x.text}`).join('\n\n')}`), maxTokens: 1500,
      });
      this.record({ room: c.name, roomId: c.id, kind: c.kind, mode: 'summary', round: 0, member: 'Gemini', memberId: 'gemini', brain: 'gemini', purpose: 'summary', promptChars: fresh.length }, res, null, 0);
      const text = String(res.text || '').trim().slice(0, SUMMARY_CHARS * 2);
      if (!text) return c.summary || '';
      c.summary = text;
      c.summaryUpTo = upTo;
      return text;
    } catch { return c.summary || ''; }
  }

  // 📈 One ledger line per call. Claude's subscription windows are read before and after (computer-wide).
  pct() { const l = this.limitsNow && this.limitsNow(); return l ? { five: l.fiveHour ? l.fiveHour.pct : null, seven: l.sevenDay ? l.sevenDay.pct : null } : null; }
  record(meta, usage, before, ms) {
    const u = usage || {};
    const after = this.pct();
    const d = (a, b) => (a === null || a === undefined || b === null || b === undefined ? undefined : Math.max(0, b - a));
    this.ledger.log({
      ...meta, model: u.model, in: u.input || 0, out: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, ms: u.ms || ms,
      ...(meta.brain === 'claude' && before && after ? { pct5hBefore: before.five, pct5hAfter: after.five, pct5hDelta: d(before.five, after.five), pct7dDelta: d(before.seven, after.seven) } : {}),
    });
  }

  // A Claude member: its fork of the original conversation (made once, then reused). The
  // original record is fingerprinted before and after, to show it wasn't touched.
  async claudeTurn(c, m, prompt) {
    if (!fs.existsSync(m.cwd)) throw new Error(`原本的專案資料夾不見了：${m.cwd}`);
    const orig = path.join(PROJECTS(), m.project, `${m.sessionId}.jsonl`);
    const before = await fingerprint(orig);
    const fork = c.forks[m.id];
    const res = await this.call.claude({
      resume: fork || m.sessionId, fork: !fork, name: `${FORK_PREFIX}：${c.name}`,
      cwd: m.cwd, tools: toolsOf(m), prompt, addDirs: [this.filesDir], act: this.actArgs(c, m),
    });
    if (!fork) {
      if (!res.sessionId || res.sessionId === m.sessionId) throw new Error('沒有拿到分身的對話編號，為了不寫到原本的對話，先停下來');
      c.forks[m.id] = res.sessionId;
    }
    const after = await fingerprint(orig);
    this.trackCtx(c, m, res);
    return { text: res.text, usage: res, extra: { untouched: before === after, fork: c.forks[m.id], ...webOf(res) } };
  }

  // A hub assistant: its own conversation (kept, so it remembers what it said), run in the filtered
  // copy of its folder. Role goes in as the system prompt every turn, so a changed role applies at once.
  async assistantTurn(c, m, prompt) {
    const ws = this.syncWorkspace(m);
    const res = await this.call.claude({
      resume: m.sessionId || undefined, persist: true, name: `${FORK_PREFIX}（助手）：${m.name}`,
      system: `你是「${m.name}」，主席的團隊通訊中樞裡的 Claude 助手。你的角色：${m.role}${m.folder ? `\n你負責的資料夾已複製到目前的工作目錄（${ws.files} 個檔案，金鑰、密碼檔和隱藏檔不在裡面）。` : ''}\n你記得自己在各個聊天室說過的話。`,
      model: CLAUDE_MODELS[m.model], cwd: ws.dir, tools: toolsOf(m), prompt, addDirs: [this.filesDir], act: this.actArgs(c, m),
    });
    if (!m.sessionId) {
      if (!res.sessionId) throw new Error('沒有拿到助手的對話編號，先停下來');
      m.sessionId = res.sessionId;
    }
    this.trackCtx(c, m, res);
    return { text: res.text, usage: res, extra: webOf(res) };
  }

  // Gemini: stateless, so it gets the group's background and the recent chat, masked.
  async geminiTurn(c, m, intro, fresh = []) {
    const claudes = c.members.map((id) => this.member(id)).filter((x) => x && x.kind === 'claude');
    const notes = [...new Set(claudes.map((x) => x.cwd))].map((dir) => projectNotes(dir)).filter(Boolean).join('\n\n');
    const recent = c.messages.filter((x) => x.from !== 'system').slice(-30)
      .map((x) => `[${x.from === 'chair' ? '主席' : (this.member(x.from) || { name: x.from }).name}] ${x.text}${(x.files || []).map((f) => ` 📎${f.name}`).join('')}`).join('\n\n');
    const brain = brainOf(m);
    const other = brain !== 'gemini'; // Ollama, OpenAI-compatible, Antigravity: text only
    const persona = m.kind === 'assistant'
      ? `\n\n你的角色：${m.role}\n你記得的只有這個聊天室最近的對話；你沒有檔案工具，不能讀資料夾、改檔或執行指令。`
      : m.kind === 'web'
      ? `\n\n你代表主席在 ${m.source} 網頁版上的那段對話「${m.title}」。你沒有原本的完整對話，只記得下面這份摘要；摘要裡沒有的事就說不記得，不要編造。\n${m.digest}`
      : '';
    const system = mask(`你是「${m.name}」，在主席的團隊通訊中樞裡跟其他 AI 一起討論。${intro}${persona}${notes ? `\n\n相關專案的背景資料：\n${notes}` : ''}`);
    // Attachments it hasn't seen: images and PDFs go along as they are; text files are read and masked.
    const files = [];
    let texts = '';
    let total = 0;
    for (const f of fresh.flatMap((x) => x.files || []).slice(-5)) {
      const file = this.fileOf(f.id);
      if (!file || total + file.size > MAX_FILE) continue;
      total += file.size;
      if (file.kind === 'text') texts += `\n\n📎 附件「${file.name}」的內容：\n${fs.readFileSync(file.path, 'utf8').slice(0, 100_000)}`;
      else if (!other) files.push({ name: file.name, mimeType: file.mime, data: fs.readFileSync(file.path).toString('base64') });
    }
    const prompt = mask(`最近的對話：\n${recent}${texts}\n\n請以「${m.name}」的身分回覆最新的訊息。`);
    const res = other
      ? await this.call.ai({ provider: brain, system, prompt, maxTokens: 2000 })
      : await this.call.gemini({ system, prompt, files, maxTokens: 2000, search: m.kind === 'assistant' ? !!m.web : this.geminiWeb });
    return { text: res.text, usage: res };
  }

  // 💾 Boil the chat down (Gemini) and write it to each Claude member's project memory.
  async memorize(id) {
    const c = this.channel(id);
    const from = c.memorizedAt || 0;
    const msgs = c.messages.filter((x) => x.at > from && x.from !== 'system' && !x.error);
    if (!msgs.length) throw bad('上次總結之後還沒有新的討論');
    const transcript = msgs.map((x) => `[${x.from === 'chair' ? '主席' : (this.member(x.from) || { name: x.from }).name}] ${x.text}${(x.files || []).map((f) => ` 📎${f.name}`).join('')}`).join('\n\n');
    const res = await this.call.gemini({
      system: '你是會議記錄。把群組討論整理成繁體中文結構化摘要，只寫有共識或主席拍板的內容，簡明扼要。格式：\n## 核心決議\n- …\n## 技術規格變更\n- …（沒有就寫「無」）\n## 各成員分工\n- 名字：要做的事（沒有就寫「無」）',
      prompt: mask(`群組「${c.name}」的討論：\n\n${transcript}`), maxTokens: 1500,
    });
    this.record({ room: c.name, roomId: c.id, kind: c.kind, mode: 'summary', round: 0, member: 'Gemini', memberId: 'gemini', brain: 'gemini', purpose: 'summary', promptChars: transcript.length }, res, null, 0);
    const summary = String(res.text || '').trim();
    if (!summary) throw bad('摘要是空的，沒有寫入記憶');
    const stamp = new Date().toLocaleString('zh-TW', { hour12: false });
    const written = [];
    for (const m of c.members.map((x) => this.member(x)).filter((x) => x && x.kind === 'claude')) {
      written.push({ member: m.name, file: writeMemory(m, c, summary, stamp) });
    }
    // The hub's own copy (data/, not in git), with the whole discussion.
    const logDir = path.join(path.dirname(this.file), 'hub');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `${c.id}.md`), `\n\n# ${c.name} — ${stamp}\n\n${summary}\n\n<details><summary>完整討論</summary>\n\n${transcript}\n\n</details>\n`);
    c.memorizedAt = now();
    const hot = written.map((w) => ({ member: w.member, text: `請讀取最新的群組結論並記住：${w.file}` }));
    this.say(c, 'system', `💾 已總結並寫入記憶${written.length ? `：${written.map((w) => w.member).join('、')}的專案記憶資料夾` : '（群組裡沒有 Claude 成員，只存在通訊中樞）'}。`, { summary, hot });
    this.changed();
    return { ok: true, summary, written, hot };
  }
}

// Which brain answers a member. Assistants choose one when made: Claude (files, own memory, hands) or a text-only one.
const BRAINS = { claude: 'Claude（訂閱）', gemini: 'Gemini（免費額度）', ollama: 'Ollama（本機）', openai: 'OpenAI 相容服務', antigravity: 'Antigravity（Google AI Pro）' };
// Claude assistants may pick how strong a model they use (stronger = more of the subscription per turn). '' = the default in .env.
const CLAUDE_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const MODEL_NOTE = { haiku: 'Haiku 5.5：最快、最省額度，適合整理、分類、翻譯、短回應', sonnet: 'Sonnet 5.5：一般分析、寫程式、審查', opus: 'Opus 5.5：最強、最耗額度，適合複雜取捨與高風險判斷' };
const brainOf = (m) => (m.kind === 'assistant' ? m.brain || 'claude' : m.kind === 'ai' ? m.provider : m.kind === 'claude' ? 'claude' : 'gemini');
const isClaudeish = (m) => m.kind === 'claude' || (m.kind === 'assistant' && brainOf(m) === 'claude');
const toolsOf = (m) => `Read,Glob,Grep${m.web ? ',WebSearch,WebFetch' : ''}`;
const webOf = (res) => (res.web && res.web.length ? { web: res.web } : {});

// Project background for Gemini: the notes files only (never .env, keys or code), masked later.
function projectNotes(dir) {
  for (const f of NOTES) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      if (text) return `【${path.basename(dir)}／${f}】\n${text.slice(0, 6000)}`;
    } catch {}
  }
  return '';
}

// The member's project memory folder (what Claude Code's auto memory reads), one file per chat.
function writeMemory(m, c, summary, stamp) {
  const dir = path.join(PROJECTS(), m.project, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const name = `hub-${c.id}`;
  const file = path.join(dir, `${name}.md`);
  const head = `---\nname: ${name}\ndescription: 團隊通訊中樞「${c.name.replace(/\n/g, ' ')}」的討論結論（核心決議、規格變更、分工）\nmetadata:\n  type: project\n---\n`;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\n/, '') : '';
  fs.writeFileSync(file, `${head}${old}\n## ${stamp} 的結論\n\n${summary}\n`);
  const index = path.join(dir, 'MEMORY.md');
  // The index line carries the latest key decisions, so a new conversation knows them without opening the file.
  const gist = ((summary.split(/^## /m).find((s) => s.startsWith('核心決議')) || '').match(/^- .+$/gm) || [])
    .map((s) => s.slice(2).trim()).join('；').slice(0, 120);
  const line = `- [群組結論：${c.name}](${name}.md) — ${gist || '團隊通訊中樞討論的決議與分工'}`;
  const cur = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '';
  const kept = cur.split('\n').filter((l) => l && !l.includes(`(${name}.md)`));
  fs.writeFileSync(index, `${[...kept, line].join('\n')}\n`);
  return file;
}

module.exports = { BRAINS, CLAUDE_MODELS, Hub, mask, scanSessions, fingerprint, FORK_PREFIX };
