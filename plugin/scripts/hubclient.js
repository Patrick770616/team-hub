'use strict';

// Shared by hubctl.js (the skills' command line) and mcp.js (the tools): finding the hub folder, and a
// signed-in way to call the hub. Errors are thrown as Error with a plain-Chinese message; no dependencies.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.STUDIO_LITE_PORT || 8300);
const BASE = `http://localhost:${PORT}`;
const REMEMBER = path.join(os.homedir(), '.team-hub-path');

const isHub = (d) => !!d && fs.existsSync(path.join(d, 'launcher.js')) && fs.existsSync(path.join(d, 'server.js'));

function findDir() {
  const tries = [process.env.TEAM_HUB_DIR];
  try { tries.push(fs.readFileSync(REMEMBER, 'utf8').trim()); } catch { /* none saved */ }
  const home = os.homedir();
  tries.push(path.join(home, 'Desktop', '團隊中樞'), path.join(home, 'team-hub'), path.join(home, 'Documents', 'team-hub'));
  return tries.find(isHub) || null;
}

function saveDir(d) {
  if (!isHub(d)) throw new Error('這個資料夾裡沒有 launcher.js 和 server.js，不像是團隊中樞');
  fs.writeFileSync(REMEMBER, path.resolve(d));
  return path.resolve(d);
}

async function up() {
  try { const r = await fetch(`${BASE}/api/me`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

// The password the hub wrote to data/server.log at its last start (never shown to anyone).
function passwordOf(dir) {
  try {
    const log = fs.readFileSync(path.join(dir, 'data', 'server.log'), 'utf8');
    const all = [...log.matchAll(/這次的密碼：([^\s（(]+)/g)];
    return all.length ? all[all.length - 1][1] : '';
  } catch { return ''; }
}

async function login(dir) {
  const pw = passwordOf(dir);
  if (!pw) throw new Error('找不到登入密碼：請用桌面捷徑（團隊中樞.vbs）啟動，密碼才會記在 data/server.log');
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-hq': 'ceo' }, body: JSON.stringify({ password: pw }) });
  if (!r.ok) throw new Error(`登入失敗：${(await r.json().catch(() => ({}))).error || r.status}（團隊中樞可能重開過、密碼已換；請關掉再用捷徑啟動一次）`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

// → async (method, path, body) => parsed JSON. Signs in on first use and again if the hub restarted.
function connect() {
  let cookie = '';
  const once = async (method, p, body) => {
    const res = await fetch(BASE + p, { method, headers: { cookie, 'content-type': 'application/json', 'x-studio-hq': 'ceo' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { res, j: await res.json().catch(() => ({})) };
  };
  return async (method, p, body) => {
    const dir = findDir();
    if (!dir) throw new Error('找不到團隊中樞的資料夾（可用 hub-start 技能下載或指定位置）');
    if (!(await up())) throw new Error('團隊中樞沒有開，請先用 hub-start 技能啟動');
    if (!cookie) cookie = await login(dir);
    let { res, j } = await once(method, p, body);
    if (res.status === 401) { cookie = await login(dir); ({ res, j } = await once(method, p, body)); }
    if (!res.ok || j.ok === false) throw new Error(`團隊中樞回應：${j.error || res.status}`);
    return j;
  };
}

module.exports = { PORT, BASE, findDir, saveDir, up, connect };
