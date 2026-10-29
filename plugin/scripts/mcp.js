#!/usr/bin/env node
'use strict';

// The team hub as an MCP server (stdio, no dependencies): lets Claude Code read and talk in the hub's chats.
// The hub itself must be running (the hub-start skill opens it). Newline-delimited JSON-RPC on stdin/stdout.

const { BASE, findDir, up, connect } = require('./hubclient');

const call = connect();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 4000) => (String(s).length > n ? `${String(s).slice(0, n)}…（已截短）` : String(s));

async function names(id) {
  const c = await call('GET', `/api/hub/channel?id=${encodeURIComponent(id)}`);
  const who = new Map((c.members || []).map((m) => [m.id, m.name]));
  who.set('chair', '主席（你）');
  who.set('system', '系統');
  return { c, who };
}
const line = (who, m) => `[${who.get(m.from) || m.from}${m.error ? '／出錯' : ''}] ${clip(m.text)}`;

const TOOLS = [
  {
    name: 'hub_status',
    description: '看團隊中樞有沒有開、資料夾在哪。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => `${(await up()) ? `開著：${BASE}` : '沒開（用 hub-start 技能啟動）'}\n資料夾：${findDir() || '找不到'}`,
  },
  {
    name: 'hub_groups',
    description: '列出團隊中樞的聊天室（群組與私聊）：id、名稱、成員、是不是正在回覆。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const v = await call('GET', '/api/hub');
      const n = new Map(v.members.map((m) => [m.id, m.name]));
      if (!v.channels.length) return '還沒有任何聊天室';
      return v.channels.map((c) => `${c.id}｜${c.kind === 'group' ? '群組' : '私聊'}｜${c.name}｜成員：${c.members.map((m) => n.get(m) || m).join('、')}${c.busy ? '｜正在回覆中' : ''}`).join('\n');
    },
  },
  {
    name: 'hub_read',
    description: '讀某個聊天室最近的訊息（不會觸發任何 AI 回覆，不花額度）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '聊天室 id（hub_groups 查）' }, limit: { type: 'number', description: '最近幾則，預設 10，最多 50' } }, required: ['id'] },
    run: async ({ id, limit }) => {
      const { c, who } = await names(id);
      const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
      const msgs = c.messages.slice(-n);
      return msgs.length ? msgs.map((m) => line(who, m)).join('\n\n') : '（還沒有訊息）';
    },
  },
  {
    name: 'hub_say',
    description: '以「主席」身分在聊天室發一句話，等被叫到的 AI 回覆後把回覆帶回來。會讓其他 AI 開始工作並用掉 Token 額度，請只在使用者要求時才發。群組若是「點名」模式，要在文字裡寫 @成員名字（或 @全部），否則沒人回。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '聊天室 id' }, text: { type: 'string', description: '要說的話（最多 8000 字）' }, wait_seconds: { type: 'number', description: '最多等幾秒的回覆，預設 120，最多 600；逾時會先回報目前收到的' } }, required: ['id', 'text'] },
    run: async ({ id, text, wait_seconds }) => {
      const before = (await names(id)).c.messages;
      const since = before.length ? before[before.length - 1].at : 0;
      const sent = await call('POST', '/api/hub/say', { channelId: id, text });
      const limit = Date.now() + Math.min(Math.max(Number(wait_seconds) || 120, 5), 600) * 1000;
      await sleep(1500);
      let idle = 0;
      let timedOut = false;
      for (;;) {
        const { c } = await names(id);
        idle = c.busy ? 0 : idle + 1;
        if (idle >= 2) break;
        if (Date.now() > limit) { timedOut = true; break; }
        await sleep(1000);
      }
      const { c, who } = await names(id);
      const fresh = c.messages.filter((m) => m.at > since && m.from !== 'chair');
      const head = (sent.queued || []).length ? '' : '（這句話沒有叫到任何人）\n';
      const body = fresh.length ? fresh.map((m) => line(who, m)).join('\n\n') : '（沒有收到回覆）';
      return `${head}${body}${timedOut ? '\n\n⏱ 還沒回完，稍後可用 hub_read 再看。' : ''}`;
    },
  },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no answer
  if (method === 'initialize') {
    reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'team-hub', version: '0.2.0' } });
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
  } else if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) { fail(id, -32602, `沒有這個工具：${params?.name}`); return; }
    try {
      reply(id, { content: [{ type: 'text', text: await tool.run(params.arguments || {}) }] });
    } catch (e) {
      reply(id, { isError: true, content: [{ type: 'text', text: e.message }] });
    }
  } else {
    fail(id, -32601, `不支援：${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    handle(m).catch((e) => { if (m.id !== undefined) fail(m.id, -32603, e.message); });
  }
});
process.stdin.on('end', () => process.exit(0));
