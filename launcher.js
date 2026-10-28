'use strict';

// Starts the team hub without a window: runs server.js in the background, restarts it if it stops,
// and writes what it says to data/server.log. Used by 團隊中樞.vbs (the desktop shortcut). Stop it from the page (⏻ 關閉).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

process.chdir(__dirname);
const port = Number(process.env.STUDIO_LITE_PORT || 8300);
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'server.log');
try { if (fs.statSync(logFile).size > 1024 * 1024) fs.writeFileSync(logFile, ''); } catch { /* none yet */ }
const log = fs.openSync(logFile, 'a');
const note = (t) => fs.writeSync(log, `[${new Date().toLocaleString()}] ${t}\n`);

const open = (url) => spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
  note('第一次啟動：安裝套件');
  spawnSync('npm', ['install', '--no-audit', '--no-fund'], { shell: true, stdio: ['ignore', log, log], windowsHide: true });
}

let first = true;
function run() {
  const child = spawn(process.execPath, ['--use-system-ca', '--env-file-if-exists=.env', 'server.js', ...(first ? [] : ['--no-open'])], { stdio: ['ignore', log, log], windowsHide: true });
  first = false;
  child.on('exit', (code) => {
    if (code === 0) { note('已關閉'); process.exit(0); }
    if (code === 3) { note('已經開著了，直接打開瀏覽器'); open(`http://localhost:${port}`); process.exit(0); }
    note(`停了（代碼 ${code}），3 秒後自動重開`);
    setTimeout(run, 3000);
  });
}
run();
