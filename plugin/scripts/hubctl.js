#!/usr/bin/env node
'use strict';

// The plugin's remote control for the team hub (no dependencies). Used by the skills in ../skills.
//   node hubctl.js where            → where the hub folder is (or NOT_FOUND)
//   node hubctl.js set-dir <path>   → remember the hub folder
//   node hubctl.js status           → is it running
//   node hubctl.js start | stop
//   node hubctl.js groups           → the chats (id, kind, name, members)
//   node hubctl.js memorize <id>    → "💾 總結並寫入記憶" for one chat
// It signs in with the password the hub wrote to data/server.log, and never prints it.

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
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) die('用法：hubctl.js where | set-dir <路徑> | status | start | stop | groups | memorize <id>');
Promise.resolve(cmds[cmd](...args)).catch((e) => die(e.message));
