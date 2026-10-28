'use strict';

// ✋ The hands of a Claude member, as a tiny MCP server (stdio, JSON per line) that Claude Code
// starts for a member who may change files or run commands. It does nothing itself: every call is
// handed to the hub (HUB_URL, with the one-run token HUB_TOKEN), which shows the Chair a card and
// only acts after "✅ 允許". The answer (done, or refused) comes back as the tool's result.

const http = require('http');

const URL_ = process.env.HUB_URL || '';
const TOKEN = process.env.HUB_TOKEN || '';
const WHO = { channelId: process.env.HUB_CHANNEL || '', memberId: process.env.HUB_MEMBER || '' };
const WAIT_MS = 12 * 60_000; // a bit longer than a card stays open

const TOOLS = [
  {
    name: 'edit_file',
    description: '修改檔案：把檔案裡一段「剛好出現一次」的文字換成新的文字。主席會在畫面上看到改前改後對照，按允許才會真的改。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑（相對於專案資料夾）' }, old: { type: 'string', description: '要被取代的原文，要剛好出現一次' }, new: { type: 'string', description: '新的文字' }, why: { type: 'string', description: '用一句白話（給不懂程式的主席看）說明你為什麼要做這個、做完會怎樣' } }, required: ['path', 'old', 'new'] },
  },
  {
    name: 'write_file',
    description: '建立新檔案，或整個覆蓋既有檔案。主席會看到完整內容，按允許才會真的寫入。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, why: { type: 'string', description: '用一句白話（給不懂程式的主席看）說明你為什麼要做這個、做完會怎樣' } }, required: ['path', 'content'] },
  },
  {
    name: 'run_command',
    description: '在專案資料夾執行一個指令。主席會看到完整指令，按允許才會執行；回傳指令的輸出。',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, why: { type: 'string', description: '用一句白話（給不懂程式的主席看）說明你為什麼要做這個、做完會怎樣' } }, required: ['command'] },
  },
];

function ask(tool, input) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ ...WHO, tool, input });
    let u;
    try { u = new URL(URL_); } catch { return resolve({ isError: true, text: '團隊中樞的位址不正確' }); }
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/act/ask', method: 'POST', timeout: WAIT_MS, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-hub-act': TOKEN } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve({ isError: !j.ok, text: String(j.text || j.error || '') }); } catch { resolve({ isError: true, text: '團隊中樞回傳的格式不正確' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('等太久了')));
    req.on('error', (e) => resolve({ isError: true, text: `連不上團隊中樞：${e.message}` }));
    req.end(body);
  });
}

const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled…)
  if (method === 'initialize') return send({ id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hubact', version: '1.0.0' } } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some((t) => t.name === name)) return send({ id, error: { code: -32602, message: `沒有這個工具：${name}` } });
    const r = await ask(name, (params && params.arguments) || {});
    return send({ id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } });
  }
  return send({ id, error: { code: -32601, message: `不支援：${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => msg.id !== undefined && send({ id: msg.id, error: { code: -32603, message: String(e.message || e) } }));
  }
});
process.stdin.on('end', () => process.exit(0));
