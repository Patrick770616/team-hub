#!/usr/bin/env node
'use strict';

// The plugin's remote control for the team hub (no dependencies). Used by the skills in ../skills.
//   node hubctl.js where            → where the hub folder is (or NOT_FOUND)
//   node hubctl.js set-dir <path>   → remember the hub folder
//   node hubctl.js status           → is it running
//   node hubctl.js start | stop
//   node hubctl.js groups           → the chats (id, kind, name, members)
//   node hubctl.js memorize <id>    → "💾 總結並寫入記憶" for one chat
//   node hubctl.js agents           → the hub's Claude assistants (id, name, model, role)
//   node hubctl.js export-agents [--user] [id…]  → write them as Claude Code subagents
// It signs in with the password the hub wrote to data/server.log, and never prints it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { BASE, findDir, saveDir, up, connect } = require('./hubclient');

const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const die = (msg) => { console.error(msg); process.exit(1); };

const cmds = {
  where() { const d = findDir(); out(d || 'NOT_FOUND'); if (!d) process.exitCode = 1; },
  'set-dir'(d) { out(`已記住：${saveDir(d)}`); },
  async status() { out((await up()) ? `開著：${BASE}` : '沒開'); },
  async start() {
    const dir = findDir();
    if (!dir) die('NOT_FOUND：找不到團隊中樞的資料夾');
    if (await up()) { out(`已經開著：${BASE}`); return; }
    spawn(process.execPath, [path.join(dir, 'launcher.js')], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    // The first start installs packages (about a minute); wait up to 3 minutes.
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await up()) { out(`已啟動：${BASE}（瀏覽器會自動打開）`); return; }
    }
    die(`3 分鐘內沒有起來，看 ${path.join(dir, 'data', 'server.log')}`);
  },
  async stop() {
    if (!(await up())) { out('本來就沒開'); return; }
    await connect()('POST', '/api/lite/quit', {});
    out('已送出關閉');
  },
  async groups() {
    const v = await connect()('GET', '/api/hub');
    const name = new Map(v.members.map((m) => [m.id, m.name]));
    out(v.channels.map((c) => ({ id: c.id, kind: c.kind, name: c.name, members: c.members.map((m) => name.get(m) || m), busy: !!c.busy })));
  },
  async memorize(id) {
    if (!id) die('要給聊天室的 id（先用 groups 看）');
    out(await connect()('POST', '/api/hub/memorize', { channelId: id }));
  },
  // The hub's Claude assistants (not the bound conversations), with their role.
  async agents() {
    out((await claudeAssistants()).map((m) => ({ id: m.id, name: m.name, model: m.model || '（預設）', web: !!m.web, role: m.role })));
  },
  // → <project>/.claude/agents/hub-*.md (or --user for ~/.claude/agents), one per assistant (all, or the ids given).
  async 'export-agents'(...args) {
    const user = args.includes('--user');
    const ids = args.filter((a) => !a.startsWith('--'));
    let list = await claudeAssistants();
    if (ids.length) {
      const miss = ids.filter((i) => !list.some((m) => m.id === i));
      if (miss.length) die(`找不到這些助手：${miss.join('、')}（先用 agents 看）`);
      list = list.filter((m) => ids.includes(m.id));
    }
    if (!list.length) die('中樞裡還沒有可以匯出的 Claude 助手');
    const dir = path.join(user ? os.homedir() : process.cwd(), '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const done = [];
    for (const m of list) {
      const file = path.join(dir, `hub-${m.id}.md`);
      if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(`team-hub:${m.id}`)) { done.push(`略過 ${m.name}：${file} 已存在，而且不是從中樞匯出的`); continue; }
      fs.writeFileSync(file, agentFile(m));
      done.push(`${m.name} → ${file}`);
    }
    out(done.join('\n'));
  },
};

async function claudeAssistants() {
  const v = await connect()('GET', '/api/hub');
  return v.members.filter((m) => m.kind === 'assistant' && (m.brain || 'claude') === 'claude');
}

// A subagent file for one assistant. Read-only like in the hub (Read, Glob, Grep; web only if the assistant has it).
// The folder it watches is a path on this computer, so it is not copied into the file.
function agentFile(m) {
  const first = String(m.role).split(/\r?\n/)[0].slice(0, 160).replace(/[。.\s]+$/, '');
  const desc = `團隊中樞助手「${m.name}」：${first}。需要這個角色的看法時使用。`;
  const head = [
    '---',
    `name: hub-${m.id}`,
    `description: ${JSON.stringify(desc)}`,
    `tools: Read, Glob, Grep${m.web ? ', WebSearch, WebFetch' : ''}`,
    ...(['haiku', 'sonnet', 'opus'].includes(m.model) ? [`model: ${m.model}`] : []),
    '---',
    `<!-- team-hub:${m.id}（從團隊中樞匯出；再匯出一次會覆蓋這個檔案） -->`,
  ];
  return `${head.join('\n')}\n你是「${m.name}」。你的角色：\n\n${m.role}\n\n回覆要短：先講結論。你只能讀檔案，不能改檔或執行指令。\n`;
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) die('用法：hubctl.js where | set-dir <路徑> | status | start | stop | groups | memorize <id> | agents | export-agents [--user] [id…]');
Promise.resolve(cmds[cmd](...args)).catch((e) => die(e.message));
