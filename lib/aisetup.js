'use strict';

// 🔌 Connecting the other AIs from the page: what is set (never the key itself) and saving settings into the .env
// next to server.js. A saved value also goes into process.env, so it works at once, without a restart.

const fs = require('fs');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// provider → the settings the page may change. secret: never sent back to the page.
const FIELDS = {
  ollama: { model: 'STUDIO_OLLAMA_MODEL', url: 'STUDIO_OLLAMA_URL' },
  openai: { url: 'STUDIO_OPENAI_URL', model: 'STUDIO_OPENAI_MODEL', key: 'STUDIO_OPENAI_KEY', priceIn: 'STUDIO_OPENAI_PRICE_IN', priceOut: 'STUDIO_OPENAI_PRICE_OUT' },
  gemini: { key: 'GEMINI_API_KEY' },
};
const SECRET = new Set(['STUDIO_OPENAI_KEY', 'GEMINI_API_KEY']);

function check(name, v) {
  if (/[\r\n"]/.test(v)) throw bad('設定值不能換行或含雙引號');
  if (v.length > 400) throw bad('設定值太長');
  if (name === 'url') {
    if (!/^https?:\/\/[^\s]+$/i.test(v)) throw bad('網址要以 http:// 或 https:// 開頭');
    if (/anthropic\.com/i.test(v)) throw bad('Claude 只能走 Claude Code 訂閱，不能用按量計費的 API');
  }
  if ((name === 'priceIn' || name === 'priceOut') && !(Number(v) >= 0)) throw bad('價格要填數字（每百萬 Token 的美元）');
  return v;
}

// Set (or with '' remove) KEY in the .env text.
function setLine(text, key, value) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  const line = value === '' ? null : `${key}=${/[\s#]/.test(value) ? `"${value}"` : value}`;
  if (at >= 0) { if (line === null) lines.splice(at, 1); else lines[at] = line; }
  else if (line !== null) { if (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push(line, ''); }
  return lines.join('\n');
}

// values: { field: string }. A secret left empty keeps what is there; clear: ['key'] removes it.
function save(envFile, provider, values = {}, clear = []) {
  const fields = FIELDS[provider];
  if (!fields) throw bad('這種 AI 不在這裡設定');
  let text = '';
  try { text = fs.readFileSync(envFile, 'utf8'); } catch { /* no .env yet */ }
  const wrote = [];
  for (const [name, key] of Object.entries(fields)) {
    const raw = values[name] === undefined || values[name] === null ? undefined : String(values[name]).trim();
    const drop = clear.includes(name);
    if (!drop && (raw === undefined || (raw === '' && SECRET.has(key)))) continue;
    const v = drop ? '' : check(name, raw);
    text = setLine(text, key, v);
    if (v === '') delete process.env[key]; else process.env[key] = v;
    wrote.push(name);
  }
  if (wrote.length) fs.writeFileSync(envFile, text);
  return wrote;
}

async function ollamaModels() {
  const base = (process.env.STUDIO_OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return { up: true, models: (j.models || []).map((m) => m.name).filter(Boolean) };
  } catch { return { up: false, models: [] }; }
}

// What the page shows: current settings (a key only as set / not set) plus whether Ollama is running and its models.
async function status(llm) {
  const e = process.env;
  const ol = await ollamaModels();
  const a = { installed: !!llm.agyInstalled() };
  const claude = { installed: !!llm.claudeInstalled() };
  return {
    ollama: { model: e.STUDIO_OLLAMA_MODEL || '', url: e.STUDIO_OLLAMA_URL || '', up: ol.up, models: ol.models },
    openai: { url: e.STUDIO_OPENAI_URL || '', model: e.STUDIO_OPENAI_MODEL || '', keySet: !!e.STUDIO_OPENAI_KEY, priceIn: e.STUDIO_OPENAI_PRICE_IN || '', priceOut: e.STUDIO_OPENAI_PRICE_OUT || '' },
    gemini: { keySet: !!e.GEMINI_API_KEY },
    antigravity: a,
    claude,
  };
}

module.exports = { save, status, FIELDS };
