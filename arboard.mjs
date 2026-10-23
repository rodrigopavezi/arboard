#!/usr/bin/env node
/**
 * arboard — a message channel (text, photos, video, voice) on Arweave + Nostr.
 *
 * Every post is a signed, permanent Arweave item. The channel page is uploaded
 * once and reads the posts straight from an Arweave gateway, so the link never
 * changes and nobody needs to keep a node online.
 *
 * Each post is also published as a signed Nostr note on several relays, so people
 * can follow the channel in any Nostr app (and get notified) — a second, independent
 * way in. Nobody can fake the channel's notes: they're signed with its Nostr key.
 *
 * Networks:
 *   testnet  AR.IO testnet: free items up to the service's free limit, top-ups with
 *            Sepolia ETH. Data is TEMPORARY (purged after ~3 days). For trying it out.
 *   mainnet  Arweave: PERMANENT. Items up to 105 KiB are free; larger ones are paid.
 *
 * Needs: Node 18+, ffmpeg (for photos/video/voice).
 */
// A dependency prints a harmless "bigint: Failed to load bindings" warning on import; hide it.
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes('bigint: Failed to load bindings')) _warn(...a); };
const { TurboFactory, ETHToTokenAmount, solanaOwnerSigner } = await import('@ardrive/turbo-sdk');
console.warn = _warn;
try { TurboFactory.setLogLevel(process.env.ARBOARD_DEBUG ? 'debug' : 'none'); } catch { /* older SDK */ }
const { Wallet } = await import('ethers');
const { generateSecretKey, getPublicKey, finalizeEvent } = await import('nostr-tools/pure');
const nip19 = await import('nostr-tools/nip19');
const { SimplePool, useWebSocketImplementation } = await import('nostr-tools/pool');
const { default: WebSocket } = await import('ws');
useWebSocketImplementation(WebSocket);
const { Keypair } = await import('@solana/web3.js');
const { default: bs58 } = await import('bs58');
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = 'arboard';
const FORMAT_VERSION = '1';
const CONFIG_NAME = 'channel.json';
const WALLET_NAME = 'wallet.json';
const NOSTR_KEY_NAME = 'nostr-key.json';
const ARNS_KEY_NAME = 'arns-owner.json';
const MAINNET_FREE_BYTES = 105 * 1024;
const ITEM_OVERHEAD = 2048; // signature, owner key and tags count toward an item's size

const NETWORKS = {
  testnet: {
    upload: 'https://upload.services.ar-io.dev',
    payment: 'https://payment.services.ar-io.dev',
    gateway: 'https://ar-io.dev',
    nameGateway: 'https://ar-io.dev',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    chain: 'Sepolia',
    chainId: 11155111,
    seeds: [],
  },
  mainnet: {
    upload: 'https://upload.ardrive.io',
    payment: 'https://payment.ardrive.io',
    gateway: 'https://arweave.net',
    // arweave.net serves data and search but does not resolve ArNS names
    // (<name>.arweave.net answers 404), so name links use a gateway that does.
    nameGateway: 'https://turbo-gateway.com',
    rpc: 'https://ethereum-rpc.publicnode.com',
    chain: 'Ethereum mainnet',
    chainId: 1,
    // Well-known gateways to start from; more are discovered from the network.
    seeds: ['https://turbo-gateway.com', 'https://ardrive.net', 'https://ar-io.net', 'https://permagate.io'],
  },
};

// ------------------------------------------------------------------ helpers

function die(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}
const info = (msg = '') => console.log(msg);
const human = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const nowSec = () => String(Math.floor(Date.now() / 1000));

function networkConfig(name) {
  const base = NETWORKS[name];
  if (!base) die(`unknown network '${name}' (use testnet or mainnet)`);
  return {
    name,
    ...base,
    upload: process.env.ARBOARD_UPLOAD_URL || base.upload,
    payment: process.env.ARBOARD_PAYMENT_URL || base.payment,
    gateway: (process.env.ARBOARD_GATEWAY || base.gateway).replace(/\/$/, ''),
    nameGateway: (process.env.ARBOARD_NAME_GATEWAY || process.env.ARBOARD_GATEWAY || base.nameGateway).replace(/\/$/, ''),
    rpc: process.env.ARBOARD_RPC || base.rpc,
  };
}

function findChannel(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_NAME))) return dir;
    const up = path.dirname(dir);
    if (up === dir) die(`no ${CONFIG_NAME} here or in parent folders. Run \`arboard init <folder>\` first.`);
    dir = up;
  }
}

const loadCfg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8'));
const saveCfg = (dir, cfg) => fs.writeFileSync(path.join(dir, CONFIG_NAME), JSON.stringify(cfg, null, 2) + '\n');

function loadWallet(dir, cfg) {
  const p = path.resolve(dir, cfg.wallet || WALLET_NAME);
  if (!fs.existsSync(p)) die(`wallet file not found: ${p}`);
  const { privateKey } = JSON.parse(fs.readFileSync(p, 'utf8'));
  return new Wallet(privateKey);
}

function client(cfg, wallet) {
  const net = networkConfig(cfg.network);
  return TurboFactory.authenticated({
    privateKey: wallet.privateKey,
    token: 'ethereum',
    gatewayUrl: net.rpc,
    uploadServiceConfig: { url: net.upload },
    paymentServiceConfig: { url: net.payment },
  });
}

async function freeLimit(cfg) {
  if (process.env.ARBOARD_FREE_BYTES) return Number(process.env.ARBOARD_FREE_BYTES);
  try {
    const r = await fetch(`${networkConfig(cfg.network).upload}/v1/info`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const n = Number(j.freeUploadLimitBytes ?? j.freeTier?.maxItemBytes);
    if (n > 0) return n;
  } catch { /* fall through */ }
  return MAINNET_FREE_BYTES;
}

function baseTags(cfg, type, contentType) {
  return [
    { name: 'Content-Type', value: contentType },
    { name: 'App-Name', value: APP },
    { name: 'App-Version', value: FORMAT_VERSION },
    { name: 'Channel', value: cfg.channel },
    { name: 'Type', value: type },
    { name: 'Unix-Time', value: nowSec() },
  ];
}

async function upload(turbo, buf, tags, label) {
  try {
    const r = await turbo.uploadFile({
      fileStreamFactory: () => buf,
      fileSizeFactory: () => buf.length,
      dataItemOpts: { tags },
    });
    const paid = r.winc && r.winc !== '0';
    info(`  ↑ ${label}: ${human(buf.length)} ${paid ? `(paid ${r.winc} winc)` : '(free)'}  ${r.id}`);
    return r;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/402|insufficient|FREE_TIER_EXHAUSTED|balance/i.test(msg)) {
      die(`${label}: not enough credit for ${human(buf.length)} (it's over the free size). ` +
        'See `arboard funds` and add credit with `arboard topup <eth>`.');
    }
    die(`${label}: upload failed — ${msg}`);
  }
}

// ------------------------------------------------------------------ media

function ffmpeg(args) {
  const p = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  return p.status === 0 ? null : (p.stderr || 'ffmpeg failed').trim().split('\n').pop();
}

const STRIP = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact',
  '-flags:v', '+bitexact', '-flags:a', '+bitexact'];

/**
 * Convert a media file for the web, removing metadata (GPS, device, dates).
 * Photos and voice notes are squeezed under the free limit when it's reasonable.
 */
function prepareMedia(src, kind, free, tmp) {
  if (!fs.existsSync(src)) die(`file not found: ${src}`);
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    die('ffmpeg is needed to prepare photos, video and audio (and to strip GPS/device metadata).');
  }
  const before = fs.statSync(src).size;
  const out = path.join(tmp, `${crypto.randomUUID()}.${kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'm4a'}`);
  const ladders = {
    image: [[1600, 4], [1600, 7], [1280, 7], [1280, 10], [1024, 12], [960, 16]],
    audio: [64, 48, 32, 24],
    video: [[1280, 28], [960, 30], [854, 32]],
  };
  let err = null;
  for (const step of ladders[kind]) {
    if (kind === 'image') {
      const [w, q] = step;
      err = ffmpeg(['-i', src, ...STRIP, '-vf', `scale='min(${w},iw)':-2`, '-q:v', String(q), '-frames:v', '1', out]);
    } else if (kind === 'audio') {
      err = ffmpeg(['-i', src, ...STRIP, '-vn', '-c:a', 'aac', '-b:a', `${step}k`, '-ac', '1', out]);
    } else {
      const [w, crf] = step;
      err = ffmpeg(['-i', src, ...STRIP, '-vf', `scale='min(${w},iw)':-2`, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
        '-bsf:v', 'filter_units=remove_types=6', '-movflags', '+faststart', out]);
    }
    if (err) die(`couldn't convert ${path.basename(src)}: ${err}`);
    if (fs.statSync(out).size <= free) break;
    if (kind === 'video') break; // video quality isn't worth sacrificing; it's just paid
  }
  const after = fs.statSync(out).size;
  info(`  ${kind}: ${path.basename(src)} (${human(before)} → ${human(after)}${after <= free ? ', free' : ', paid'})`);
  return {
    buf: fs.readFileSync(out),
    type: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/mp4',
  };
}

// ------------------------------------------------------------------ Nostr

// Independent public relays. The channel publishes to all of them; any one is enough
// for readers. Override with ARBOARD_RELAYS or `arboard nostr relays add|remove`.
const DEFAULT_RELAYS = [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social',
  'wss://nostr.mom', 'wss://relay.nostr.net', 'wss://offchain.pub',
];
const RELAY_TIMEOUT_MS = Number(process.env.ARBOARD_RELAY_TIMEOUT_MS || 10000);

function defaultRelays() {
  const env = (process.env.ARBOARD_RELAYS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_RELAYS;
}

function createNostrKey(dir) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const file = path.join(dir, NOSTR_KEY_NAME);
  fs.writeFileSync(file, JSON.stringify({ nsec: nip19.nsecEncode(sk), npub: nip19.npubEncode(pk) }, null, 2) + '\n', { mode: 0o600 });
  return { sk, pk, npub: nip19.npubEncode(pk), file };
}

function loadNostrKey(dir, cfg) {
  const file = path.resolve(dir, cfg.nostr?.key || NOSTR_KEY_NAME);
  if (!fs.existsSync(file)) die(`Nostr key not found: ${file}`);
  const { nsec } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { type, data } = nip19.decode(nsec);
  if (type !== 'nsec') die(`${file} doesn't contain an nsec key`);
  const pk = getPublicKey(data);
  if (cfg.nostr?.npub && nip19.npubEncode(pk) !== cfg.nostr.npub) die(`${file} is not this channel's Nostr key`);
  return { sk: data, pk };
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); t.unref?.(); })])
    .finally(() => clearTimeout(t));
}

const short = (url) => url.replace(/^wss?:\/\//, '');

/** Send an already-signed event to every relay; report how many accepted it. */
async function broadcast(relays, event, label) {
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, event).map((p) => withTimeout(p, RELAY_TIMEOUT_MS)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${short(relays[i])} (${String(r.reason?.message || r.reason).slice(0, 40)})` : null)).filter(Boolean);
    info(`  ⚡ nostr ${label}: accepted by ${ok} of ${relays.length} relays${failed.length ? ` — failed: ${failed.join(', ')}` : ''}`);
    if (!ok) info('    No relay accepted it. The Arweave copy is published; resend later with `arboard nostr resend`.');
    return ok;
  } finally {
    pool.destroy();
  }
}

function signEvent(sk, template) {
  return finalizeEvent({ created_at: Math.floor(Date.now() / 1000), tags: [], ...template }, sk);
}

function nostrProfileEvent(cfg, sk) {
  const link = shareUrl(cfg);
  const about = [cfg.description, `Arquivo permanente (Arweave): ${link}`].filter(Boolean).join('\n\n');
  return signEvent(sk, { kind: 0, content: JSON.stringify({ name: cfg.title, display_name: cfg.title, about, website: link }) });
}

function nostrNoteEvent(cfg, sk, text, media, postId) {
  const gw = networkConfig(cfg.network).gateway;
  const alts = (cfg.fallbacks || []).slice(0, 4);
  const lines = [];
  const tags = [];
  for (const m of [...media.images, ...media.videos, ...media.audios]) {
    const url = `${gw}/${m.id}`;
    lines.push(url);
    // NIP-92: apps that support it try the fallback gateways if the main one fails
    tags.push(['imeta', `url ${url}`, `m ${m.type}`, ...alts.map((g) => `fallback ${g}/${m.id}`)]);
  }
  const content = [text || '', lines.join('\n'), `Arquivo permanente: ${shareUrl(cfg).replace(/\/$/, '')}/#${postId}`]
    .filter(Boolean).join('\n\n');
  return signEvent(sk, { kind: 1, content, tags });
}

/** What the board page reads (from Arweave, signed by the channel wallet). */
function profileJSON(cfg) {
  const p = { title: cfg.title, description: cfg.description || '' };
  if (cfg.nostr) p.nostr = { npub: cfg.nostr.npub, relays: cfg.nostr.relays };
  if (cfg.arns?.name) p.arns = cfg.arns.name;
  return Buffer.from(JSON.stringify(p));
}

// ------------------------------------------------------------------ alternative gateways

const clean = (u) => String(u).replace(/\/+$/, '');

/** Candidate gateways: seeds, extra ones from ARBOARD_GATEWAYS, and peers the gateway knows. */
async function gatewayCandidates(cfg) {
  const net = networkConfig(cfg.network);
  const list = [...net.seeds, ...(process.env.ARBOARD_GATEWAYS || '').split(',').filter(Boolean)];
  for (const from of [...new Set([net.gateway, net.nameGateway])]) try {
    const r = await fetch(`${from}/ar-io/peers`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) continue;
    const j = await r.json();
    const peers = Object.values(j.gateways || {})
      .filter((g) => g && typeof g.url === 'string' && g.url.startsWith('http'))
      .sort((a, b) => (b.dataWeight || 0) - (a.dataWeight || 0))
      .slice(0, 40).map((g) => g.url);
    list.push(...peers);
    break;
  } catch { /* peers list is optional */ }
  return [...new Set(list.map(clean))].filter((u) => u !== net.gateway);
}

/** Gateways that actually answer — with `path` (e.g. the page id) they must serve it. */
async function workingGateways(cfg, path = 'ar-io/healthcheck', want = 5) {
  const found = [];
  const cands = await gatewayCandidates(cfg);
  for (let i = 0; i < cands.length && found.length < want; i += 8) {
    const batch = cands.slice(i, i + 8);
    const ok = await Promise.all(batch.map(async (g) => {
      try {
        const r = await fetch(`${g}/${path}`, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
        return r.ok ? g : null;
      } catch { return null; }
    }));
    found.push(...ok.filter(Boolean));
  }
  return found.slice(0, want);
}

// ------------------------------------------------------------------ ArNS names

// A readable, stable address (https://<name>.turbo-gateway.com) instead of a random id.
// The name is bought with Turbo credits; it's owned by a Solana key generated here,
// which only signs (Turbo pays the Solana fees).

function checkName(raw, network) {
  const name = String(raw || '').trim().toLowerCase();
  if (!name) die('give a name, e.g. `arboard name check noticias-da-familia`');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,49}[a-z0-9])?$/.test(name)) {
    die('names use only a-z, 0-9 and "-" (not at the start or end), up to 51 characters');
  }
  if (name.length === 43) die('names with exactly 43 characters are not allowed (they look like ids)');
  if (network === 'testnet' && name.length < 8) die('on the testnet, names need at least 8 characters');
  return name;
}

function loadOrCreateArnsKey(dir, cfg, create) {
  const file = path.resolve(dir, cfg.arns?.key || ARNS_KEY_NAME);
  if (!fs.existsSync(file)) {
    if (!create) die(`ArNS owner key not found: ${file}`);
    const kp = Keypair.generate();
    fs.writeFileSync(file, JSON.stringify({ secretKey: bs58.encode(kp.secretKey), address: kp.publicKey.toBase58() }, null, 2) + '\n', { mode: 0o600 });
    info(`Created the name's owner key in ${file}`);
  }
  const { secretKey, address } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { signer: solanaOwnerSigner(secretKey), address, file };
}

const winc = (w) => BigInt(String(w || '0').split('.')[0]);
const fmtWinc = (w) => `${(Number(winc(w)) / 1e12).toFixed(6)} AR in credits (${winc(w).toLocaleString('en-US')} winc)`;

async function creditBalance(turbo) {
  try {
    const b = await turbo.getBalance();
    return winc(b.winc ?? b.effectiveBalance ?? b.controlledWinc);
  } catch { return null; }
}

async function namePrices(turbo, name, years) {
  const lease = await turbo.getArNSPriceForName({ intent: 'Buy-Name', name, type: 'lease', years });
  let perma = null;
  try { perma = await turbo.getArNSPriceForName({ intent: 'Buy-Name', name, type: 'permabuy' }); } catch { /* optional */ }
  return { lease, perma };
}

function friendlyArnsError(e) {
  const m = String(e?.message || e);
  if (/402|insufficient/i.test(m)) return 'not enough credit. Add some with `arboard topup <eth>` and try again.';
  if (/taken|exist|unavailable|already|reserved|409/i.test(m)) return `that name isn't available (${m.slice(0, 120)})`;
  return m;
}

async function cmdName(action, o, rest) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  const net = networkConfig(cfg.network);
  const turbo = client(cfg, loadWallet(dir, cfg));
  const years = o.years ? Number(o.years) : 1;
  if (!(years >= 1 && years <= 5 && Number.isInteger(years))) die('--years must be 1 to 5');

  switch (action || 'status') {
    case 'status': {
      if (cfg.arns_pending && !cfg.arns) info(`A purchase is in progress (nonce ${cfg.arns_pending.nonce}). Run \`arboard name resume\`.`);
      if (!cfg.arns) return info('No name yet. Check one with `arboard name check <name>`.');
      const url = shareUrl(cfg);
      info(`Name:   ${cfg.arns.name}  (${cfg.arns.type}${cfg.arns.type === 'lease' ? `, ${cfg.arns.years} year(s) from ${cfg.arns.bought.slice(0, 10)}` : ''})`);
      info(`Link:   ${url}`);
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        const resolved = r.headers.get('x-arns-resolved-id');
        const ok = r.ok && (!resolved || resolved === cfg.page);
        info(`  ${ok ? '✓' : '⚠'} HTTP ${r.status}${resolved ? `, points to ${resolved}${resolved === cfg.page ? ' (the current page)' : ' — NOT the current page; run `arboard name point`'}` : ''}`);
      } catch (e) { info(`  ✗ ${e.message} (a new name can take a few minutes to resolve)`); }
      return;
    }

    case 'check': {
      const name = checkName(rest[0], cfg.network);
      const { lease, perma } = await namePrices(turbo, name, years).catch((e) => die(friendlyArnsError(e)));
      const bal = await creditBalance(turbo);
      const missing = winc(lease.wincTotal) - (bal ?? 0n);
      const ethNeeded = missing > 0n ? await ethFor(turbo, missing) : '0';
      if (o.json) {
        return info(JSON.stringify({ name, url: nameUrl(name, net.nameGateway), lease_winc: String(lease.wincTotal),
          permanent_winc: perma ? String(perma.wincTotal) : null, credit_winc: bal === null ? null : String(bal),
          enough: bal !== null && bal >= winc(lease.wincTotal), eth_needed: ethNeeded, chain: net.chain }));
      }
      info(`Name:       ${name}  →  ${nameUrl(name, net.nameGateway)}`);
      info(`Lease ${years}y:   ${fmtWinc(lease.wincTotal)}`);
      if (perma) info(`Permanent:  ${fmtWinc(perma.wincTotal)}`);
      if (bal !== null) {
        info(`Your credit: ${fmtWinc(bal)}${bal < winc(lease.wincTotal) ? '  — not enough yet' : ''}`);
        if (missing > 0n && ethNeeded) info(`To cover it: about ${ethNeeded} ${net.chain} ETH → \`arboard topup ${ethNeeded}\` (plus a little ETH for gas)`);
      }
      info(`Buy with:   arboard name buy ${name}${years !== 1 ? ` --years ${years}` : ''} --yes   (or --permanent)`);
      return;
    }

    case 'buy': {
      if (cfg.arns) die(`this channel already has the name '${cfg.arns.name}'.`);
      if (cfg.arns_pending) die(`a purchase is already in progress (nonce ${cfg.arns_pending.nonce}). Run \`arboard name resume\`.`);
      const name = checkName(rest[0], cfg.network);
      const type = o.permanent ? 'permabuy' : 'lease';
      const price = await turbo.getArNSPriceForName(type === 'lease'
        ? { intent: 'Buy-Name', name, type, years } : { intent: 'Buy-Name', name, type })
        .catch((e) => die(friendlyArnsError(e)));
      info(`${name} (${type === 'lease' ? `${years}-year lease` : 'permanent'}) costs ${fmtWinc(price.wincTotal)}.`);
      if (!o.yes) die('this spends upload credit and can\'t be undone. Re-run with --yes to buy.');
      const bal = await creditBalance(turbo);
      if (bal !== null && bal < winc(price.wincTotal)) {
        info(`Your credit: ${fmtWinc(bal)} — not enough.`);
        if (!canAsk()) die(friendlyArnsError('insufficient'));
        if (!(await guidedTopup(cfg, loadWallet(dir, cfg), turbo, winc(price.wincTotal) - bal, `the name ${name}`))) {
          die('the name was not bought. Try again when the credit is there.');
        }
      }
      const owner = loadOrCreateArnsKey(dir, cfg, true);
      info('Buying… (one signature from the name\'s owner key; can take a minute)');
      let result;
      try {
        result = await turbo.buyArNSName({
          name, owner: owner.signer, type, ...(type === 'lease' ? { years } : {}),
          antState: { transactionId: cfg.page },   // the name points at the board from the start
          onNonce: (nonce) => { cfg.arns_pending = { nonce, name, type, years, at: new Date().toISOString() }; saveCfg(dir, cfg); },
        });
      } catch (e) {
        const msg = friendlyArnsError(e);
        if (cfg.arns_pending) die(`${msg}\nThe purchase was started (nonce ${cfg.arns_pending.nonce}); don't buy again — run \`arboard name resume\`.`);
        die(msg);
      }
      await nameBought(dir, cfg, turbo, { name, type, years, antId: result.antId, owner: owner.address, nonce: result.nonce });
      return;
    }

    case 'resume': {
      const pend = cfg.arns_pending;
      if (!pend) return info('No purchase in progress.');
      const st = await turbo.getArNSActionStatus(pend.nonce);
      if (st.status === 'completed') {
        const owner = loadOrCreateArnsKey(dir, cfg, false);
        return nameBought(dir, cfg, turbo, { ...pend, antId: st.antId, owner: owner.address });
      }
      if (st.status === 'awaiting-signature' && st.transaction) {
        const owner = loadOrCreateArnsKey(dir, cfg, false);
        const done = await turbo.signArNSAction(pend.nonce, await owner.signer.signTransaction(st.transaction));
        return nameBought(dir, cfg, turbo, { ...pend, antId: done.antId, owner: owner.address });
      }
      if (st.failedDate) { delete cfg.arns_pending; saveCfg(dir, cfg); return info(`That purchase failed (${st.failedDate}); credits for abandoned actions are refunded. You can try again.`); }
      return info(`Status: ${st.status}. Try again in a minute.`);
    }

    case 'extend': {
      if (!cfg.arns) die('this channel has no name yet.');
      if (cfg.arns.type !== 'lease') return info('This name is permanent; there is nothing to renew.');
      const price = await turbo.getArNSPriceForName({ intent: 'Extend-Lease', name: cfg.arns.name, years })
        .catch((e) => die(friendlyArnsError(e)));
      info(`Adding ${years} year(s) to ${cfg.arns.name} costs ${fmtWinc(price.wincTotal)}.`);
      if (!o.yes) die('re-run with --yes to renew.');
      await turbo.extendArNSLease({ name: cfg.arns.name, years }).catch((e) => die(friendlyArnsError(e)));
      cfg.arns.years = (cfg.arns.years || 0) + years;
      saveCfg(dir, cfg);
      return info(`Renewed: ${cfg.arns.name} now has ${cfg.arns.years} year(s) counted from ${cfg.arns.bought.slice(0, 10)}.`);
    }

    case 'point': {
      if (!cfg.arns) die('this channel has no name yet.');
      await pointName(dir, cfg, turbo);
      return;
    }

    default: die('use: arboard name [status|check <name>|buy <name> --yes [--years N|--permanent]|extend --years N --yes|resume|point]');
  }
}

async function pointName(dir, cfg, turbo) {
  const owner = loadOrCreateArnsKey(dir, cfg, false);
  await turbo.setArNSRecord({ antId: cfg.arns.antId, owner: owner.signer, transactionId: cfg.page, ttlSeconds: 900 });
  cfg.arns.target = cfg.page;
  saveCfg(dir, cfg);
  info(`  ↪ ${cfg.arns.name} now points to the current page (${cfg.page}).`);
}

async function nameBought(dir, cfg, turbo, a) {
  cfg.arns = { name: a.name, type: a.type, years: a.type === 'lease' ? a.years : undefined, antId: a.antId,
    owner: a.owner, key: ARNS_KEY_NAME, target: cfg.page, bought: new Date().toISOString(), nonce: a.nonce };
  delete cfg.arns_pending;
  saveCfg(dir, cfg);
  info(`Bought! ${a.name} → ${shareUrl(cfg)}`);
  // Point it explicitly: some deployments ignore the target sent with the purchase,
  // and the name would show the gateway's placeholder page instead of the board.
  await pointName(dir, cfg, turbo).catch((e) =>
    info(`  ⚠ couldn't point the name at the board yet (${friendlyArnsError(e)}). Run \`arboard name point\`.`));
  info('  (gateways may cache the old target for up to an hour — reload later if you see a placeholder page)');
  // Tell the board and the Nostr profile about the new address.
  await upload(turbo, profileJSON(cfg), baseTags(cfg, 'profile', 'application/json'), 'channel info');
  await refreshNostrProfile(dir, cfg);
  info('');
  info(`Share this link from now on: ${shareUrl(cfg)}`);
  info(`BACK UP ${path.join(dir, ARNS_KEY_NAME)} — it owns the name.`);
  if (cfg.network === 'testnet') info('Testnet: the name keeps resolving, but the page it points to is deleted after ~3 days.');
  if (a.type === 'lease') info(`The lease lasts ${a.years} year(s). Renew before it ends with \`arboard name extend --years N --yes\`.`);
}

// ------------------------------------------------------------------ page

function buildPage(cfg) {
  const tpl = fs.readFileSync(path.join(HERE, 'channel-template.html'), 'utf8');
  const conf = {
    app: APP, channel: cfg.channel, owner: cfg.owner, owners: channelOwners(cfg),
    gateway: networkConfig(cfg.network).gateway, network: cfg.network,
    title: cfg.title, description: cfg.description || '',
    fallbacks: cfg.fallbacks || [],
  };
  // JSON inside <script type="application/json">; escape "<" so content can't close the tag
  const json = JSON.stringify(conf).replace(/</g, '\\u003c');
  if (!tpl.includes('__ARBOARD_CONFIG__')) die('channel-template.html is missing its config marker');
  cfg.page_owners_fixed = true;
  return Buffer.from(tpl.replace('__ARBOARD_CONFIG__', json), 'utf8');
}

/**
 * The addresses gateways may list as the owner of this channel's items. Items signed with
 * an Ethereum wallet are indexed under the wallet's checksummed 0x address on AR.IO
 * gateways; the upload service reports a base64url id. Accept both.
 */
const channelOwners = (cfg) => [...new Set([cfg.eth_address, cfg.owner].filter(Boolean))];

const pageUrl = (cfg) => `${networkConfig(cfg.network).gateway}/${cfg.page}`;
/** https://<name>.<gateway host>/ — any AR.IO gateway resolves the same name. */
const nameUrl = (name, gateway) => { const u = new URL(gateway); return `${u.protocol}//${name}.${u.host}/`; };
/** The link to share: the ArNS name if the channel has one, else the page id. */
const shareUrl = (cfg) => (cfg.arns?.name ? nameUrl(cfg.arns.name, networkConfig(cfg.network).nameGateway) : pageUrl(cfg));

// ------------------------------------------------------------------ commands

async function cmdInit(folder, o) {
  const dir = path.resolve(folder);
  if (fs.existsSync(path.join(dir, CONFIG_NAME))) die(`${dir} is already a channel`);
  fs.mkdirSync(dir, { recursive: true });
  const network = o.network || 'testnet';
  networkConfig(network);

  let walletRel = WALLET_NAME;
  let wallet;
  if (o.wallet) {
    walletRel = path.relative(dir, path.resolve(o.wallet));
    wallet = new Wallet(JSON.parse(fs.readFileSync(path.resolve(o.wallet), 'utf8')).privateKey);
    info(`Using wallet ${o.wallet}`);
  } else {
    wallet = Wallet.createRandom();
    const wp = path.join(dir, WALLET_NAME);
    fs.writeFileSync(wp, JSON.stringify({ privateKey: wallet.privateKey, address: wallet.address }, null, 2) + '\n', { mode: 0o600 });
    info(`Created a new wallet (${wallet.address}) in ${wp}`);
  }

  const cfg = {
    title: o.title || 'Meu canal',
    description: o.description || '',
    network,
    channel: crypto.randomUUID(),
    wallet: walletRel,
    eth_address: wallet.address,
    posts: [],
  };
  let nkey = null;
  if (!o['no-nostr']) {
    nkey = createNostrKey(dir);
    cfg.nostr = { npub: nkey.npub, key: NOSTR_KEY_NAME, relays: defaultRelays() };
    info(`Created a Nostr key for the channel (${nkey.npub}) in ${nkey.file}`);
  }
  const turbo = client(cfg, wallet);
  info(`Publishing to ${network}…`);

  // The profile item is uploaded first: its response tells us the owner address the
  // gateways will index, which the page needs in order to trust only your posts.
  const profile = await upload(turbo, profileJSON(cfg), baseTags(cfg, 'profile', 'application/json'), 'channel info');
  cfg.owner = profile.owner;
  cfg.fallbacks = await workingGateways(cfg, 'ar-io/healthcheck', 8);
  if (cfg.fallbacks.length) info(`  found ${cfg.fallbacks.length} alternative gateway(s) for the page to fall back on`);
  const page = await upload(turbo, buildPage(cfg), baseTags(cfg, 'page', 'text/html'), 'channel page');
  cfg.page = page.id;
  saveCfg(dir, cfg);
  if (nkey) {
    const ev = nostrProfileEvent(cfg, nkey.sk);
    cfg.nostr.profile_event = ev;
    saveCfg(dir, cfg);
    await broadcast(cfg.nostr.relays, ev, 'profile');
  }

  info('');
  info(`Channel ready. Its permanent link:\n  ${pageUrl(cfg)}`);
  info('');
  if (cfg.nostr) info(`On Nostr:  ${cfg.nostr.npub}  (https://njump.me/${cfg.nostr.npub})`);
  info('');
  info(`BACK UP ${path.join(dir, walletRel)}${cfg.nostr ? ` and ${path.join(dir, NOSTR_KEY_NAME)}` : ''} — they are the only keys that can post to this channel.`);
  if (network === 'testnet') {
    info('Testnet: the Arweave side is deleted after ~3 days. Nostr notes are on the real relays, so their media links');
    info('will break after that. Use --network mainnet for a permanent channel.');
  }
  info('Next: arboard post "Primeira mensagem"');
}

async function cmdPost(text, o) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  const images = o.image || [], videos = o.video || [], audios = o.audio || [];
  if (!text && !images.length && !videos.length && !audios.length) die('nothing to post — give text and/or -i/-v/-a files');
  const wallet = loadWallet(dir, cfg);
  const turbo = client(cfg, wallet);
  const free = await freeLimit(cfg);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arboard-'));
  try {
    const media = { images: [], videos: [], audios: [] };
    const prepared = [];
    for (const [kind, list, key] of [['image', images, 'images'], ['audio', audios, 'audios'], ['video', videos, 'videos']]) {
      for (const f of list) prepared.push({ kind, key, ...prepareMedia(f, kind, free - ITEM_OVERHEAD, tmp) });
    }
    // Paid files (over the free size): check the credit before uploading anything.
    const paid = prepared.filter((m) => m.buf.length + ITEM_OVERHEAD > free);
    if (paid.length) {
      const what = paid.length === 1 ? `this ${paid[0].kind} (${human(paid[0].buf.length)})` : `these ${paid.length} files`;
      await ensureCredit(cfg, wallet, turbo, paid.map((m) => m.buf.length + ITEM_OVERHEAD), what);
    }
    for (const m of prepared) {
      const r = await upload(turbo, m.buf, baseTags(cfg, 'media', m.type), m.kind);
      media[m.key].push({ id: r.id, type: m.type });
    }
    const created = new Date().toISOString();
    const post = { v: 1, text: text || '', created };
    for (const k of Object.keys(media)) if (media[k].length) post[k] = media[k];
    const r = await upload(turbo, Buffer.from(JSON.stringify(post)), baseTags(cfg, 'post', 'application/json'), 'post');
    if (cfg.owner && r.owner && r.owner !== cfg.owner) {
      die(`this upload was signed by a different owner (${r.owner}) than the channel's (${cfg.owner}). Wrong wallet?`);
    }
    const entry = { id: r.id, created, text: (text || '').slice(0, 120),
      media: Object.fromEntries(Object.entries(media).map(([k, v]) => [k, v.length]).filter(([, n]) => n)) };
    cfg.posts.unshift(entry);
    saveCfg(dir, cfg);
    if (cfg.nostr && !o['no-nostr']) {
      const { sk } = loadNostrKey(dir, cfg);
      const ev = nostrNoteEvent(cfg, sk, text, media, r.id);
      entry.nostr_event = ev;   // kept so it can be re-sent to relays later, unchanged
      saveCfg(dir, cfg);
      await broadcast(cfg.nostr.relays, ev, 'note');
    }
    info('');
    info(`Posted. It shows up on the channel within seconds to a few minutes:\n  ${shareUrl(cfg)}`);
    if (!o['no-balance']) await creditReport(cfg, wallet, turbo);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function cmdList(o) {
  const cfg = loadCfg(findChannel(o.channel));
  if (!cfg.posts.length) return info('No posts yet.');
  for (const p of cfg.posts) {
    const m = Object.entries(p.media || {}).map(([k, n]) => `${n} ${k.slice(0, -1)}${n > 1 ? 's' : ''}`).join(', ');
    info(`${p.id}  ${p.removed ? '[removed] ' : ''}${p.text.replace(/\n/g, ' ').slice(0, 60)}${m ? `  [${m}]` : ''}`);
  }
}

async function cmdRemove(id, o) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  const p = cfg.posts.find((x) => x.id === id);
  if (!p) die(`no post ${id} (see \`arboard list\`)`);
  const turbo = client(cfg, loadWallet(dir, cfg));
  const tags = [...baseTags(cfg, 'delete', 'application/json'), { name: 'Target', value: id }];
  await upload(turbo, Buffer.from('{}'), tags, 'removal notice');
  p.removed = true;
  saveCfg(dir, cfg);
  if (cfg.nostr && p.nostr_event) {
    const { sk } = loadNostrKey(dir, cfg);
    const del = signEvent(sk, { kind: 5, content: 'removed', tags: [['e', p.nostr_event.id], ['k', '1']] });
    p.nostr_delete_event = del;
    saveCfg(dir, cfg);
    await broadcast(cfg.nostr.relays, del, 'deletion request');
    info('Nostr: relays and apps that honor deletion requests hide it; copies others already saved may remain.');
  }
  info('Hidden from the channel page. Note: on Arweave the original post itself is permanent —');
  info(`anyone with its id can still open ${networkConfig(cfg.network).gateway}/${id}`);
}

async function cmdTitle(title, o) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  if (title) cfg.title = title;
  if (o.description !== undefined) cfg.description = o.description;
  const turbo = client(cfg, loadWallet(dir, cfg));
  await upload(turbo, profileJSON(cfg), baseTags(cfg, 'profile', 'application/json'), 'channel info');
  saveCfg(dir, cfg);
  await refreshNostrProfile(dir, cfg);
  info('Updated. The page shows the new title/description on next load.');
}

async function refreshNostrProfile(dir, cfg) {
  if (!cfg.nostr) return;
  const { sk } = loadNostrKey(dir, cfg);
  cfg.nostr.profile_event = nostrProfileEvent(cfg, sk);
  saveCfg(dir, cfg);
  await broadcast(cfg.nostr.relays, cfg.nostr.profile_event, 'profile');
}

async function cmdNostr(action, o, rest) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  if (!cfg.nostr) die('this channel was created without Nostr (--no-nostr).');
  const n = cfg.nostr;
  switch (action || 'status') {
    case 'status': {
      info(`Nostr profile: ${n.npub}`);
      info(`  in apps:     nostr:${n.npub}`);
      info(`  on the web:  https://njump.me/${n.npub}`);
      info('Checking each relay for the channel profile and latest note…');
      const { pk } = loadNostrKey(dir, cfg);
      const pool = new SimplePool();
      try {
        await Promise.all(n.relays.map(async (r) => {
          try {
            const evs = await withTimeout(pool.querySync([r], { authors: [pk], kinds: [0, 1], limit: 50 }, { maxWait: RELAY_TIMEOUT_MS }), RELAY_TIMEOUT_MS + 2000);
            const notes = evs.filter((e) => e.kind === 1).length;
            const prof = evs.some((e) => e.kind === 0);
            info(`  ${prof ? '✓' : '⚠'} ${short(r)}: profile ${prof ? 'yes' : 'no'}, ${notes} note(s)`);
          } catch (e) { info(`  ✗ ${short(r)}: ${String(e.message || e).slice(0, 60)}`); }
        }));
      } finally { pool.destroy(); }
      const sent = cfg.posts.filter((p) => p.nostr_event && !p.removed).length;
      info(`Posts with a Nostr note: ${sent} of ${cfg.posts.filter((p) => !p.removed).length}`);
      return;
    }
    case 'resend': {
      // Re-send the exact same signed events (same ids) — e.g. after adding relays or an outage.
      // Removed posts: send only their deletion request, never the note itself.
      const evs = [n.profile_event, ...cfg.posts.map((p) => (p.removed ? p.nostr_delete_event : p.nostr_event))].filter(Boolean);
      if (!evs.length) return info('Nothing to resend.');
      for (const ev of evs) await broadcast(n.relays, ev, ev.kind === 0 ? 'profile' : ev.kind === 5 ? 'deletion' : 'note');
      const missing = cfg.posts.filter((p) => !p.nostr_event && !p.removed);
      if (missing.length) info(`${missing.length} post(s) have no Nostr note (posted with --no-nostr). Use \`arboard nostr publish <post-id>\`.`);
      return;
    }
    case 'publish': {
      const id = rest[0];
      const p = cfg.posts.find((x) => x.id === id);
      if (!p) die(`no post ${id} (see \`arboard list\`)`);
      if (p.nostr_event) return info('That post already has a Nostr note. Use `arboard nostr resend` to send it again.');
      const r = await fetch(`${networkConfig(cfg.network).gateway}/${id}`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) die(`couldn't read the post from the gateway (HTTP ${r.status})`);
      const body = await r.json();
      const media = { images: body.images || [], videos: body.videos || [], audios: body.audios || [] };
      const { sk } = loadNostrKey(dir, cfg);
      p.nostr_event = nostrNoteEvent(cfg, sk, body.text, media, id);
      saveCfg(dir, cfg);
      await broadcast(n.relays, p.nostr_event, 'note');
      return;
    }
    case 'relays': {
      const [op, url] = rest;
      if (!op) { n.relays.forEach((r) => info(r)); return; }
      if (!/^wss?:\/\/[^\s]+$/.test(url || '')) die('give a relay URL like wss://relay.example.com');
      if (op === 'add') { if (!n.relays.includes(url)) n.relays.push(url); }
      else if (op === 'remove') n.relays = n.relays.filter((r) => r !== url);
      else die('use: arboard nostr relays [add|remove <wss://…>]');
      saveCfg(dir, cfg);
      const turbo = client(cfg, loadWallet(dir, cfg));
      await upload(turbo, profileJSON(cfg), baseTags(cfg, 'profile', 'application/json'), 'channel info');
      info(`Relays: ${n.relays.length}. Run \`arboard nostr resend\` to copy past posts to ${op === 'add' ? 'the new relay' : 'the remaining relays'}.`);
      return;
    }
    default: die('use: arboard nostr [status|resend|publish <post-id>|relays [add|remove <url>]]');
  }
}

async function cmdStatus(o) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  const net = networkConfig(cfg.network);
  const wallet = loadWallet(dir, cfg);
  const turbo = client(cfg, wallet);
  info(`Channel:   ${cfg.title}  (${dir})`);
  info(`Network:   ${cfg.network}${cfg.network === 'testnet' ? '  — TEMPORARY, deleted after ~3 days' : '  — permanent'}`);
  info(`Link:      ${shareUrl(cfg)}${cfg.arns ? `   (page id: ${pageUrl(cfg)})` : ''}`);
  if (!cfg.arns) info('           tip: a readable name avoids antivirus false alarms — `arboard name check <name>`');
  info(`Posts:     ${cfg.posts.filter((p) => !p.removed).length}`);
  info(`Nostr:     ${cfg.nostr ? `${cfg.nostr.npub}  (${cfg.nostr.relays.length} relays — details: arboard nostr)` : 'off'}`);
  info(`Wallet:    ${wallet.address}  (fund with ${net.chain} ETH for paid uploads)`);
  try {
    const b = await turbo.getBalance();
    info(`Credit:    ${b.winc ?? b.effectiveBalance ?? b.controlledWinc} winc`);
  } catch (e) { info(`Credit:    couldn't check (${String(e.message || e).slice(0, 80)})`); }
  try {
    const f = await turbo.getFreeStatus();
    const left = f?.remainingFreeBytes ?? f?.freeBytesRemaining ?? f?.remaining;
    if (left !== undefined) info(`Free left: ${left === null ? 'unlimited' : human(Number(left))}`);
  } catch { /* optional */ }
  const fl = await freeLimit(cfg);
  info(`Free size: items up to ${fl >= 1048576 ? `${(fl / 1048576).toFixed(0)} MiB` : `${Math.round(fl / 1024)} KiB`} upload free`);

  if (o.check) {
    info('');
    info(`Checking the channel like a visitor (page: ${new URL(shareUrl(cfg)).host}, search: ${new URL(net.gateway).host})…`);
    const t0 = Date.now();
    try {
      const r = await fetch(shareUrl(cfg), { signal: AbortSignal.timeout(60000) });
      info(`  ${r.ok ? '✓' : '✗'} page: HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) { info(`  ✗ page: ${e.message}`); }
    try {
      const n = await countPosts(net.gateway, cfg);
      const expect = cfg.posts.length;
      info(`  ${n >= expect ? '✓' : '⚠'} posts indexed: ${n} of ${expect}${n < expect ? ' (new posts can take a few minutes)' : ''}`);
      if (!cfg.page_owners_fixed && cfg.eth_address) {
        info('  ⚠ this channel\'s page was made by an older arboard that can miss your posts. Run `arboard republish-page` (free).');
      }
    } catch (e) { info(`  ✗ search (GraphQL): ${e.message}`); }
    info('');
    await printLinks(cfg);
  }
}

async function countPosts(gateway, cfg) {
  const query = `query($owners:[String!],$channel:String!,$after:String){transactions(first:100,after:$after,owners:$owners,tags:[{name:"App-Name",values:["${APP}"]},{name:"Channel",values:[$channel]},{name:"Type",values:["post"]}]){pageInfo{hasNextPage}edges{cursor node{id}}}}`;
  let n = 0, after = null;
  for (let page = 0; page < 50; page++) {
    const r = await fetch(`${gateway}/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { owners: channelOwners(cfg), channel: cfg.channel, after } }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const t = (await r.json()).data.transactions;
    n += t.edges.length;
    if (!t.pageInfo?.hasNextPage || !t.edges.length) break;
    after = t.edges[t.edges.length - 1].cursor;
  }
  return n;
}

async function printLinks(cfg) {
  const net = networkConfig(cfg.network);
  info(`Checking which gateways serve the channel… (main: ${net.gateway})`);
  const byIp = (g) => /^\[|^\d+\.\d+\.\d+\.\d+$/.test(new URL(g).hostname);
  let links;
  if (cfg.arns) {
    // Test the name address itself: some gateways serve data but don't resolve names.
    const main = shareUrl(cfg);
    const cands = (await gatewayCandidates(cfg)).filter((g) => !byIp(g))
      .map((g) => nameUrl(cfg.arns.name, g)).filter((u) => u !== main).slice(0, 16);
    const ok = await Promise.all(cands.map(async (u) => {
      try { return (await fetch(u, { signal: AbortSignal.timeout(10000) })).ok; } catch { return false; }
    }));
    links = cands.filter((_, i) => ok[i]).slice(0, 6);
  } else {
    links = (await workingGateways(cfg, cfg.page, 6)).map((g) => `${g}/${cfg.page}`);
  }
  if (!links.length) {
    info(cfg.network === 'testnet'
      ? '  The testnet has a single gateway, so there are no alternative links. On mainnet there are many.'
      : '  No alternative gateway answered right now; try again later.');
    return;
  }
  info('If the main link is blocked, the same channel opens at:');
  for (const u of links) info(`  ${u}`);
}

async function cmdLinks(o) {
  const cfg = loadCfg(findChannel(o.channel));
  info(`Main link: ${shareUrl(cfg)}`);
  await printLinks(cfg);
}

/** ETH on the channel wallet (as a string), or null if the RPC can't be reached. */
async function walletEth(net, address) {
  const { JsonRpcProvider, formatEther } = await import('ethers');
  let provider;
  try {
    provider = new JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true });
    return formatEther(await withTimeout(provider.getBalance(address), 15000));
  } catch { return null; } finally {
    provider?.destroy();   // otherwise ethers keeps retrying and the command never exits
  }
}

/** How much ETH buys `wincNeeded` credit (with a 15% margin for price moves), or null. */
async function ethFor(turbo, wincNeeded) {
  if (wincNeeded <= 0n) return '0';
  try {
    const r = await withTimeout(turbo.getWincForToken({ tokenAmount: ETHToTokenAmount(1) }), 15000);
    const perEth = winc(r.winc);
    if (perEth <= 0n) return null;
    const eth = (Number(wincNeeded) / Number(perEth)) * 1.15;
    return eth < 0.0001 ? '0.0001' : eth.toPrecision(2);
  } catch { return null; }
}

// ------------------------------------------------------------------ funding (interactive)

const GAS_RESERVE = Number(process.env.ARBOARD_GAS_RESERVE || 0.0004);   // ETH left for the transfer's gas
const canAsk = () => Boolean(process.stdin.isTTY || process.env.ARBOARD_INTERACTIVE === '1');

// One line reader for the whole run (piped input would lose lines with several readers).
let rl = null; const lines = []; const waiters = [];
function ask(q) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
    rl.on('close', () => { while (waiters.length) waiters.shift()(null); });
  }
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(lines.shift().trim());
  return new Promise((res) => waiters.push((l) => { if (l === null) process.stdout.write('\n'); res(l === null ? null : l.trim()); }));
}
const closePrompt = () => rl?.close();
const yes = (a) => /^[sy]/i.test(a || '');

const fmtEth = (n) => Number(n).toFixed(6).replace(/\.?0+$/, '');

/** Price of uploading items of these sizes (bytes), in winc. */
async function uploadCost(turbo, sizes) {
  const r = await withTimeout(turbo.getUploadCosts({ bytes: sizes }), 20000);
  return r.reduce((a, x) => a + winc(x.winc), 0n);
}

/** Send `amount` ETH from the channel wallet to Turbo for credit. Throws a readable error. */
async function doTopup(cfg, wallet, amount) {
  const net = networkConfig(cfg.network);
  const have = await walletEth(net, wallet.address);
  if (have !== null && Number(have) <= Number(amount)) {
    throw new Error(`the channel wallet has ${have} ${net.chain} ETH — it needs a bit more than ${amount} (the amount plus gas).\n` +
      `Send ${net.chain} ETH to ${wallet.address}${cfg.network === 'testnet' ? ' (from a Sepolia faucet)' : ''}, wait for it to arrive ` +
      `(\`arboard funds\` shows the balance), then try again.`);
  }
  info(`Sending ${amount} ${net.chain} ETH from ${wallet.address} to buy upload credit… (can take a few minutes)`);
  try {
    const r = await client(cfg, wallet).topUpWithTokens({ tokenAmount: ETHToTokenAmount(amount) });
    info(`Done: ${r.status || 'submitted'} — tx ${r.id}${r.winc ? `, +${fmtWinc(r.winc)}` : ''}`);
    return r;
  } catch (e) {
    const m = String(e.message || e);
    if (/insufficient funds|CALL_EXCEPTION|missing revert data/i.test(m)) {
      throw new Error(`the wallet doesn't have enough ${net.chain} ETH for ${amount} plus gas. Send more to ${wallet.address} and try again.`);
    }
    throw new Error(`top-up failed: ${m}\n(The wallet needs ${amount} ${net.chain} ETH plus gas: ${wallet.address})`);
  }
}

/**
 * Walk the user through adding credit: show the wallet, wait for ETH to arrive,
 * convert it, and wait for the credit to show up. `needWinc` (optional) is how much
 * more credit is needed. Returns true when the credit is there.
 */
async function guidedTopup(cfg, wallet, turbo, needWinc = 0n, why = '') {
  const net = networkConfig(cfg.network);
  const suggested = needWinc > 0n ? await ethFor(turbo, needWinc) : null;
  const want = suggested ? Number(suggested) : 0;
  info('');
  info(`── Add funds${why ? ` for ${why}` : ''}`);
  info(`Send ${net.chain} ETH to the channel wallet:`);
  info('');
  info(`    ${wallet.address}`);
  info('');
  if (suggested) info(`About ${suggested} ETH covers it, plus ~${GAS_RESERVE} ETH that stays on the wallet for gas.`);
  else info(`Any amount works; ~${GAS_RESERVE} ETH stays on the wallet for gas.`);
  if (cfg.network === 'testnet') info('Free test ETH, no sign-up: https://sepolia-faucet.pk910.de');
  else info('Privacy: ETH that comes from an exchange account with your ID links this wallet to you.');

  let eth = await walletEth(net, wallet.address);
  const enoughEth = () => eth !== null && Number(eth) - GAS_RESERVE >= (want || 1e-9);
  while (!enoughEth()) {
    info(`ETH on the wallet: ${eth === null ? "couldn't check" : fmtEth(eth)}${want ? ` (needs ~${fmtEth(want + GAS_RESERVE)})` : ''}`);
    const a = await ask("Send the ETH, then press Enter to check again (or type 'skip'): ");
    if (a === null || /^(skip|pular|q|quit|n)$/i.test(a)) return false;
    eth = await walletEth(net, wallet.address);
  }
  const max = Number(eth) - GAS_RESERVE;
  info(`ETH on the wallet: ${fmtEth(eth)}`);
  let amount = fmtEth(Math.min(want || max, max));
  for (;;) {
    const a = await ask(`How much to convert into upload credit? (max ${fmtEth(max)}) [${amount}]: `);
    if (a === null) return false;
    const n = Number((a || amount).replace(',', '.'));
    if (n > 0 && n <= max + 1e-12) { amount = fmtEth(n); break; }
    info(`Use a number between 0 and ${fmtEth(max)} (the rest pays the gas).`);
  }
  if (cfg.network === 'mainnet') {
    const a = await ask(`Convert ${amount} ETH (real money) into upload credit? [y/N] `);
    if (!yes(a)) return false;
  }
  const before = (await creditBalance(turbo)) ?? 0n;
  try { await doTopup(cfg, wallet, amount); } catch (e) { info(`error: ${e.message}`); return false; }

  // The credit shows up once the transfer confirms.
  const target = needWinc > 0n ? before + needWinc : before + 1n;
  process.stdout.write('Waiting for the credit to show up');
  const polls = Number(process.env.ARBOARD_CREDIT_POLLS || 30);
  for (let i = 0; i < polls; i++) {
    const b = await creditBalance(turbo);
    if (b !== null && b >= target) { info(` ✓\nCredit: ${fmtWinc(b)}`); return true; }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, Number(process.env.ARBOARD_CREDIT_POLL_MS || 10000)));
  }
  info('\nThe credit hasn\'t shown up yet (it can take a few more minutes). Check with `arboard funds`.');
  return false;
}

/** Make sure there's credit for uploading items of these sizes; offer to add funds if not. */
async function ensureCredit(cfg, wallet, turbo, sizes, what) {
  const cost = await uploadCost(turbo, sizes).catch(() => null);
  const bal = await withTimeout(creditBalance(turbo), 20000).catch(() => null);
  if (cost === null || bal === null) return;   // can't check now; the upload itself will tell
  if (bal >= cost) return info(`  credit: ${fmtWinc(bal)} — enough (${what} costs ${winc(cost).toLocaleString('en-US')} winc)`);
  const net = networkConfig(cfg.network);
  info(`  ${what} is paid: ${fmtWinc(cost)}. Your credit: ${fmtWinc(bal)} — not enough.`);
  if (!canAsk()) {
    const eth = await ethFor(turbo, cost - bal);
    die(`not enough credit for ${what}. Send ${net.chain} ETH to ${wallet.address}, then \`arboard topup ${eth || '<eth>'}${cfg.network === 'mainnet' ? ' --yes' : ''}\` (or just \`arboard topup\` in a terminal).`);
  }
  if (!(await guidedTopup(cfg, wallet, turbo, cost - bal, what))) die(`nothing was posted (${what} needs credit). Add it any time with \`arboard topup\`.`);
}

/** One or two lines after posting: credit left, in terms people can use. */
async function creditReport(cfg, wallet, turbo) {
  try {
    const net = networkConfig(cfg.network);
    const [bal, perMB, eth] = await Promise.all([
      withTimeout(creditBalance(turbo), 15000), uploadCost(turbo, [1048576]), walletEth(net, wallet.address)]);
    if (bal === null) return;
    const mb = perMB > 0n ? Number(bal) / Number(perMB) : 0;
    const room = mb >= 1 ? `about ${mb >= 10 ? Math.floor(mb) : mb.toFixed(1)} MB of video` : mb > 0 ? `about ${Math.round(mb * 1024)} KB of video` : 'no paid uploads';
    info(`Credit:    ${fmtWinc(bal)} — ${room}. Text, photos and voice notes are free.`);
    if (eth !== null && Number(eth) > GAS_RESERVE) info(`           ${fmtEth(eth)} ETH on the wallet isn't credit yet — \`arboard topup\` converts it.`);
    else if (mb < 1) info(`           To post videos, add funds: \`arboard topup\` (wallet ${wallet.address}).`);
  } catch { /* the post is done; the report is a nicety */ }
}

async function cmdFunds(o) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  const net = networkConfig(cfg.network);
  const wallet = loadWallet(dir, cfg);
  const eth = await walletEth(net, wallet.address);
  const credit = await withTimeout(creditBalance(client(cfg, wallet)), 20000).catch(() => null);
  if (o.json) {
    const turbo = client(cfg, wallet);
    const perMB = await uploadCost(turbo, [1048576]).catch(() => null);
    return info(JSON.stringify({ address: wallet.address, chain: net.chain, network: cfg.network, eth,
      credit_winc: credit === null ? null : String(credit), winc_per_mb: perMB === null ? null : String(perMB),
      gas_reserve: GAS_RESERVE, has_name: Boolean(cfg.arns), posts: cfg.posts.filter((p) => !p.removed).length }));
  }
  info(`Wallet:  ${wallet.address}`);
  info(`ETH:     ${eth === null ? "couldn't check" : `${eth} ${net.chain} ETH`}  (on the wallet, not yet credit)`);
  info(`Credit:  ${credit === null ? "couldn't check" : fmtWinc(credit)}`);
  if (eth !== null && Number(eth) > 0) info(`Turn ETH into credit with \`arboard topup <amount>\` (leave a little for gas).`);
}

async function cmdTopup(amount, o) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  const wallet = loadWallet(dir, cfg);
  if (!amount) {
    if (!canAsk()) die('give an amount in ETH, e.g. `arboard topup 0.01` (or run `arboard topup` in a terminal for a guided top-up)');
    const need = o.need ? winc(o.need) : 0n;
    const ok = await guidedTopup(cfg, wallet, client(cfg, wallet), need, o.for || '');
    if (!ok) process.exitCode = 2;
    return;
  }
  if (!(Number(amount) > 0)) die('give an amount in ETH, e.g. `arboard topup 0.01`');
  if (cfg.network === 'mainnet' && !o.yes) {
    die('this spends REAL ETH from the channel wallet. Re-run with --yes to confirm (or run `arboard topup` with no amount to be guided).');
  }
  try { await doTopup(cfg, wallet, amount); } catch (e) { die(e.message); }
  info('The credit can take a few minutes to show up (`arboard funds`).');
}

async function cmdRepublishPage(o) {
  const dir = findChannel(o.channel);
  const cfg = loadCfg(dir);
  const turbo = client(cfg, loadWallet(dir, cfg));
  cfg.fallbacks = await workingGateways(cfg, 'ar-io/healthcheck', 8);
  const r = await upload(turbo, buildPage(cfg), baseTags(cfg, 'page', 'text/html'), 'channel page');
  cfg.previous_pages = [...(cfg.previous_pages || []), cfg.page];
  cfg.page = r.id;
  saveCfg(dir, cfg);
  if (cfg.arns) await pointName(dir, cfg, turbo).catch((e) => info(`  ⚠ couldn't re-point the name: ${friendlyArnsError(e)} — run \`arboard name point\``));
  await refreshNostrProfile(dir, cfg);
  info(`New page: ${pageUrl(cfg)}`);
  info(cfg.arns ? `${shareUrl(cfg)} now shows the new page.` : 'The old link keeps working and shows the same posts; share the new one if you want the updated design.');
}

// ------------------------------------------------------------------ main

const HELP = `arboard — message channel on Arweave + Nostr

  arboard init <folder> [--title T] [--description D] [--network testnet|mainnet] [--wallet file] [--no-nostr]
  arboard post [text] [-i photo]... [-v video]... [-a audio]... [--no-nostr]
  arboard nostr                      npub, links and which relays have the channel
  arboard nostr resend               send all signed notes again (after an outage or new relays)
  arboard nostr publish <post-id>    publish a post that was made with --no-nostr
  arboard nostr relays [add|remove <wss://…>]
  arboard list
  arboard remove <post-id>          hide a post (the original stays on Arweave)
  arboard title [title] [--description D]
  arboard status [--check]           link, wallet, credit; --check opens it like a visitor
  arboard funds [--json]             ETH on the channel wallet and upload credit
  arboard topup                      guided: shows the wallet, waits for ETH, converts it to credit
  arboard topup <eth> [--yes]        convert that much ETH from the channel wallet into credit
  arboard links                      alternative links on other gateways (if one gets blocked)
  arboard name check <name>          price of a readable address (https://<name>.turbo-gateway.com)
  arboard name buy <name> --yes      buy it with upload credit [--years 1-5 | --permanent]
  arboard name extend --years N --yes renew a leased name
  arboard name [status|resume|point] show / finish an interrupted purchase / re-point to the page
  arboard republish-page             upload a fresh copy of the page (new link, refreshes fallbacks)

  --channel <folder>   act on that channel (default: current folder)
  testnet = Sepolia + temporary data (~3 days); mainnet = permanent.`;

async function main() {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      title: { type: 'string' }, description: { type: 'string' }, network: { type: 'string' },
      wallet: { type: 'string' }, channel: { type: 'string' },
      image: { type: 'string', short: 'i', multiple: true },
      video: { type: 'string', short: 'v', multiple: true },
      audio: { type: 'string', short: 'a', multiple: true },
      check: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' },
      'no-nostr': { type: 'boolean' }, 'no-balance': { type: 'boolean' }, need: { type: 'string' }, for: { type: 'string' }, years: { type: 'string' }, permanent: { type: 'boolean' }, json: { type: 'boolean' },
    },
  });
  const [cmd, arg, ...rest] = positionals;
  if (o.help || !cmd) return info(HELP);
  switch (cmd) {
    case 'init': if (!arg) die('give a folder: arboard init <folder>'); return cmdInit(arg, o);
    case 'post': return cmdPost(arg, o);
    case 'list': return cmdList(o);
    case 'remove': if (!arg) die('give the post id'); return cmdRemove(arg, o);
    case 'title': return cmdTitle(arg, o);
    case 'status': return cmdStatus(o);
    case 'topup': return cmdTopup(arg, o);
    case 'republish-page': return cmdRepublishPage(o);
    case 'links': return cmdLinks(o);
    case 'nostr': return cmdNostr(arg, o, rest);
    case 'name': return cmdName(arg, o, rest);
    case 'funds': return cmdFunds(o);
    default: die(`unknown command '${cmd}'\n\n${HELP}`);
  }
}

main().catch((e) => die(String(e?.stack || e))).finally(closePrompt);
