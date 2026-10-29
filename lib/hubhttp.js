'use strict';

// 💬 The chat hub's web API. The caller (server.js) checks who may call first.

const fs = require('fs');

const MAX_UPLOAD = 16 * 1024 * 1024;

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error(`檔案太大了（最多 ${Math.round(max / 1024 / 1024)} MB）`), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// JSON routes: 'METHOD /path' → (body, url) => result. accepted(r): the reply for "queued" (202).
function routes(hub, accepted = (r) => r) {
  return {
    'GET /api/hub': () => hub.view(),
    'GET /api/hub/sessions': () => hub.sessions(),
    'GET /api/hub/channel': (body, url) => hub.channelView(url.searchParams.get('id')),
    'POST /api/hub/bind': (body) => ({ ok: true, member: hub.bind(body.sessionId) }),
    'GET /api/hub/brains': () => hub.brains(),
    'POST /api/hub/assistant': (body) => ({ ok: true, member: hub.addAssistant(body) }),
    'POST /api/hub/assistant/update': (body) => ({ ok: true, member: hub.updateAssistant(String(body.id || ''), body) }),
    'POST /api/hub/pickfolder': () => hub.pickFolder(),
    'POST /api/hub/assistant/role': async (body) => ({ ok: true, ...(await hub.draftRole(body)) }),
    'GET /api/hub/tune': () => hub.tuneView(),
    'POST /api/hub/tune': (body) => hub.setTune(body.values, body.reset === true),
    'GET /api/hub/aisetup': () => hub.aiSetup(),
    'POST /api/hub/aisetup': (body) => hub.saveAiSetup(String(body.provider || ''), body.values || {}, body.clear),
    'POST /api/hub/aisetup/test': (body) => hub.testAi(String(body.provider || '')),
    'POST /api/hub/aisetup/login': (body) => hub.loginAi(String(body.provider || '')),
    'POST /api/hub/ai': (body) => ({ ok: true, member: hub.addAi(String(body.provider || '')) }),
    'POST /api/hub/act': (body) => hub.setAct(String(body.id || ''), !!body.on, body.channelId ? String(body.channelId) : undefined),
    'POST /api/hub/safe': (body) => hub.setSafe(String(body.id || ''), !!body.on, body.channelId ? String(body.channelId) : undefined),
    'POST /api/hub/auto': (body) => hub.setAuto(String(body.id || ''), !!body.on, body.channelId ? String(body.channelId) : undefined),
    'POST /api/hub/card': (body) => hub.decide(String(body.cardId || ''), body.decision === 'allow' ? 'allow' : 'deny', { confirmDanger: body.confirmDanger === true }),
    'POST /api/hub/web': (body) => hub.setWeb(String(body.id || ''), !!body.on),
    'POST /api/hub/unbind': (body) => hub.unbind(String(body.id || '')),
    'POST /api/hub/group': (body) => ({ ok: true, channel: hub.createGroup(body) }),
    'POST /api/hub/dm': (body) => ({ ok: true, channel: hub.dm(String(body.memberId || '')) }),
    'POST /api/hub/say': (body) => { const { done, ...r } = hub.post(String(body.channelId || ''), body.text, body.files); return accepted(r); },
    'POST /api/hub/group/folder': (body) => hub.setGroupFolder(String(body.channelId || ''), body.folder, { noFolder: !!body.noFolder, choices: body.choices }),
    'POST /api/hub/members': (body) => hub.setMembers(String(body.channelId || ''), body.members, body.choices),
    'POST /api/hub/import/pick': async (body) => ({ ok: true, members: await hub.importPick(body.importId, body.keys) }),
    'POST /api/hub/mode': (body) => hub.setMode(String(body.channelId || ''), body.mode),
    'POST /api/hub/stop': (body) => hub.stop(String(body.channelId || '')),
    'POST /api/hub/remove': (body) => hub.remove(String(body.channelId || '')),
    'POST /api/hub/pin': (body) => hub.pin(String(body.channelId || ''), body.text),
    'POST /api/hub/unpin': (body) => hub.unpin(String(body.channelId || ''), String(body.pinId || '')),
    'POST /api/hub/memorize': (body) => hub.memorize(String(body.channelId || '')),
  };
}

// The routes that aren't JSON: a web version's data export (up to 200 MB) or a pasted
// conversation, attachments (the raw file), and attachments shown back sandboxed.
// → true when it answered. json(res, code, body) is the caller's.
async function raw(hub, req, res, url, json) {
  const p = url.pathname;
  if (req.method === 'POST' && (p === '/api/hub/import' || p === '/api/hub/import/paste' || p === '/api/hub/upload')) {
    // A custom header cross-site pages can't send without a CORS preflight (never allowed).
    if (req.headers['x-studio-hq'] !== 'ceo') { req.resume(); json(res, 403, { error: '缺少 x-studio-hq 標頭' }); return true; }
    try {
      if (p === '/api/hub/upload') {
        const buf = await readRaw(req, MAX_UPLOAD);
        json(res, 200, { ok: true, file: hub.upload(url.searchParams.get('channelId'), url.searchParams.get('name'), buf) });
      } else if (p.endsWith('/paste')) {
        const buf = await readRaw(req, 2 * 1024 * 1024);
        json(res, 200, { ok: true, member: await hub.importPaste({ title: url.searchParams.get('title'), source: url.searchParams.get('source'), text: buf.toString('utf8') }) });
      } else {
        const buf = await readRaw(req, 200 * 1024 * 1024);
        json(res, 200, { ok: true, ...hub.importFile(url.searchParams.get('name') || '', buf) });
      }
    } catch (e) { json(res, e.status || 400, { ok: false, error: e.message }); }
    return true;
  }
  if (req.method === 'GET' && p === '/api/hub/file') {
    const f = hub.fileOf(url.searchParams.get('id'));
    if (!f) { res.writeHead(404).end(); return true; }
    res.writeHead(200, {
      'content-type': f.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    });
    fs.createReadStream(f.path).pipe(res);
    return true;
  }
  return false;
}

module.exports = { routes, raw, readRaw };
