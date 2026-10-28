'use strict';

// Brains. The default setup costs nothing extra: only existing subscriptions and free tiers.
//
//   claude-cli — the local Claude Code CLI (`claude -p`), logged in with the
//                user's Claude Pro subscription. Never an API key: the child
//                process gets ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN stripped,
//                and a CLI logged in with an API key is refused.
//   antigravity — the local Antigravity CLI (`agy`), Google's successor to Gemini CLI for
//                personal accounts, logged in with the user's Google account (Google AI Pro).
//   gemini     — Google GenAI SDK with an AI Studio key (GEMINI_API_KEY).
//   ollama     — a model running locally in Ollama (free), via its OpenAI-compatible endpoint.
//   openai     — any OpenAI-compatible service (OpenAI, OpenRouter, Groq…) with the user's own key.
//   anthropic  — the Claude API with the user's own key (official SDK). Billed per
//                token, so it is OFF unless STUDIO_ANTHROPIC_ENABLED=1 is set in the
//                AI connection settings; the SDK is only loaded then.
//   rules      — the local rule engine (no model call, no tokens).
// Keys and models are read from process.env on every call, so the settings page
// (aisettings.js) takes effect without a restart. login() opens a terminal window
// where the user signs in to either CLI.
//
// A provider that isn't available (or STUDIO_LLM_MODE=sim) falls back to a
// simulated brain so the office still runs; simulated calls charge estimated tokens.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

const geminiModel = () => process.env.STUDIO_GEMINI_MODEL || 'gemini-3.5-flash-lite';
const ollamaUrl = () => (process.env.STUDIO_OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const anthropicModel = () => process.env.STUDIO_ANTHROPIC_MODEL || 'claude-opus-5-5';
const anthropicOn = () => /^(1|true|yes)$/i.test(process.env.STUDIO_ANTHROPIC_ENABLED || '') && !!process.env.STUDIO_ANTHROPIC_API_KEY;
const claudeCliModel = () => process.env.STUDIO_CLAUDE_MODEL || ''; // empty: the subscription's default (Opus 5.5)
const CLI_TIMEOUT_MS = Number(process.env.STUDIO_CLAUDE_TIMEOUT_MS || 10 * 60_000);
const MAX_OUTPUT = Number(process.env.STUDIO_MAX_OUTPUT_TOKENS || 8000);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rough count for the pre-call quota check (CJK-heavy text runs ~1 token/char).
const estimateTokens = (s) => Math.ceil(String(s || '').length / 2.5);

class LlmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmError';
  }
}

const mode = () => (process.env.STUDIO_LLM_MODE || 'auto').toLowerCase();

// ------------------------------------------------------------ Claude Code CLI

function onPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const f = path.join(dir, n);
      if (dir && fs.existsSync(f)) return f;
    }
  }
  return null;
}

// STUDIO_CLAUDE_BIN, else `claude` on PATH, else the native installer's location.
function findClaudeBin() {
  if (process.env.STUDIO_CLAUDE_BIN) return fs.existsSync(process.env.STUDIO_CLAUDE_BIN) ? process.env.STUDIO_CLAUDE_BIN : null;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const found = onPath(names);
  if (found) return found;
  const native = path.join(os.homedir(), '.local', 'bin', names[0]);
  return fs.existsSync(native) ? native : null;
}

// Subscription only: strip anything that would bill an API account, and the
// variables that make a child think it is nested inside another session.
function cliEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'STUDIO_ANTHROPIC_API_KEY', 'STUDIO_OPENAI_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  return env;
}

// Cached; a failed check is retried after a minute, so logging in later
// takes effect without restarting the server.
let cli; // { bin, ok, reason, method, at }
function claudeCli(fresh = false) {
  if (!fresh && cli && (cli.ok || Date.now() - cli.at < 60_000)) return cli;
  cli = { ...probeCli(), at: Date.now() };
  return cli;
}

// Look again next time (STUDIO_CLAUDE_BIN changed, e.g. a test pointing at a stand-in).
function forgetClaudeCli() { cli = null; }

function probeCli() {
  const bin = findClaudeBin();
  if (!bin) return ({ ok: false, reason: '找不到 Claude Code CLI（請安裝並登入，或設定 STUDIO_CLAUDE_BIN）' });
  const r = spawnSync(bin, ['auth', 'status'], { env: cliEnv(), encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: /\.cmd$/i.test(bin) });
  let s = {};
  try { s = JSON.parse(r.stdout); } catch {}
  if (!s.loggedIn) return ({ bin, ok: false, reason: 'Claude Code CLI 尚未登入（請在終端機執行 claude，輸入 /login 並選擇 Claude 訂閱帳號）' });
  if (/api.?key/i.test(String(s.authMethod))) return ({ bin, ok: false, reason: 'Claude Code CLI 是用 API 金鑰登入，會走預付費額度；請改用 Claude Pro 訂閱登入' });
  return { bin, ok: true, method: s.authMethod };
}

// The subscription's usage, shared with everything else on this computer that uses
// Claude Code: every CLI call reports it (a rate_limit_event in its stream-json
// output). { fiveHour, sevenDay: { pct, resetsAt (ms), status } | null, status, at }
let limits = null;
function noteLimits(info) {
  if (!info) return;
  const w = info.unifiedWindows || {};
  const win = (k) => (w[k] ? { pct: Math.round((w[k].utilization || 0) * 100), resetsAt: (w[k].resetsAt || 0) * 1000, status: w[k].status || '' } : null);
  const next = { fiveHour: win('five_hour'), sevenDay: win('seven_day'), status: info.status || '', at: Date.now() };
  // An older CLI reports only the window that's closest to its limit.
  if (!next.fiveHour && !next.sevenDay && info.rateLimitType) {
    const one = { pct: Math.round((info.utilization || 0) * 100), resetsAt: (info.resetsAt || 0) * 1000, status: info.status || '' };
    if (/five|5h|hour/i.test(info.rateLimitType)) next.fiveHour = one; else next.sevenDay = one;
  }
  // Refused for the limit: the window is full whatever the last utilization said.
  if (info.status === 'rejected') for (const k of ['fiveHour', 'sevenDay']) if (next[k] && next[k].status === 'rejected') next[k].pct = 100;
  limits = next;
}
const claudeLimits = () => limits;
const setClaudeLimits = (v) => { limits = v; }; // tests

// Reads the usage fresh with the smallest possible call (a one-word reply from the small model).
let probing = null;
function probeClaudeLimits() {
  if (!probing) {
    probing = callClaudeCli({ system: 'Reply with the single word: ok', prompt: 'ok', model: 'haiku' })
      .then(() => limits, () => limits)
      .finally(() => { probing = null; });
  }
  return probing;
}

// tools: '' for pure reasoning; the engineer may read (never write) its workspace.
// anywhere: the read-only tools may read outside cwd too (the desk agent reads the whole computer).
// WebSearch / WebFetch in tools: VP HR looks up new AI services, engineers check docs and URLs;
// what they looked up comes back as web: [{ tool, target }].
// resume: carry on an existing Claude Code conversation (its own settings and memory load as usual);
// fork: into a new copy, so the original's record is never written to. name: the copy's display name.
// persist: with no resume, start a conversation that is kept (a hub assistant's own memory) instead of a one-off.
function callClaudeCli({ system, prompt, tools = '', cwd, anywhere = false, model, resume, fork = false, name, addDirs = [], persist = false, act }) {
  const { bin } = claudeCli();
  // act: { url, token, channelId, memberId } — start the hub's hands (lib/actserver.js: edit_file, write_file,
  // run_command), each of which waits for the Chair's ✅ in the hub. Claude's own Edit/Write/Bash stay off.
  let mcpFile = null;
  if (act) {
    mcpFile = path.join(os.tmpdir(), `studio-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { hubact: { command: process.execPath, args: [path.join(__dirname, 'actserver.js')], env: { HUB_URL: act.url, HUB_TOKEN: act.token, HUB_CHANNEL: act.channelId, HUB_MEMBER: act.memberId } } } }));
  }
  const sysFile = path.join(os.tmpdir(), `studio-sys-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(sysFile, system || '');
  // stream-json (needs --verbose) also carries the subscription's usage.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'];
  if (resume) {
    if (!SESSION_ID.test(resume)) throw new LlmError('對話編號格式不正確');
    args.push('--resume', resume);
    if (fork) args.push('--fork-session');
    if (name) args.push('-n', String(name).replace(/["%^&|<>\r\n]/g, '').slice(0, 80));
    if (system) args.push('--append-system-prompt-file', sysFile);
    for (const d of addDirs) if (fs.existsSync(d)) args.push('--add-dir', d); // e.g. the hub's attachments, read-only like the rest
  } else if (persist) {
    args.push('--setting-sources', '', '--append-system-prompt-file', sysFile);
    if (name) args.push('-n', String(name).replace(/["%^&|<>\r\n]/g, '').slice(0, 80));
    for (const d of addDirs) if (fs.existsSync(d)) args.push('--add-dir', d);
  } else args.push('--no-session-persistence', '--setting-sources', '', '--system-prompt-file', sysFile);
  args.push('--tools', tools);
  if (model || claudeCliModel()) args.push('--model', model || claudeCliModel());
  if (anywhere && tools && /^(Read|Glob|Grep)(,(Read|Glob|Grep))*$/.test(tools)) args.push('--permission-mode', 'bypassPermissions');
  const web = String(tools).split(',').filter((t) => t === 'WebSearch' || t === 'WebFetch');
  const hands = act ? ['mcp__hubact__edit_file', 'mcp__hubact__write_file', 'mcp__hubact__run_command'] : [];
  if (act) args.push('--mcp-config', mcpFile);
  if (web.length || hands.length) args.push('--allowedTools', [...web, ...hands].join(','));
  const shell = /\.cmd$/i.test(bin); // only fixed strings go on the command line; text goes through stdin and the file
  return new Promise((resolve, reject) => {
    const child = spawn(shell ? `"${bin}"` : bin, shell ? args.map((a) => `"${a}"`) : args,
      { cwd: cwd || os.tmpdir(), env: cliEnv(), windowsHide: true, shell });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), act ? CLI_TIMEOUT_MS + 15 * 60_000 : CLI_TIMEOUT_MS); // time for the Chair to answer cards
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); fs.rmSync(sysFile, { force: true }); if (mcpFile) fs.rmSync(mcpFile, { force: true }); reject(new LlmError(`無法啟動 Claude Code CLI：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(sysFile, { force: true });
      if (mcpFile) fs.rmSync(mcpFile, { force: true });
      let res;
      const looked = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'rate_limit_event') noteLimits(j.rate_limit_info);
        else if (j.type === 'result') res = j;
        else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
          for (const c of j.message.content) {
            if (c.type === 'tool_use' && (c.name === 'WebFetch' || c.name === 'WebSearch')) looked.push({ tool: c.name, target: String((c.input && (c.input.url || c.input.query)) || '').slice(0, 300) });
          }
        }
      }
      if (!res) return reject(new LlmError(`Claude Code CLI 結束（exit ${code}），沒有有效輸出：${(err || out).slice(0, 300)}`));
      if (res.is_error) return reject(new LlmError(`Claude Code CLI：${res.result || res.terminal_reason || '未知錯誤'}`));
      const u = res.usage || {};
      resolve({
        text: res.result || '',
        sessionId: res.session_id || null,
        web: looked,
        input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        ms: res.duration_ms || 0,
        // Claude Code also calls a small model for side jobs: record the chosen model, else the dearest one used.
        model: (res.modelUsage || {})[claudeCliModel()] ? claudeCliModel()
          : Object.entries(res.modelUsage || {}).sort(([, x], [, y]) => (y.costUSD || 0) - (x.costUSD || 0)).map(([k]) => k)[0] || 'claude-code',
        usd: 0, // covered by the subscription
      });
    });
    child.stdin.end(prompt);
  });
}

// ------------------------------------------------------------ Antigravity CLI (Google AI Pro)

// STUDIO_AGY_BIN, else `agy` on PATH, else where Google's installer puts it.
function findAgyBin() {
  if (process.env.STUDIO_AGY_BIN) return fs.existsSync(process.env.STUDIO_AGY_BIN) ? process.env.STUDIO_AGY_BIN : null;
  const found = onPath(process.platform === 'win32' ? ['agy.exe'] : ['agy']);
  if (found) return found;
  const guesses = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')]
    : [path.join(os.homedir(), '.local', 'bin', 'agy')];
  return guesses.find((f) => fs.existsSync(f)) || null;
}
// Which Google account it is signed in with, from the CLI's own log (shown so a wrong account is easy to spot).
function agyAccount() {
  try {
    const log = fs.readFileSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cli.log'), 'utf8');
    const all = [...log.matchAll(/applyAuthResult: email=([^\s,]+)/g)];
    return all.length ? all[all.length - 1][1] : '';
  } catch { return ''; }
}

let agy; // { bin, ok, reason, method, at }, cached like the Claude check
function agyCli(fresh = false) {
  if (!fresh && agy && (agy.ok || Date.now() - agy.at < 60_000)) return agy;
  agy = { ...probeAgy(), at: Date.now() };
  return agy;
}
function probeAgy() {
  const bin = findAgyBin();
  if (!bin) return { ok: false, reason: '找不到 Antigravity CLI（安裝方式見 https://antigravity.google/docs/cli/）' };
  const r = spawnSync(bin, ['models'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, cwd: os.tmpdir() });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 || /sign in|not logged/i.test(out)) return { bin, ok: false, reason: 'Antigravity CLI 還沒登入（按「用 Google 帳號登入」）' };
  const who = agyAccount();
  return { bin, ok: true, method: who ? `Google 帳號 ${who}` : 'Google 帳號' };
}

const AGY_ANSWER_HERE = '請直接在這則回覆裡寫出完整內容（照上面要求的格式），不要寫成檔案、不要只給計畫連結，也不要反問；資訊不足就用合理假設並註明。';
const AGY_BRAIN = () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
// The text of the plan files one agy turn wrote, in order; '' when none (or outside its brain folder).
function agyPlans(paths) {
  const root = path.resolve(AGY_BRAIN()) + path.sep;
  return [...new Set(paths)].map((p) => path.resolve(String(p || '')))
    .filter((p) => p.toLowerCase().startsWith(root.toLowerCase()) && /\.md$/i.test(p))
    .map((p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } })
    .filter(Boolean).join('\n\n');
}

// One turn through stdin (stream-json), so long prompts never hit the command-line length limit.
// Plan mode in an empty folder: it answers, it doesn't edit files or run commands.
function callAgy({ system, prompt }) {
  const { bin } = agyCli();
  const args = ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan'];
  const model = process.env.STUDIO_AGY_MODEL || '';
  if (/^[\w.:/-]+$/.test(model)) args.push('--model', model);
  const cwd = path.join(os.tmpdir(), 'studio-agy');
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: cliEnv(), windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new LlmError(`無法啟動 Antigravity CLI：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let res = null;
      const written = [];
      for (const line of out.split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'result') res = ev.result;
          const s = ev.step_update;
          if (s && s.state === 'DONE' && s.tool_name === 'write_file' && s.tool_info && s.tool_info.parameters) written.push(s.tool_info.parameters.Path);
        } catch {}
      }
      if (!res) return reject(new LlmError(`Antigravity CLI 結束（exit ${code}），沒有有效輸出：${(err || out).slice(-300)}`));
      if (res.status !== 'SUCCESS') return reject(new LlmError(`Antigravity CLI：${(res.error && (res.error.message || JSON.stringify(res.error))) || res.status}`));
      const u = res.usage || {};
      // Plan mode tends to put the real answer in a plan file of its own and reply only "see the
      // plan": that file is the answer. Only files in its own brain folder are read.
      const plans = agyPlans(written);
      const reply = String(res.response || '').trim();
      const text = plans.length > reply.length ? plans : reply;
      resolve({ text, input: (u.input_tokens || 0) + (u.cache_read_tokens || 0), output: (u.output_tokens || 0) + (u.thinking_tokens || 0), model: model || 'antigravity', usd: 0 });
    });
    child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: `${system}\n\n---\n\n${prompt}\n\n---\n\n${AGY_ANSWER_HERE}` } })}\n`);
  });
}

// ------------------------------------------------------------ Signing in from the settings page

// Opens a terminal window on this computer running argv (fixed program paths and flags only).
function openTerminal(argv) {
  const q = (a) => `"${a}"`;
  if (process.platform === 'win32') {
    // cmd /k ""prog" args": cmd strips the outer quotes, so paths with spaces still work.
    spawn(`start "AI 登入" cmd /k "${argv.map(q).join(' ')}"`, { shell: true, detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
    return;
  }
  const line = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find((t) => onPath([t]));
  if (!term) throw new LlmError('找不到終端機程式，請自己開終端機執行：' + argv.join(' '));
  spawn(term, term === 'gnome-terminal' ? ['--', 'sh', '-c', `${line}; exec sh`] : ['-e', `sh -c "${line}; exec sh"`], { detached: true, stdio: 'ignore' }).unref();
}

// The settings page's "sign in" buttons. Claude: `claude auth login --claudeai` (subscription,
// never the Console). Antigravity: start it once; it asks how to sign in. STUDIO_LOGIN_DRYRUN=1 only describes it (tests).
function login(provider) {
  const dry = process.env.STUDIO_LOGIN_DRYRUN === '1';
  let argv;
  if (provider === 'claude-cli') {
    const bin = findClaudeBin();
    if (!bin) return { ok: false, detail: '找不到 Claude Code。請先到 https://claude.com/claude-code 安裝，再按一次登入。' };
    argv = [bin, 'auth', 'login', '--claudeai'];
  } else if (provider === 'antigravity') {
    const bin = findAgyBin();
    if (!bin) return { ok: false, detail: '找不到 Antigravity CLI。請先照 https://antigravity.google/docs/cli/ 安裝，再按一次登入。' };
    argv = [bin]; // its first screen asks how to sign in: pick "Google OAuth"
  } else {
    return { ok: false, detail: '這個大腦不需要登入' };
  }
  if (dry) return { ok: true, dry: true, detail: argv.join(' ') };
  openTerminal(argv);
  cli = agy = null;
  return { ok: true, detail: '已開啟登入視窗，請在跳出的瀏覽器頁面登入。' };
}

// The settings page's "sign out" buttons. Claude: `claude auth logout`. Antigravity can only sign out from inside the CLI, so its window is opened for the user to type /logout.
function logout(provider) {
  const dry = process.env.STUDIO_LOGIN_DRYRUN === '1';
  let done;
  if (provider === 'claude-cli') {
    const bin = findClaudeBin();
    if (!bin) return { ok: false, detail: '找不到 Claude Code CLI' };
    if (dry) return { ok: true, dry: true, detail: `${bin} auth logout` };
    const r = spawnSync(bin, ['auth', 'logout'], { env: cliEnv(), encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: /\.cmd$/i.test(bin) });
    if (r.status !== 0) return { ok: false, detail: `登出失敗：${(r.stderr || r.stdout || '').trim().slice(0, 200)}` };
    done = { ok: true, detail: '已登出 Claude 訂閱。' };
  } else if (provider === 'antigravity') {
    const bin = findAgyBin();
    if (!bin) return { ok: false, detail: '找不到 Antigravity CLI' };
    if (dry) return { ok: true, dry: true, detail: `${bin} (then /logout)` };
    openTerminal([bin]);
    done = { ok: true, pending: true, detail: '已開啟 Antigravity 視窗：請在視窗裡輸入 /logout 按 Enter，再關掉視窗。' };
  } else {
    return { ok: false, detail: '這個大腦不需要登出' };
  }
  cli = agy = null;
  return done;
}

// ------------------------------------------------------------ Gemini (free tier)

let gemini = null; // { key, client }: remade when the key changes in the settings
// files: [{ mimeType, data (base64) }] go along with the prompt (screenshots, PDFs).
// search: let Gemini look things up with Google Search.
async function callGemini({ system, prompt, maxTokens, files = [], search = false }) {
  if (!gemini || gemini.key !== process.env.GEMINI_API_KEY) gemini = { key: process.env.GEMINI_API_KEY, client: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) };
  const GEMINI_MODEL = geminiModel();
  let res;
  // A 503 ("high demand") is usually brief: retry it. A 429 is the free quota: don't.
  for (let attempt = 1; ; attempt++) {
    try {
      res = await gemini.client.models.generateContent({
        model: GEMINI_MODEL,
        contents: files.length ? [{ role: 'user', parts: [{ text: prompt }, ...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } }))] }] : prompt,
        config: { systemInstruction: system, maxOutputTokens: maxTokens, ...(search ? { tools: [{ googleSearch: {} }] } : {}) },
      });
      break;
    } catch (e) {
      const cause = e.cause ? ` (${e.cause.code || e.cause.message})` : '';
      const msg = String(e.message || e) + cause;
      // 503 "high demand" and dropped connections are usually brief.
      if (/503|UNAVAILABLE|fetch failed/.test(msg) && attempt < 4) { await pause(attempt * 5000); continue; }
      throw new LlmError(/429|RESOURCE_EXHAUSTED/.test(msg) ? `Gemini 額度已達上限，請稍後再試：${msg.slice(0, 200)}` : `Gemini API 錯誤：${msg.slice(0, 300)}`);
    }
  }
  const u = res.usageMetadata || {};
  const input = u.promptTokenCount || estimateTokens(system + prompt);
  const output = Math.max(0, (u.totalTokenCount || 0) - input) || estimateTokens(res.text);
  const [pin, pout] = priceOf('gemini');
  return { text: res.text || '', input, output, cacheRead: u.cachedContentTokenCount || 0, model: GEMINI_MODEL, usd: (input * pin + output * pout) / 1e6 };
}

// ------------------------------------------------------------ OpenAI-compatible (Ollama, OpenAI, OpenRouter, Groq…)

async function callOpenAICompat({ url, key, model, system, prompt, maxTokens, name, price }) {
  let res;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(CLI_TIMEOUT_MS),
    });
  } catch (e) {
    throw new LlmError(`連不上 ${name}（${url}）：${e.cause ? e.cause.code || e.cause.message : e.message}`);
  }
  const body = await res.text();
  let d = {};
  try { d = JSON.parse(body); } catch {}
  if (!res.ok) throw new LlmError(`${name} 回傳 ${res.status}：${String((d.error && (d.error.message || d.error)) || body).slice(0, 300)}`);
  const text = d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content || '' : '';
  const u = d.usage || {};
  const input = u.prompt_tokens || estimateTokens(system + prompt);
  const output = u.completion_tokens || estimateTokens(text);
  return { text, input, output, model: d.model || model, usd: price ? (input * price[0] + output * price[1]) / 1e6 : 0 };
}

const callOllama = (o) => callOpenAICompat({ ...o, url: `${ollamaUrl()}/v1`, key: '', model: process.env.STUDIO_OLLAMA_MODEL, name: 'Ollama' });
const callOpenAI = (o) => callOpenAICompat({ ...o, url: process.env.STUDIO_OPENAI_URL, key: process.env.STUDIO_OPENAI_KEY, model: process.env.STUDIO_OPENAI_MODEL, name: 'OpenAI 相容服務', price: priceOf('openai') });

// ------------------------------------------------------------ Claude API (opt-in, billed per token)

// US$ per million tokens [input, output], for the finance books.
const ANTHROPIC_PRICES = { 'claude-fable-5-1': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };
let anthropic = null; // { key, client }
async function callAnthropic({ system, prompt, maxTokens }) {
  const key = process.env.STUDIO_ANTHROPIC_API_KEY;
  if (!anthropic || anthropic.key !== key) {
    const Anthropic = require('@anthropic-ai/sdk'); // loaded only when the Chair turned this brain on
    anthropic = { key, client: new Anthropic({ apiKey: key }) };
  }
  const model = anthropicModel();
  let msg;
  try {
    // Thinking counts toward max_tokens, so short replies still get room; their effort stays low.
    const stream = anthropic.client.messages.stream({
      model,
      max_tokens: Math.max(maxTokens, 16000),
      system,
      messages: [{ role: 'user', content: prompt }],
      ...(maxTokens <= 2000 ? { output_config: { effort: 'low' } } : {}),
    });
    msg = await stream.finalMessage();
  } catch (e) {
    throw new LlmError(`Claude API 錯誤：${String(e.message || e).slice(0, 300)}`);
  }
  if (msg.stop_reason === 'refusal') throw new LlmError('Claude API 拒絕回答這個請求');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = msg.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const output = u.output_tokens || 0;
  const [pin, pout] = priceOf('anthropic');
  return { text, input, output, model, usd: (input * pin + output * pout) / 1e6 };
}

// ------------------------------------------------------------ what a call may cost (finance)

// Prices the Chair entered on the settings page (`${prefix}_PRICE_IN` / `_OUT`), or null.
function entered(prefix) {
  const pin = parseFloat(process.env[`${prefix}_PRICE_IN`]);
  const pout = parseFloat(process.env[`${prefix}_PRICE_OUT`]);
  return Number.isFinite(pin) && Number.isFinite(pout) ? [pin, pout] : null;
}

// US$ per million tokens [input, output]. Subscriptions and local models: [0, 0].
// OpenAI-compatible: the entered prices (null when not entered: cost unknown).
// Gemini API key: the entered prices, or [0, 0] when none (a key on the free tier).
function priceOf(provider) {
  // An unknown Claude model is priced as the dearest one, so the daily limit stays on the safe side.
  if (provider === 'anthropic') return ANTHROPIC_PRICES[anthropicModel()] || ANTHROPIC_PRICES['claude-fable-5-1'];
  if (provider === 'openai') return entered('STUDIO_OPENAI');
  if (provider === 'gemini') return entered('STUDIO_GEMINI') || [0, 0];
  return [0, 0];
}

// The most one call can cost, worked out before it is made: the prompt's estimated
// tokens in, the whole output allowance out (the Claude API always gets room to think).
function estimateUsd({ provider, system, prompt, maxTokens }) {
  if (!providerLive(provider)) return 0; // falls back to the simulated brain
  const p = priceOf(provider);
  if (!p) return 0;
  const out = provider === 'anthropic' ? Math.max(maxTokens, 16000) : maxTokens;
  return (estimateTokens(system + prompt) * p[0] + out * p[1]) / 1e6;
}

// ------------------------------------------------------------ dispatch

function providerLive(provider) {
  if (provider === 'rules') return true;
  if (mode() === 'sim') return false;
  if (provider === 'claude-cli') return claudeCli().ok;
  if (provider === 'antigravity') return agyCli().ok;
  if (provider === 'gemini') return !!process.env.GEMINI_API_KEY;
  if (provider === 'ollama') return !!process.env.STUDIO_OLLAMA_MODEL;
  if (provider === 'openai') return !!(process.env.STUDIO_OPENAI_URL && process.env.STUDIO_OPENAI_MODEL);
  if (provider === 'anthropic') return anthropicOn();
  return false;
}

// A dropped stream or a busy server is usually brief: try again before failing the whole step.
const AGY_TRANSIENT = /interrupted|UNAVAILABLE|\b503\b|overloaded|high demand|ECONNRESET|socket hang up|沒有有效輸出/i;
async function retryBrief(fn, { tries = 3, transient = AGY_TRANSIENT } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !transient.test(String(e && e.message))) throw e;
      await pause(attempt * Number(process.env.STUDIO_RETRY_MS || 5000));
    }
  }
}

const CALL = { antigravity: (a) => retryBrief(() => callAgy(a)), gemini: callGemini, ollama: callOllama, openai: callOpenAI, anthropic: callAnthropic };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// rule: () => string — the rule engine's answer for provider 'rules', and the
// scripted answer for any provider running simulated.
async function complete({ provider, system, prompt, maxTokens, rule, tools, cwd, anywhere }) {
  const max = Math.max(256, Math.min(MAX_OUTPUT, maxTokens || MAX_OUTPUT));
  if (provider === 'rules') {
    await pause(600); // long enough for the office to show the role at work
    return { text: rule(), input: 0, output: 0, model: 'rule-engine', usd: 0 };
  }
  if (!providerLive(provider)) {
    await pause(900 + Math.random() * 1200);
    const text = rule();
    return { text, input: estimateTokens(system + prompt), output: Math.min(max, estimateTokens(text)), model: `sim:${provider}`, usd: 0, simulated: true };
  }
  // A blank answer is no answer: one more try, then an error (never an empty proposal going on to the next step).
  const call = () => (CALL[provider] ? CALL[provider]({ system, prompt, maxTokens: max }) : callClaudeCli({ system, prompt, tools, cwd, anywhere }));
  let res = await call();
  if (tools) return res; // a working turn with tools may end quietly; its files are the answer
  if (!String(res.text || '').trim()) res = await call();
  if (!String(res.text || '').trim()) throw new LlmError(`${PROVIDER_NAME[provider] || provider} 回了「成功」但內容是空的（試了兩次），這一步先停下來`);
  return res;
}
const PROVIDER_NAME = { 'claude-cli': 'Claude', antigravity: 'Antigravity', gemini: 'Gemini', ollama: 'Ollama', openai: 'OpenAI 相容服務', anthropic: 'Claude API' };

function describe() {
  const c = mode() === 'sim' ? { ok: false } : claudeCli();
  return {
    mode: mode(),
    claude: c.ok ? 'Claude Code CLI（Pro 訂閱）' : 'simulated',
    claudeReason: c.ok ? null : c.reason || null,
    antigravity: providerLive('antigravity') ? `Antigravity（${agyCli().method}）` : 'simulated',
    gemini: providerLive('gemini') ? `${geminiModel()}（API 金鑰）` : 'simulated',
    ollama: providerLive('ollama') ? `Ollama ${process.env.STUDIO_OLLAMA_MODEL}（本機）` : 'simulated',
    openai: providerLive('openai') ? `${process.env.STUDIO_OPENAI_MODEL}（OpenAI 相容）` : 'simulated',
    anthropic: providerLive('anthropic') ? `${anthropicModel()}（Claude API，按量計費）` : 'simulated',
    rules: '本機規則引擎',
  };
}

// The settings page's "test connection": a real tiny call (ignores sim mode), or
// for the Claude CLI a fresh login check. quick: only the login check (polled while
// the user signs in). → { ok, detail }
async function test(provider, { quick = false } = {}) {
  try {
    if (provider === 'claude-cli') {
      const c = claudeCli(true);
      return c.ok ? { ok: true, detail: `已登入（${c.method}）` } : { ok: false, detail: c.reason };
    }
    if (provider === 'antigravity') {
      const a = agyCli(true);
      if (!a.ok || quick) return a.ok ? { ok: true, detail: `已登入（${a.method}）` } : { ok: false, detail: a.reason };
    }
    if (!CALL[provider]) return { ok: false, detail: '沒有這種大腦' };
    const need = { antigravity: ['PATH', 'Antigravity CLI'], gemini: ['GEMINI_API_KEY', 'Gemini 金鑰'], ollama: ['STUDIO_OLLAMA_MODEL', 'Ollama 模型名稱'], openai: ['STUDIO_OPENAI_MODEL', '網址和模型名稱'], anthropic: ['STUDIO_ANTHROPIC_API_KEY', 'Claude API 金鑰'] }[provider];
    if (!process.env[need[0]] || (provider === 'openai' && !process.env.STUDIO_OPENAI_URL)) return { ok: false, detail: `還沒填${need[1]}` };
    if (provider === 'anthropic' && !anthropicOn()) return { ok: false, detail: '還沒勾選「啟用 Claude API」' };
    const t0 = Date.now();
    const res = await CALL[provider]({ system: '這是連線測試。', prompt: '只回覆 OK 兩個字母。', maxTokens: 32 });
    return { ok: true, detail: `連線成功（${res.model}，${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${String(res.text).trim().slice(0, 40)}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// 💬 The team chat hub talks to a member's own (forked) conversation and to Gemini directly.
function claudeSession(a) {
  const c = claudeCli();
  if (!c.ok) return Promise.reject(new LlmError(c.reason));
  return callClaudeCli(a);
}
function geminiChat(a) {
  if (!process.env.GEMINI_API_KEY) return Promise.reject(new LlmError('Gemini 還沒設定 API 金鑰（在團隊中樞資料夾的 .env 填 GEMINI_API_KEY，然後重開）'));
  return callGemini(a);
}

// Other brains as hub members: local Ollama, an OpenAI-compatible service, Antigravity (Google AI Pro).
// Never the Claude API (billed per token); Claude and Gemini have their own routes above.
const HUB_AI = ['ollama', 'openai', 'antigravity'];
// How each brain is connected in this program (settings live in the .env next to server.js; restart after editing).
const CONNECT_HINT = {
  claude: '安裝 Claude Code 並用 Claude 訂閱登入',
  gemini: '在「🔌 加入其他 AI」填 Gemini 金鑰（Google AI Studio 的免費金鑰）',
  ollama: '在「🔌 加入其他 AI」選一個 Ollama 模型（Ollama 要先在本機執行）',
  openai: '在「🔌 加入其他 AI」填網址、金鑰和模型名稱',
  antigravity: '安裝 Antigravity CLI（agy），再到「🔌 加入其他 AI」按「用 Google 帳號登入」',
};
// Which brains are connected right now (set up, not necessarily reachable): what the hub offers to choose from.
function connected() {
  const out = {};
  for (const [k, p] of [['claude', 'claude-cli'], ['gemini', 'gemini'], ['ollama', 'ollama'], ['openai', 'openai'], ['antigravity', 'antigravity']]) {
    try { out[k] = !!providerLive(p); } catch { out[k] = false; }
  }
  return out;
}
// The models used when nothing more specific is chosen (settings in .env).
const defaults = () => ({ claude: claudeCliModel() || '訂閱預設', gemini: geminiModel() });
function aiChat({ provider, ...a }) {
  if (!HUB_AI.includes(provider)) return Promise.reject(new LlmError('這種 AI 不能加入團隊中樞'));
  if (!providerLive(provider)) return Promise.reject(new LlmError(`${PROVIDER_NAME[provider]} 還沒設定好（${CONNECT_HINT[provider]}）`));
  return CALL[provider](a);
}

const agyInstalled = () => !!findAgyBin();
const claudeInstalled = () => !!findClaudeBin();
module.exports = { agyInstalled, claudeInstalled, forgetClaudeCli, claudeSession, geminiChat, aiChat, HUB_AI, connected, CONNECT_HINT, defaults, complete, describe, test, login, logout, priceOf, estimateUsd, providerLive, estimateTokens, LlmError, MAX_OUTPUT, claudeLimits, setClaudeLimits, probeClaudeLimits, retryBrief, agyPlans };
