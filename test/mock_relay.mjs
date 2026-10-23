// Minimal Nostr relay for testing arboard (NIP-01 EVENT/REQ/CLOSE, NIP-09 deletions).
// Verifies every event's signature like a real relay. Usage:
//   node test/mock_relay.mjs 7001,7002,7003      (MOCK_RELAY_REJECT=7003 makes that one refuse events)
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';

const ports = String(process.argv[2] || '7001').split(',').map(Number);
const reject = new Set(String(process.env.MOCK_RELAY_REJECT || '').split(',').filter(Boolean).map(Number));

function matches(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  return true;
}

for (const port of ports) {
  const events = new Map();
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const [type, ...rest] = msg;
      if (type === 'EVENT') {
        const ev = rest[0];
        if (reject.has(port)) return ws.send(JSON.stringify(['OK', ev.id, false, 'blocked: test relay refuses everything']));
        if (!verifyEvent(ev)) {
          console.log(`[${port}] REJECT bad signature ${ev.id?.slice(0, 8)}`);
          return ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']));
        }
        if (ev.kind === 5) {  // NIP-09: delete referenced events by the same author
          for (const t of ev.tags) if (t[0] === 'e' && events.get(t[1])?.pubkey === ev.pubkey) events.delete(t[1]);
        }
        if (ev.kind === 0) for (const [id, e] of events) if (e.kind === 0 && e.pubkey === ev.pubkey) events.delete(id);
        events.set(ev.id, ev);
        console.log(`[${port}] EVENT kind=${ev.kind} ${ev.id.slice(0, 8)} by ${ev.pubkey.slice(0, 8)}`);
        return ws.send(JSON.stringify(['OK', ev.id, true, '']));
      }
      if (type === 'REQ') {
        const [sub, ...filters] = rest;
        const out = [...events.values()].filter((e) => filters.some((f) => matches(e, f)))
          .sort((a, b) => b.created_at - a.created_at);
        const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
        for (const e of out.slice(0, limit)) ws.send(JSON.stringify(['EVENT', sub, e]));
        return ws.send(JSON.stringify(['EOSE', sub]));
      }
    });
  });
  console.log(`mock relay on ws://127.0.0.1:${port}${reject.has(port) ? ' (rejects all)' : ''}`);
}
