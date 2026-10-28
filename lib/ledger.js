'use strict';

// 📈 One line per AI call (data/hub/usage.jsonl, not in git): who, where, how big, and what it cost.
// For Claude the real currency is the subscription window, so each line also carries how far the
// 5-hour and 7-day percentages moved during the call (computer-wide, so other Claude Code windows
// running at the same time add noise). Shape follows the advice in token-toolkit.mjs.

const fs = require('fs');
const path = require('path');

const MAX_ROWS = 50_000; // the report reads the tail only

class Ledger {
  constructor(file) { this.file = file; }
  log(rec) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify({ ts: Date.now(), ...rec })}\n`);
    } catch {} // the books must never break a chat
  }
  rows() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(-MAX_ROWS).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  // Totals per value of a field (member, room, round, mode, model, purpose…), costliest first.
  groupBy(key, rows = this.rows()) {
    const g = new Map();
    for (const r of rows) {
      if (r.event) continue; // events (a session restarted…) are lines of their own, not calls
      const k = r[key] === undefined || r[key] === null ? '(無)' : String(r[key]);
      const a = g.get(k) || { key: k, calls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, pct5h: 0, pct7d: 0, ms: 0 };
      a.calls++;
      a.in += r.in || 0; a.out += r.out || 0;
      a.cacheRead += r.cacheRead || 0; a.cacheWrite += r.cacheWrite || 0;
      a.pct5h += r.pct5hDelta || 0; a.pct7d += r.pct7dDelta || 0;
      a.ms += r.ms || 0;
      g.set(k, a);
    }
    return [...g.values()].map((a) => {
      const all = a.in + a.cacheRead + a.cacheWrite;
      return { ...a, cacheHit: all ? +(a.cacheRead / all).toFixed(2) : 0, pct5h: +a.pct5h.toFixed(1), pct7d: +a.pct7d.toFixed(1) };
    }).sort((a, b) => b.pct5h - a.pct5h || (b.in + b.out + b.cacheWrite) - (a.in + a.out + a.cacheWrite));
  }
  topCalls(n = 10, rows = this.rows()) {
    const size = (r) => (r.in || 0) + (r.out || 0) + (r.cacheWrite || 0);
    return rows.filter((r) => !r.event).sort((a, b) => size(b) - size(a)).slice(0, n);
  }
}

module.exports = { Ledger };
