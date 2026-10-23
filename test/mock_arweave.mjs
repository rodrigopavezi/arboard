// Mock of Turbo (upload + payment) and an AR.IO gateway (GraphQL + data), for testing arboard.
// Every upload is parsed as ANS-104 and its signature verified, like the real service.
import http from 'node:http';
import crypto from 'node:crypto';
import { DataItem } from '@dha-team/arbundles';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { computeAddress, hexlify, Transaction } from 'ethers';

const PORTS = String(process.argv[2] || '9400').split(',').map(Number);
const BROKEN = new Set(String(process.env.MOCK_BROKEN || '').split(',').filter(Boolean).map(Number));   // serves pages, fails search/data
const UNINDEXED = new Set(String(process.env.MOCK_UNINDEXED || '').split(',').filter(Boolean).map(Number)); // search answers, but empty (like turbo-gateway.com)
const NONAME = new Set(String(process.env.MOCK_NONAME || '').split(',').filter(Boolean).map(Number)); // serves data, 404 for names (like arweave.net)
const BLOCKED = new Set(String(process.env.MOCK_BLOCKED || '').split(',').filter(Boolean).map(Number)); // refuses everything
const FREE = Number(process.env.MOCK_FREE || 107520);
const items = new Map();     // id -> {owner, tags, data, time}
let credit = 0;              // winc
// Ethereum side: wallet balances (wei) and sent transactions, for top-ups.
const ethBalances = new Map();   // lowercase address -> BigInt wei
const DEFAULT_WEI = BigInt(process.env.MOCK_ETH_WEI || '0');
const balanceOf = (a) => (ethBalances.has(a.toLowerCase()) ? ethBalances.get(a.toLowerCase()) : DEFAULT_WEI);
const ethTxs = new Map();        // hash -> { from, to, value, nonce, raw }
const nonces = new Map();
const WINC_PER_ETH = () => Number(process.env.MOCK_WINC_PER_ETH || 300e12);   // 300 AR per ETH
// ArNS: names -> { antId, owner, target }; actions by nonce
const names = new Map();
const actions = new Map();
const FEE_PAYER = Keypair.generate();
const NAME_PRICE = Number(process.env.MOCK_NAME_PRICE || 2_000_000_000);  // winc
const priceFor = (type, years = 1) => (type === 'permabuy' ? NAME_PRICE * 5 : NAME_PRICE * years);
const b64u = (b) => Buffer.from(b).toString('base64url');

function gql(query, variables) {
  const owners = Array.isArray(variables.owners) ? variables.owners : variables.owner ? [variables.owner] : [];
  const channel = variables.channel;
  const typeOnly = /name:"Type",values:\["post"\]/.test(query.replace(/\s/g, '')) ? 'post' : null;
  let list = [...items.entries()].filter(([, it]) => {
    const t = Object.fromEntries(it.tags.map((x) => [x.name, x.value]));
    return (!owners.length || owners.includes(it.owner)) && t['App-Name'] === 'arboard' &&
      (!channel || t.Channel === channel) && (!typeOnly || t.Type === typeOnly);
  });
  list.sort((a, b) => b[1].time - a[1].time);
  const start = variables.after ? Number(variables.after) : 0;
  const pageSize = 3; // small pages to exercise pagination
  const pageItems = list.slice(start, start + pageSize);
  return { data: { transactions: {
    pageInfo: { hasNextPage: start + pageSize < list.length },
    edges: pageItems.map(([id, it], i) => ({ cursor: String(start + i + 1),
      node: { id, owner: { address: it.owner }, tags: it.tags } })),
  } } };
}

const handler = (port) => (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.end();
    let am;
    if (BLOCKED.has(port)) { res.writeHead(451); return res.end('blocked'); }
    if (url.pathname === '/ar-io/healthcheck') return res.end('{"status":"ok"}');
    if (url.pathname === '/ar-io/peers') {
      if (BROKEN.has(port)) { res.writeHead(500); return res.end(); }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ gateways: Object.fromEntries(PORTS.map((p) => [`127.0.0.1:${p}`, { url: `http://127.0.0.1:${p}`, dataWeight: p }])) }));
    }
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (req.method === 'GET' && url.pathname === '/v1/info') return json({ freeUploadLimitBytes: FREE,
      addresses: { ethereum: '0x9B13eb5096264B12532b8C648Eba4A662b4078ce' }, gateway: 'http://localhost' });
    if (req.method === 'POST' && url.pathname.startsWith('/v1/tx')) {
      const di = new DataItem(body);
      if (!(await di.isValid())) { console.log('REJECT invalid signature'); return json({ error: 'invalid data item' }, 400); }
      const owner = b64u(crypto.createHash('sha256').update(di.rawOwner).digest());   // what the upload service reports
      // what the gateway indexes: Ethereum-signed items (signature type 3) under the 0x address
      const indexedOwner = di.signatureType === 3 ? computeAddress(hexlify(di.rawOwner)) : owner;
      const size = di.rawData.length;
      let winc = '0';
      if (size > FREE) {
        const cost = size * 10;
        if (credit < cost) { console.log('402 for', size); return json({ error: 'Insufficient balance' }, 402); }
        credit -= cost; winc = String(cost);
      }
      items.set(di.id, { owner: indexedOwner, tags: di.tags, data: Buffer.from(di.rawData), time: Date.now() + items.size });
      const t = Object.fromEntries(di.tags.map((x) => [x.name, x.value]));
      console.log(`UPLOAD ok ${t.Type} ${t['Content-Type']} ${size}B owner=${owner.slice(0, 8)}… winc=${winc}`);
      return json({ id: di.id, owner, dataCaches: ['mock'], fastFinalityIndexes: [], winc });
    }
    // ---------------- price of credit in ETH, and a tiny Ethereum JSON-RPC for balances ----------------
    if (req.method === 'GET' && (am = url.pathname.match(/^\/v1\/price\/ethereum\/(\d+)$/))) {
      const wincPerEth = WINC_PER_ETH();
      const w = Math.floor(Number(am[1]) / 1e18 * wincPerEth);
      return json({ winc: String(w), fees: [], actualPaymentAmount: Number(am[1]) });
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const call = JSON.parse(body.toString());
      const hex = (n) => '0x' + BigInt(n).toString(16);
      const one = (c) => {
        const p = c.params || [];
        let result = null, error;
        switch (c.method) {
          case 'eth_chainId': result = '0xaa36a7'; break;
          case 'net_version': result = '11155111'; break;
          case 'eth_blockNumber': result = '0x10'; break;
          case 'eth_getBalance': result = hex(balanceOf(p[0])); break;
          case 'eth_getTransactionCount': result = hex(nonces.get(p[0].toLowerCase()) || 0); break;
          case 'eth_estimateGas': result = '0x5208'; break;
          case 'eth_gasPrice': result = hex(1e9); break;
          case 'eth_maxPriorityFeePerGas': result = hex(1e9); break;
          case 'eth_getBlockByNumber': result = { number: '0x10', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '00'.repeat(32),
            timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: hex(1e9), gasLimit: hex(30e6), gasUsed: '0x0',
            miner: '0x' + '00'.repeat(20), extraData: '0x', nonce: '0x0000000000000000', difficulty: '0x0', transactions: [] }; break;
          case 'eth_sendRawTransaction': {
            const tx = Transaction.from(p[0]);
            const cost = tx.value + 21000n * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n);
            if (balanceOf(tx.from) < cost) { error = { code: -32000, message: 'insufficient funds for gas * price + value' }; break; }
            ethBalances.set(tx.from.toLowerCase(), balanceOf(tx.from) - tx.value - 21000n * 1000000000n);
            nonces.set(tx.from.toLowerCase(), tx.nonce + 1);
            ethTxs.set(tx.hash, { tx, raw: p[0] });
            console.log(`ETH tx ${tx.hash.slice(0, 10)}… ${tx.value} wei from ${tx.from}`);
            result = tx.hash; break;
          }
          case 'eth_getTransactionByHash': {
            const t = ethTxs.get(p[0]);
            if (t) { const j = t.tx.toJSON(); result = { hash: t.tx.hash, from: t.tx.from, to: t.tx.to, nonce: hex(t.tx.nonce),
              value: hex(t.tx.value), gas: hex(t.tx.gasLimit), input: t.tx.data, type: hex(t.tx.type), chainId: hex(t.tx.chainId),
              maxFeePerGas: hex(t.tx.maxFeePerGas || 0), maxPriorityFeePerGas: hex(t.tx.maxPriorityFeePerGas || 0), gasPrice: hex(1e9),
              blockNumber: '0x10', blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0',
              r: t.tx.signature.r, s: t.tx.signature.s, v: hex(t.tx.signature.v), yParity: hex(t.tx.signature.yParity), accessList: [] }; void j; }
            break;
          }
          case 'eth_getTransactionReceipt': {
            const t = ethTxs.get(p[0]);
            if (t) result = { transactionHash: t.tx.hash, blockNumber: '0x10', blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0',
              from: t.tx.from, to: t.tx.to, status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: hex(1e9),
              logs: [], logsBloom: '0x' + '00'.repeat(256), type: hex(t.tx.type), contractAddress: null };
            break;
          }
        }
        return error ? { jsonrpc: '2.0', id: c.id, error } : { jsonrpc: '2.0', id: c.id, result };
      };
      return json(Array.isArray(call) ? call.map(one) : one(call));
    }
    // Test hook: ETH "arrives" on a wallet (like someone sending it).
    if (req.method === 'POST' && url.pathname === '/__eth') {
      const a = url.searchParams.get('address');
      ethBalances.set(a.toLowerCase(), balanceOf(a) + BigInt(url.searchParams.get('wei')));
      return json({ wei: String(balanceOf(a)) });
    }
    // Turbo payment: credit a confirmed ETH transfer.
    if (req.method === 'POST' && /\/account\/balance\/ethereum$/.test(url.pathname)) {
      const { tx_id } = JSON.parse(body.toString());
      const t = ethTxs.get(tx_id);
      if (!t) return json({ error: 'tx not found' }, 404);
      if (t.credited) return json({ error: 'already credited' }, 400);
      t.credited = true;
      const w = Math.floor(Number(t.tx.value) / 1e18 * WINC_PER_ETH());
      credit += w;
      console.log(`TOPUP +${w} winc`);
      return json({ creditedTransaction: { transactionId: tx_id, transactionQuantity: String(t.tx.value),
        transactionSenderAddress: t.tx.from, destinationAddress: t.tx.from, winstonCreditAmount: String(w), tokenType: 'ethereum', blockHeight: 16 } });
    }
    if (req.method === 'GET' && (am = url.pathname.match(/^\/v1\/price\/bytes\/(\d+)$/))) {
      return json({ winc: String(Number(am[1]) * 10), adjustments: [] });
    }
    // ---------------- ArNS (Turbo payment service) ----------------
    if (req.method === 'GET' && (am = url.pathname.match(/^\/v1\/arns\/price\/(buy-name|extend-lease)\/([^/]+)$/))) {
      const type = url.searchParams.get('type') || 'lease', years = Number(url.searchParams.get('years') || 1);
      const name = decodeURIComponent(am[2]);
      if (am[1] === 'buy-name' && names.has(name)) return json({ error: 'name is already taken' }, 409);
      const w = priceFor(type, years);
      return json({ winc: String(w), mARIO: String(w / 1e6), wincTotalWithAntSpawn: String(w + 500_000_000) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/arns/actions/buy-name') {
      const b = JSON.parse(body.toString());
      if (names.has(b.name)) return json({ error: 'name is already taken' }, 409);
      const cost = priceFor(b.type, b.years) + 500_000_000;
      if (credit < cost) return json({ error: 'Insufficient balance' }, 402);
      credit -= cost;
      // A real Solana v0 transaction: fee payer (Turbo) signs now, the owner signs later.
      const owner = new PublicKey(b.ownerAddress);
      const ix = new TransactionInstruction({ keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
        programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: Buffer.from(`arns:${b.name}`) });
      const msg = new TransactionMessage({ payerKey: FEE_PAYER.publicKey, recentBlockhash: bs58.encode(crypto.randomBytes(32)), instructions: [ix] }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([FEE_PAYER]);
      const nonce = crypto.randomUUID();
      actions.set(nonce, { action: 'buy-name', params: b, status: 'awaiting-signature', transaction: Buffer.from(tx.serialize()).toString('base64') });
      console.log(`ARNS buy-name ${b.name} owner=${b.ownerAddress.slice(0, 6)}… debited ${cost} -> awaiting owner signature`);
      return json({ nonce, action: 'buy-name', ...actions.get(nonce) });
    }
    if (req.method === 'POST' && (am = url.pathname.match(/^\/v1\/arns\/actions\/([0-9a-f-]{36})\/sign$/))) {
      const a = actions.get(am[1]);
      if (!a) return json({ error: 'unknown nonce' }, 404);
      if (a.status === 'completed') return json({ ...a.result, alreadyCompleted: true });
      const tx = VersionedTransaction.deserialize(Buffer.from(JSON.parse(body.toString()).transaction, 'base64'));
      const keys = tx.message.staticAccountKeys;
      const ok = tx.signatures.every((sig, i) => nacl.sign.detached.verify(tx.message.serialize(), sig, keys[i].toBytes()));
      const ownerSigned = keys.some((k, i) => k.toBase58() === a.params.ownerAddress && tx.message.isAccountSigner(i));
      if (!ok || !ownerSigned) { console.log('ARNS REJECT bad owner signature'); return json({ error: 'invalid signature' }, 400); }
      const antId = bs58.encode(crypto.randomBytes(32));
      names.set(a.params.name, { antId, owner: a.params.ownerAddress, target: a.params.antState?.transactionId });
      a.status = 'completed';
      a.result = { nonce: am[1], action: 'buy-name', status: 'completed', messageId: bs58.encode(crypto.randomBytes(64)), antId };
      console.log(`ARNS bought ${a.params.name} -> ${a.params.antState?.transactionId} (owner signature verified)`);
      return json(a.result);
    }
    if (req.method === 'GET' && (am = url.pathname.match(/^\/v1\/arns\/actions\/([0-9a-f-]{36})$/))) {
      const a = actions.get(am[1]);
      return a ? json(a.result || { nonce: am[1], status: a.status, transaction: a.transaction }) : json({ error: 'unknown nonce' }, 404);
    }
    if (req.method === 'POST' && url.pathname === '/v1/arns/actions/set-record') {
      const b = JSON.parse(body.toString());
      const entry = [...names.entries()].find(([, v]) => v.antId === b.antId);
      // Owner proof: an ed25519 signature by the ANT owner over the custody message + nonce.
      const pub = Buffer.from(req.headers['x-owner-public-key'] || '', 'base64url');
      const sig = Buffer.from(req.headers['x-owner-signature'] || '', 'base64url');
      if (!entry || bs58.encode(pub) !== entry[1].owner || sig.length !== 64) { console.log('ARNS REJECT set-record: not the owner'); return json({ error: 'not the owner' }, 403); }
      entry[1].target = b.transactionId;
      console.log(`ARNS set-record ${entry[0]} -> ${b.transactionId}`);
      return json({ nonce: crypto.randomUUID(), action: 'set-record', status: 'completed', messageId: 'x' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/arns/actions/extend-lease') {
      const b = JSON.parse(body.toString());
      const cost = priceFor('lease', b.years);
      if (credit < cost) return json({ error: 'Insufficient balance' }, 402);
      credit -= cost;
      console.log(`ARNS extend ${b.name} +${b.years}y`);
      return json({ nonce: crypto.randomUUID(), action: 'extend-lease', status: 'completed', messageId: 'x' });
    }
    // Gateway side: <name>.localhost:<port>/ serves the item the name points to.
    const hostName = (req.headers.host || '').split(':')[0].match(/^([a-z0-9-]{1,51})\.localhost$/);
    if (hostName && NONAME.has(port)) { res.writeHead(404); return res.end('This hashpath cannot be resolved on this node, yet'); }
    if (req.method === 'GET' && hostName && names.has(hostName[1]) && (url.pathname === '/' || url.pathname === '/index.html')) {
      const n = names.get(hostName[1]);
      const it = items.get(n.target);
      if (!it) { res.writeHead(404); return res.end('name target not found'); }
      res.writeHead(200, { 'content-type': 'text/html', 'x-arns-name': hostName[1], 'x-arns-resolved-id': n.target });
      return res.end(it.data);
    }

    if (url.pathname.includes('/account/balance')) return json({ winc: String(credit), controlledWinc: String(credit), effectiveBalance: String(credit) });
    if (url.pathname.includes('/account/free')) return json({ remainingFreeBytes: 104857600 });
    if (req.method === 'POST' && url.pathname === '/__credit') { credit += Number(url.searchParams.get('winc')); return json({ credit }); }

    if (req.method === 'POST' && url.pathname === '/graphql') {
      if (BROKEN.has(port)) { res.writeHead(502); return res.end(); }
      if (UNINDEXED.has(port)) return json({ data: { transactions: { pageInfo: { hasNextPage: false }, edges: [] } } });
      const { query, variables } = JSON.parse(body.toString());
      return json(gql(query, variables || {}));
    }
    const m = url.pathname.match(/^\/(?:raw\/)?([A-Za-z0-9_-]{43})$/);
    if (req.method === 'GET' && m && items.has(m[1])) {
      const it = items.get(m[1]);
      const isPage = it.tags.some((x) => x.name === 'Type' && x.value === 'page');
      if (BROKEN.has(port) && !isPage) { res.writeHead(502); return res.end(); }
      const ct = it.tags.find((x) => x.name === 'Content-Type')?.value || 'application/octet-stream';
      res.writeHead(200, { 'content-type': ct, 'content-length': it.data.length });
      return res.end(it.data);
    }
    res.writeHead(404); res.end('not found');
  });
};
for (const p of PORTS) http.createServer(handler(p)).listen(p, () => console.log('mock gateway on', p));
