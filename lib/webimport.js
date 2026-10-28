'use strict';

// 📚 Conversations from the web versions, for the chat hub: the Chair's data export from
// claude.ai (a .zip or its conversations.json), ChatGPT (the same), Google Takeout's Gemini
// activity (MyActivity.json), or text pasted by hand. → [{ key, title, source, date, messages: [{ role, text }] }]
// Nothing here calls a model; the hub boils each chosen conversation down afterwards.

const zlib = require('zlib');

// The few zip files a data export needs: stored or deflated entries, read from the central directory.
function unzip(buf, want = () => true) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 zip 檔');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 檔的目錄壞了');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !want(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out[name] = data;
    else if (method === 8) out[name] = zlib.inflateRawSync(data);
  }
  return out;
}

const clean = (s) => String(s || '').replace(/\r/g, '').trim();
const day = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };
const stripHtml = (h) => clean(String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));

// claude.ai: [{ uuid, name, created_at, chat_messages: [{ sender, text, content }] }]
function fromClaude(list) {
  return list.filter((c) => c && Array.isArray(c.chat_messages)).map((c, i) => ({
    key: `claude:${c.uuid || i}`, title: clean(c.name) || '（沒有標題的對話）', source: 'claude.ai', date: day(c.created_at),
    messages: c.chat_messages.map((m) => ({
      role: m.sender === 'human' ? 'user' : 'assistant',
      text: clean(m.text || (Array.isArray(m.content) ? m.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '')),
    })).filter((m) => m.text),
  }));
}
// ChatGPT: [{ id, title, create_time, mapping: { id: { message: { author: { role }, content: { parts } } } } }]
function fromChatGpt(list) {
  return list.filter((c) => c && c.mapping).map((c, i) => ({
    key: `chatgpt:${c.id || c.conversation_id || i}`, title: clean(c.title) || '（沒有標題的對話）', source: 'ChatGPT', date: day((c.create_time || 0) * 1000),
    messages: Object.values(c.mapping).map((n) => n && n.message).filter(Boolean)
      .sort((a, b) => (a.create_time || 0) - (b.create_time || 0))
      .filter((m) => m.author && (m.author.role === 'user' || m.author.role === 'assistant'))
      .map((m) => ({ role: m.author.role, text: clean(((m.content && m.content.parts) || []).filter((x) => typeof x === 'string').join('\n')) }))
      .filter((m) => m.text),
  }));
}
// Google Takeout, Gemini Apps activity: one entry per prompt, no conversation ids, so grouped by day.
function fromGemini(list) {
  const days = new Map();
  for (const e of list) {
    if (!e || !/^Prompted /.test(e.title || '')) continue;
    const d = day(e.time);
    const reply = Array.isArray(e.safeHtmlItem) ? stripHtml(e.safeHtmlItem.map((x) => x.html).join('\n')) : '';
    const msgs = days.get(d) || [];
    msgs.unshift({ role: 'user', text: clean(e.title.replace(/^Prompted /, '')) }, ...(reply ? [{ role: 'assistant', text: reply }] : []));
    days.set(d, msgs);
  }
  return [...days].map(([d, messages]) => ({ key: `gemini:${d}`, title: `Gemini 網頁版 ${d} 的對話`, source: 'Gemini', date: d, messages }));
}

function fromJson(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json && json.conversations) ? json.conversations : [];
  if (list.some((c) => c && Array.isArray(c.chat_messages))) return fromClaude(list);
  if (list.some((c) => c && c.mapping)) return fromChatGpt(list);
  if (list.some((c) => c && /^Prompted /.test(c.title || ''))) return fromGemini(list);
  return [];
}

// A file the Chair dropped in: a .zip export or a .json inside one.
function parse(buf, name = '') {
  let found = [];
  if (/\.zip$/i.test(name) || buf.readUInt32LE(0) === 0x04034b50) {
    const files = unzip(buf, (n) => /(^|\/)(conversations\.json|MyActivity\.json)$/i.test(n));
    for (const data of Object.values(files)) found.push(...fromJson(JSON.parse(data.toString('utf8'))));
  } else {
    let json;
    try { json = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('讀不懂這個檔案：請給匯出的 .zip，或裡面的 conversations.json／MyActivity.json'); }
    found = fromJson(json);
  }
  found = found.filter((c) => c.messages.length);
  if (!found.length) throw new Error('檔案裡找不到對話（支援 claude.ai、ChatGPT 的匯出，以及 Google Takeout 的 Gemini 活動紀錄）');
  return found.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// Long conversations are cut to their start and their end (where the conclusions usually are).
function transcript(c, max = 60_000) {
  const all = c.messages.map((m) => `[${m.role === 'user' ? '主席' : 'AI'}] ${m.text}`).join('\n\n');
  return all.length <= max ? all : `${all.slice(0, max / 3)}\n\n…（中間省略 ${all.length - max} 字）…\n\n${all.slice(-(max * 2) / 3)}`;
}

module.exports = { parse, unzip, transcript };
