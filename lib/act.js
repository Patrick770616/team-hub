'use strict';

// ✋ The rules behind the confirmation cards, all decided by this program, never by an AI:
// where a file path may point, which commands count as dangerous (and why), and how an
// approved command is run. Nothing here acts on its own; hub.js only calls it after "✅ 允許".

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isSecretPath } = require('./secrets');

const within = (root, target) => { const r = path.relative(root, target); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

// A path the member names → { abs, rel } inside root, or an Error saying why not. Secret files (the one
// shared rule, with the path relative to root), links, and anything outside root are refused.
function resolveInside(root, p) {
  p = String(p || '').trim();
  if (!p) throw new Error('沒有指定檔案路徑');
  const abs = path.resolve(root, p);
  if (!within(root, abs)) throw new Error('這個路徑不在專案資料夾裡');
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (isSecretPath(rel)) throw new Error('這是金鑰、密碼檔或隱藏檔，不能動');
  // Nothing on the way may be a link pointing elsewhere: check the nearest part that exists.
  const realRoot = fs.realpathSync(root);
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  if (fs.existsSync(probe)) {
    const real = fs.realpathSync(probe);
    if (real !== realRoot && !within(realRoot, real)) throw new Error('這個路徑會連到專案資料夾以外');
  }
  if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new Error('不改動連結檔');
  return { abs, rel };
}

// Command rules: [pattern, why]. Any hit puts a red mark on the card and makes the Chair tick
// "I have read the whole command" before it can be allowed.
const DANGER = [
  [/\brm\s+(-[a-z]*[rf]|--recursive|--force)/i, '刪除檔案（rm -r／-f）'],
  [/\b(rmdir|rd)\b[^\n]*\/s\b/i, '刪除整個資料夾'],
  [/\bdel\b[^\n]*\/[fsq]\b|\berase\b/i, '刪除檔案（del）'],
  [/\bRemove-Item\b/i, '刪除檔案（Remove-Item）'],
  [/\bformat\s+[a-z]:|\bmkfs\b|\bdiskpart\b|\bdd\s+if=/i, '格式化或覆寫磁碟'],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, '關機或重開機'],
  [/\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|rebase|branch\s+-D|filter-branch)\b/i, '會改動或送出 git 紀錄'],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|scp|sftp|ssh|ftp|nc|ncat|telnet)\b/i, '連到網路（可能把資料送出去）'],
  [/\|\s*(sh|bash|zsh|cmd|powershell|pwsh|iex)\b|\b(iex|Invoke-Expression)\b/i, '執行下載或組出來的程式'],
  [/-enc(odedcommand)?\b/i, '加密過的 PowerShell 指令'],
  [/\b(reg|regedit)\b|\bHKLM\b|\bHKCU\b/i, '改登錄檔'],
  [/\b(sudo|runas|su)\b/i, '提升權限'],
  [/\b(chmod|chown|icacls|takeown|attrib)\b/i, '改檔案權限'],
  [/\b(taskkill|pkill|killall|kill)\b/i, '結束程式'],
  [/\b(net\s+user|net\s+localgroup|schtasks|sc\s+(create|delete|config)|netsh|setx|crontab)\b/i, '改系統設定或建立排程'],
  [/\bnpm\s+(publish|login|adduser|i(nstall)?\s+(-g|--global))\b/i, '發布套件或全域安裝'],
  [/\b(npm|pnpm|yarn|pip3?|npx|bunx?)\s+(i|install|add|exec|dlx|run|x)\b|\bnpx\b/i, '安裝或執行第三方套件（會跑別人的程式）'],
  [/(\$\(|`|%[A-Za-z_]+%|\$env:|\bprintenv\b|\bset\s*$|\benv\b\s*$)/i, '讀取環境變數或組合指令'],
];

// → [reason…] (empty = nothing special; the card still needs the Chair's ✅)
function classify(command, root) {
  const cmd = String(command || '');
  const why = DANGER.filter(([re]) => re.test(cmd)).map(([, w]) => w);
  for (const raw of cmd.split(/[\s"'<>|&;=()]+/)) {
    const t = raw.replace(/^(\.\/|\.\\)+/, '');
    if (!t || t === '.' || t === '..' || t.startsWith('-') || t.startsWith('/') && t.length < 3) continue;
    if (/^(\.\.[\\/]|[A-Za-z]:[\\/]|\/[A-Za-z0-9_.~-]+\/)/.test(t) || /[\\/]\.\.([\\/]|$)/.test(t)) {
      const abs = path.resolve(root, t);
      if (!within(root, abs)) { why.push(`碰到專案資料夾以外的路徑：${t.slice(0, 60)}`); continue; }
    }
    if (isSecretPath(t)) why.push(`碰到金鑰、密碼檔或隱藏檔：${t.slice(0, 60)}`);
  }
  return [...new Set(why)];
}

// Commands that can only LOOK (never write, delete, start a program of the project, or reach the network).
// When the Chair turns on "安全指令放行", exactly these run without a card — and only when classify() found nothing.
// Deliberately not here: tests, builds, cat/type (a wildcard could read a secret file), anything with
// pipes, redirects, chains, quotes or variables. Test commands run the project's own code, so they keep asking.
const SAFE = [
  /^(ls|dir)(\s+-[a-zA-Z]+)*(\s+[\w./\\-]+)?$/i,
  /^pwd$/i,
  /^(node|npm|git|python3?|pip3?)\s+(-v|-V|--version)$/i,
  /^git\s+(status|log|diff|show)(\s+[\w./@~^:=,-]+)*$/i,
];
const SAFE_NOT = /--output|--ext-diff|--textconv|--exec|--upload-pack|(^|\s)-c\b/i;
function isSafe(command, root) {
  const cmd = String(command || '').trim();
  if (!cmd || cmd.length > 300 || /[\r\n]/.test(cmd) || SAFE_NOT.test(cmd)) return false;
  if (classify(cmd, root).length) return false;
  return SAFE.some((re) => re.test(cmd));
}

// A command's environment: this computer's, without anything that looks like a key or a login.
const SENSITIVE_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|^STUDIO_|^ANTHROPIC|^GEMINI|^OPENAI/i;
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SENSITIVE_ENV.test(k)) env[k] = v;
  return env;
}

const RUN_MS = 60_000;
const OUT_MAX = 20_000;
// Runs an approved command in root → { code, out, timedOut }. Output is capped; the caller masks it.
function runCommand(command, cwd, ms = RUN_MS) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(command, { cwd, env: cleanEnv(), shell: true, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, ms);
    const take = (d) => { if (out.length < OUT_MAX) out += d; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.slice(0, OUT_MAX), timedOut }); });
    child.stdin.end();
  });
}

module.exports = { resolveInside, classify, isSafe, runCommand, cleanEnv, within };
