import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createPublishService } from '../src/main/publish-service.js';
import { createLocalSites } from '../src/main/local-site.js';
import { createOperatorStore } from '../src/main/operator-store.js';
import { precheck } from '../src/main/precheck.js';
import { BSC, NETWORKS, networkByKey } from '../src/main/config.js';
import * as E from '../src/main/publish-errors.js';
import { fakeChain, OWNER, CONTAINER, CIRCUITS, FEE, T0, encrypt, decrypt, lower, uploads } from './helpers/fake-chain.mjs';

const SITE = {
  'index.html': '<!doctype html><html><head><title>Demo</title></head><body><script src="app.js"></script></body></html>',
  'app.js': 'console.log(1)',
  'sub/index.html': '<!doctype html><html><head><title>Sub</title></head><body>sub</body></html>',
};
const code = (c) => (e) => e?.code === c;
const ADDR2 = '0x' + '4'.repeat(40);
const ADDR3 = '0x' + '5'.repeat(40);
const ADDR4 = '0x' + '6'.repeat(40);

/** 假的 secure / bridge / sites，真的 localSites（临时文件夹）和 precheck，每条发布链一个有状态假链 */
async function harness({ secureOk = true, backend = 'keychain', ready = true, account = OWNER, opened = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'publish-service-'));
  const site = join(base, 'site');
  for (const [p, body] of Object.entries(SITE)) {
    mkdirSync(dirname(join(site, p)), { recursive: true });
    writeFileSync(join(site, p), body);
  }
  const dir = join(base, 'operators');
  const clock = { t: T0 };
  const h = { on: null, cpusGate: null };
  const chains = {};
  const sleep = async (ms) => { clock.t += ms; for (const c of Object.values(chains)) c.hooks.onSleep?.(); };
  const now = () => clock.t;
  for (const key of ['bnb', 'xlayer']) {
    const net = networkByKey(key);
    // 假链只用 store 找临时钱包地址：和服务读同一个目录（每次读都直接读文件）
    const store = createOperatorStore({ dir: join(dir, key), encrypt, decrypt, now });
    chains[key] = fakeChain({ clock, store, opened, chainId: net.chainId });
  }
  const bridge = {
    state: { ready, accounts: account ? [account] : [], chainId: BSC.chainIdHex },
    requests: [],
    async request(method, params, origin) {
      bridge.requests.push({ method, origin });
      if (method === 'wallet_switchEthereumChain') { bridge.state.chainId = params[0].chainId; return null; }
      assert.equal(method, 'eth_sendTransaction');
      const p = params[0];
      const net = NETWORKS.find((n) => n.chainIdHex === p.chainId);
      return chains[net.key].ownerSend({ from: p.from, to: p.to, value: BigInt(p.value ?? 0), data: p.data ?? '0x' });
    },
  };
  const scans = [];
  const sites = {
    async cpus() {
      await h.cpusGate;
      return Array.from({ length: 8 }, (_, i) => (i === 7 ? CIRCUITS : null));
    },
    async circuitsOf(netKey, wallet, onProgress) {
      scans.push({ netKey, wallet });
      onProgress?.({ stage: 'circuits', total: 1n });
      return { circuits: [{ tokenId: 7, cpu: 7, label: '7.7.tape' }], skipped: [] };
    },
  };
  const localSites = createLocalSites();
  const { root } = await localSites.add(site);
  const secure = { available: () => secureOk, backend, encrypt, decrypt };
  const events = [];
  const onEvent = (name, data) => { events.push([name, data]); h.on?.(name, data); };
  const svc = createPublishService({ chains, sites, localSites, precheck, bridge, secure, dir, now, sleep, onEvent });
  return Object.assign(h, {
    svc, chains, bridge, root, site, dir, events, scans, localSites, clock, now, secure,
    /** 这条链的 operator-store（和服务读同一个目录、同一个时钟） */
    storeOf: (key, o = {}) => createOperatorStore({ dir: join(dir, key), encrypt, decrypt, now, ...o }),
    ins: (extra = {}) => svc.inspect({ root, netKey: 'bnb', tokenId: 7, cpu: 7, ...extra }),
    done: () => rmSync(base, { recursive: true, force: true }),
  });
}

/** 对象里任何一层有 bytes 键或 Uint8Array */
function hasBytes(v) {
  if (v instanceof Uint8Array) return true;
  if (Array.isArray(v)) return v.some(hasBytes);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => k === 'bytes' || hasBytes(x));
  return false;
}

test('available：secure 不可用 → no-encryption；basic_text → basic-text；正常 → ok', async () => {
  const a = await harness({ secureOk: false });
  const b = await harness({ backend: 'basic_text' });
  const c = await harness();
  try {
    assert.deepEqual(a.svc.available(), { ok: false, reason: 'no-encryption' });
    assert.deepEqual(b.svc.available(), { ok: false, reason: 'basic-text' });
    assert.deepEqual(c.svc.available(), { ok: true });
  } finally { a.done(); b.done(); c.done(); }
});

test('secure 不可用或是 basic_text：inspect / run / refund / targets 一律拒绝，leftovers 返回 unavailable', async () => {
  for (const opts of [{ secureOk: false }, { backend: 'basic_text' }]) {
    const h = await harness(opts);
    try {
      await assert.rejects(h.ins(), code(E.NO_ENCRYPTION));
      await assert.rejects(h.svc.run({ id: 'x' }), code(E.NO_ENCRYPTION));
      await assert.rejects(h.svc.refund({ netKey: 'bnb', container: CONTAINER }), code(E.NO_ENCRYPTION));
      await assert.rejects(h.svc.discardDust({ netKey: 'bnb', container: CONTAINER }), code(E.NO_ENCRYPTION));
      await assert.rejects(h.svc.targets({ netKey: 'bnb' }), code(E.NO_ENCRYPTION));
      assert.throws(() => h.svc.pause({ id: 'x' }), code(E.NO_ENCRYPTION));
      assert.deepEqual(await h.svc.leftovers(), { unavailable: true });
      // 什么都没写盘
      assert.throws(() => readdirSync(h.dir), /ENOENT/);
    } finally { h.done(); }
  }
});

test('inspect 只接受登记过的 root：没登记的、带 .. 的、登记过的子文件夹都拒绝', async () => {
  const h = await harness();
  try {
    for (const root of [h.root + '/..', h.root + '/sub/..', h.root + '/./', join(h.root, 'sub'), join(h.root, '..'), h.root + '/', '/etc', '', 42, null, [h.root]]) {
      await assert.rejects(h.svc.inspect({ root, netKey: 'bnb', tokenId: 7, cpu: 7 }), (e) => e.code === E.NOT_LOCAL && /文件夹/.test(e.message), String(root));
    }
    assert.equal(h.chains.bnb.calls.length, 0);
  } finally { h.done(); }
});

test('参数校验：netKey 不是发布链、tokenId / cpu 不是非负安全整数、container 格式不对都拒绝', async () => {
  const h = await harness();
  try {
    for (const netKey of ['base', 'BNB', '__proto__', undefined, 56]) await assert.rejects(h.ins({ netKey }), code(E.CHAIN_UNSUPPORTED));
    for (const tokenId of [-1, 1.5, '7', 2 ** 53, NaN, 7n]) await assert.rejects(h.ins({ tokenId }), /参数/);
    for (const cpu of [-1, '7', 0.5]) await assert.rejects(h.ins({ cpu }), (e) => e.code === E.BAD_ARGS && /参数/.test(e.message));
    // 处理器不存在
    await assert.rejects(h.ins({ cpu: 3 }), code(E.CIRCUIT_MISSING));
    await assert.rejects(h.ins({ cpu: 99 }), code(E.CIRCUIT_MISSING));
    for (const container of ['0x123', CONTAINER + '0', 'abc', null, { toString: () => CONTAINER }]) {
      await assert.rejects(h.svc.refund({ netKey: 'bnb', container }), /参数/);
      await assert.rejects(h.svc.discardDust({ netKey: 'bnb', container }), /参数/);
    }
    await assert.rejects(h.svc.refund({ netKey: 'base', container: CONTAINER }), code(E.CHAIN_UNSUPPORTED));
    await assert.rejects(h.svc.targets({ netKey: 'base' }), code(E.CHAIN_UNSUPPORTED));
    await assert.rejects(h.svc.run(), /参数/);
    assert.throws(() => h.svc.pause({ id: 5 }), /参数/);
  } finally { h.done(); }
});

test('inspect：摘要能 JSON 序列化，没有 bytes、bigint、store 里的东西；字段齐全', async () => {
  const h = await harness({ opened: false });
  try {
    const s = await h.ins();
    assert.equal(s.stage, 'ready');
    assert.equal(typeof s.id, 'string');
    assert.equal(s.label, '7.7.tape');
    assert.equal(s.url, 'tape://7-7/');
    assert.equal(s.netKey, 'bnb');
    assert.equal(s.container, CONTAINER);
    assert.equal(s.opened, false);
    assert.equal(s.openFee, FEE.toString());
    for (const k of ['gasPrice', 'uploadCost', 'totalCost']) assert.match(s[k], /^\d+$/, k);
    assert.equal(BigInt(s.totalCost), BigInt(s.uploadCost) + FEE);
    assert.deepEqual(s.counts, { create: 3, append: 0, replace: 0, reuse: 0 });
    assert.equal(s.transactions, 3);
    assert.equal(s.uploadBytes, Object.values(SITE).reduce((n, b) => n + Buffer.byteLength(b), 0));
    assert.deepEqual(s.files.map((f) => Object.keys(f).sort()), s.files.map(() => ['action', 'path', 'size']));
    assert.deepEqual(s.files.map((f) => f.path), ['app.js', 'sub/index.html', 'index.html']);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.conflicts, []);
    assert.equal(s.indexChunks, null);
    assert.equal(hasBytes(s), false);
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
    const text = JSON.stringify(s);
    assert.doesNotMatch(text, /sha256|steps|plan|owner|block/i);
    // 发布前不碰临时钱包存储
    assert.throws(() => readdirSync(h.dir), /ENOENT/);
  } finally { h.done(); }
});

test('inspect：预检查有错误 → blocked，带错误项，没有 id', async () => {
  const h = await harness();
  try {
    rmSync(join(h.site, 'index.html'));
    const s = await h.ins();
    assert.equal(s.stage, 'blocked');
    assert.equal(s.id, null);
    assert.ok(s.errors.length >= 1);
    assert.deepEqual(Object.keys(s.errors[0]).sort(), ['level', 'text']);
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  } finally { h.done(); }
});

test('inspect：链上文件和本地不同 → conflicts，只给 path 和 reason，没有 id', async () => {
  const h = await harness();
  try {
    h.chains.bnb.files.set('app.js', { contentType: 'text/javascript', sha256: '0x' + 'ab'.repeat(32), chunks: [new Uint8Array(5)] });
    const s = await h.ins();
    assert.equal(s.stage, 'conflicts');
    assert.equal(s.id, null);
    assert.deepEqual(s.conflicts, [{ path: 'app.js', reason: 'changed' }]);
    assert.equal(hasBytes(s), false);
  } finally { h.done(); }
});

test('inspect：首页要替换时给出 indexChunks', async () => {
  const h = await harness();
  try {
    h.chains.bnb.files.set('index.html', { contentType: 'text/html', sha256: '0x' + 'cd'.repeat(32), chunks: [new Uint8Array(5)] });
    const s = await h.ins();
    assert.equal(s.stage, 'ready');
    assert.equal(s.counts.replace, 1);
    assert.equal(s.indexChunks, 1);
  } finally { h.done(); }
});

test('sessions 只留最近 5 个：最早的 id 失效', async () => {
  const h = await harness();
  try {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await h.ins()).id);
    assert.equal(new Set(ids).size, 6);
    await assert.rejects(h.svc.run({ id: ids[0] }), code(E.NOT_READY));
  } finally { h.done(); }
});

const HOUR = 3600000;
const isJsonSafe = (v) => { try { JSON.stringify(v); return true; } catch { return false; } };

test('run 按 id 取主进程里的原件：传对象、伪造的 inspected、不认识的 id 都不认', async () => {
  const h = await harness();
  try {
    const s = await h.ins();
    await assert.rejects(h.svc.run({ id: 'nope' }), code(E.NOT_READY));
    await assert.rejects(h.svc.run({ id: { ...s } }), /参数/);
    await assert.rejects(h.svc.run({ ...s, id: undefined, stage: 'ready', files: [] }), /参数/);
    await assert.rejects(h.svc.run(s.id), /参数/);
    assert.equal(h.chains.bnb.ownerTxs.length, 0);
    const r = await h.svc.run({ id: s.id, files: [], target: { circuits: '0x' + '9'.repeat(40) } });
    assert.equal(r.stage, 'done');
    assert.equal(r.label, '7.7.tape');
    assert.equal(r.uploaded, 3);
    assert.match(r.spent, /^\d+$/);
    assert.match(r.refunded, /^\d+$/);
    assert.ok(isJsonSafe(r));
    // 传上去的是磁盘上的内容
    assert.equal(Buffer.concat(h.chains.bnb.files.get('index.html').chunks).toString(), SITE['index.html']);
    // 做完就作废这个 id
    await assert.rejects(h.svc.run({ id: s.id }), code(E.NOT_READY));
  } finally { h.done(); }
});

test('进度事件都带 id、能 JSON 序列化；钱包步骤以 stage wallet 推送', async () => {
  const h = await harness({ opened: false });
  try {
    const s = await h.ins();
    await h.svc.run({ id: s.id });
    const pub = h.events.filter(([n]) => n === 'publish').map(([, d]) => d);
    assert.ok(pub.length > 5);
    assert.ok(pub.every((d) => d.id === s.id));
    assert.ok(pub.every(isJsonSafe));
    assert.deepEqual(pub.filter((d) => d.stage === 'wallet').map((d) => d.kind), ['open', 'grant', 'fund']);
    assert.ok(pub.some((d) => d.stage === 'upload' && d.done === 3));
    assert.ok(h.bridge.requests.every((r) => r.origin === 'tape://publish'));
  } finally { h.done(); }
});

test('同一时间只能有一个 run（服务级别，换条链也不行）：第二个 BUSY，第一个结束后可以再 run', async () => {
  const h = await harness();
  try {
    const a = await h.ins();
    const b = await h.ins({ netKey: 'xlayer' });
    let release;
    const gate = new Promise((r) => { release = r; });
    h.chains.bnb.hooks.ownerSend = async (tx) => { await gate; delete h.chains.bnb.hooks.ownerSend; return h.chains.bnb.walletSend(tx); };
    const first = h.svc.run({ id: a.id });
    await assert.rejects(h.svc.run({ id: b.id }), code(E.BUSY));
    await assert.rejects(h.svc.run({ id: a.id }), code(E.BUSY));
    release();
    assert.equal((await first).stage, 'done');
    // 第一个结束后锁放开（xlayer 上钱包要先切链，假桥接照做）
    assert.equal((await h.svc.run({ id: b.id })).stage, 'done');
  } finally { h.done(); }
});

test('出错之后服务锁也会释放', async () => {
  const h = await harness();
  try {
    const s = await h.ins();
    h.bridge.state.accounts = [ADDR2];
    await assert.rejects(h.svc.run({ id: s.id }), code(E.WALLET_ACCOUNT));
    h.bridge.state.accounts = [OWNER];
    assert.equal((await h.svc.run({ id: s.id })).stage, 'done');
  } finally { h.done(); }
});

test('pause：在两笔交易之间停下，返回 paused；同一个 id 再 run 接着传完', async () => {
  const h = await harness();
  try {
    const s = await h.ins();
    h.on = (name, d) => { if (d.stage === 'upload' && d.done === 1) h.svc.pause({ id: s.id }); };
    const r = await h.svc.run({ id: s.id });
    assert.deepEqual(r, { stage: 'paused' });
    assert.equal(uploads(h.chains.bnb).length, 1);
    h.on = null;
    // 不在跑的 id、不认识的 id：pause 什么都不做
    assert.equal(h.svc.pause({ id: s.id }), false);
    assert.equal(h.svc.pause({ id: 'nope' }), false);
    const again = await h.svc.run({ id: s.id });
    assert.equal(again.stage, 'done');
    assert.equal(uploads(h.chains.bnb).length, 3);
  } finally { h.done(); }
});

test('refund：暂停后把临时钱包的钱退回持有人，金额是字符串', async () => {
  const h = await harness();
  try {
    const s = await h.ins();
    h.on = (name, d) => { if (d.stage === 'upload' && d.done === 1) h.svc.pause({ id: s.id }); };
    assert.equal((await h.svc.run({ id: s.id })).stage, 'paused');
    const r = await h.svc.refund({ netKey: 'bnb', container: CONTAINER.toUpperCase().replace('0X', '0x') });
    assert.match(r.refunded, /^\d+$/);
    assert.ok(BigInt(r.refunded) > 0n);
    assert.equal(r.dust, false);
    assert.ok(isJsonSafe(r));
    await assert.rejects(h.svc.refund({ netKey: 'bnb', container: CONTAINER }), code(E.NO_OPERATOR));
  } finally { h.done(); }
});

test('leftovers：删掉余额为 0 且没有在途交易的空记录，列出有余额 / pending / ownerPending 的，坏文件单列', async () => {
  const h = await harness();
  try {
    const bnb = h.storeOf('bnb');
    const xl = h.storeOf('xlayer');
    const empty = bnb.create({ chainId: BSC.chainId, container: ADDR2, owner: OWNER });
    const rich = bnb.create({ chainId: BSC.chainId, container: ADDR3, owner: OWNER });
    h.chains.bnb.balances.set(lower(rich.address), 123n);
    xl.create({ chainId: 196, container: ADDR4, owner: OWNER });
    xl.setOwnerPending(196, ADDR4, { kind: 'fund', hash: '0x' + 'e'.repeat(64), at: 1, nonce: 0n });
    writeFileSync(join(h.dir, 'xlayer', `196-${ADDR2}.json`), '{ broken');
    h.clock.t += HOUR;
    const r = await h.svc.leftovers();
    assert.ok(isJsonSafe(r));
    assert.deepEqual(r.records.map((x) => [x.netKey, x.container, x.balance, x.pending, x.ownerPending]), [
      ['bnb', ADDR3, '123', false, false],
      ['xlayer', ADDR4, '0', false, true],
    ]);
    assert.deepEqual(Object.keys(r.records[0]).sort(), ['address', 'balance', 'cleanup', 'container', 'decryptable', 'netKey', 'owner', 'ownerPending', 'pending']);
    assert.deepEqual(r.records.map((x) => [x.decryptable, x.cleanup]), [[true, null], [true, null]]);
    assert.deepEqual(r.errors, []);
    assert.equal(r.records[0].owner, lower(OWNER));
    assert.deepEqual(r.broken, [{ netKey: 'xlayer', file: `196-${ADDR2}.json` }]);
    assert.equal(bnb.get(BSC.chainId, empty.container), null);
    assert.ok(bnb.get(BSC.chainId, ADDR3));
    assert.doesNotMatch(JSON.stringify(r), /"key"|enc:/);
  } finally { h.done(); }
});

test('targets：要求钱包已连接，按当前账户扫，进度以 publishScan 推送', async () => {
  const off = await harness({ ready: false });
  const none = await harness({ account: null });
  const h = await harness();
  try {
    await assert.rejects(off.svc.targets({ netKey: 'bnb' }), code(E.WALLET_NOT_CONNECTED));
    await assert.rejects(none.svc.targets({ netKey: 'bnb' }), code(E.WALLET_NOT_CONNECTED));
    const r = await h.svc.targets({ netKey: 'xlayer' });
    assert.deepEqual(r.circuits.map((c) => c.label), ['7.7.tape']);
    assert.deepEqual(h.scans, [{ netKey: 'xlayer', wallet: OWNER }]);
    assert.deepEqual(h.events, [['publishScan', { netKey: 'xlayer', stage: 'circuits', total: '1' }]]);
  } finally { off.done(); none.done(); h.done(); }
});

test('leftovers 不删正在发布的容器的记录：临时钱包刚建好、还没充值时也不会被当成空记录', async () => {
  const h = await harness();
  try {
    const s = await h.ins();
    let seen;
    // 授权交易发出前（记录已建好、余额 0、还没有 ownerPending）跑一次 leftovers
    h.chains.bnb.hooks.ownerSend = async (tx) => {
      delete h.chains.bnb.hooks.ownerSend;
      seen = await h.svc.leftovers();
      return h.chains.bnb.walletSend(tx);
    };
    assert.equal((await h.svc.run({ id: s.id })).stage, 'done');
    assert.deepEqual(seen.records.map((r) => [r.container, r.balance]), [[CONTAINER, '0']]);
  } finally { h.done(); }
});

test('leftovers：latest 落后时余额不早于记录里最近确认的区块读，刚充过值的临时钱包不会被删', async () => {
  const h = await harness();
  try {
    const s = await h.ins();
    h.on = (name, d) => { if (d.stage === 'upload' && d.done === 1) h.svc.pause({ id: s.id }); };
    assert.equal((await h.svc.run({ id: s.id })).stage, 'paused');
    // 节点落后很多块：latest 上临时钱包还没收到充值
    h.chains.bnb.lag = 10n;
    const r = await h.svc.leftovers();
    assert.equal(r.records.length, 1);
    assert.ok(BigInt(r.records[0].balance) > 0n);
  } finally { h.done(); }
});

/** run 到充值那一步时钱包广播了交易却断开（WALLET_LOST）：没有 ownerPending。visible 为 false 时节点也看不到这笔交易 */
async function lostFund(h, { visible = true } = {}) {
  const s = await h.ins();
  const c = h.chains.bnb;
  c.hooks.ownerSend = async (tx) => {
    if (tx.data !== '0x') return c.walletSend(tx);
    c.holdOwner = true;
    await c.walletSend(tx);
    if (!visible) c.owner.pending = c.owner.latest;
    throw { code: 4900, message: 'disconnected' };
  };
  await assert.rejects(h.svc.run({ id: s.id }), code(E.WALLET_LOST));
  assert.equal(h.storeOf('bnb').get(BSC.chainId, CONTAINER).ownerPending, null);
  return s;
}

test('充值时 WALLET_LOST、过了宽限期：持有人钱包还有未确认的交易，记录保留；到账后列出余额', async () => {
  const h = await harness();
  try {
    await lostFund(h);
    h.clock.t += HOUR;
    const r = await h.svc.leftovers();
    assert.deepEqual(r.records.map((x) => [x.container, x.balance, x.cleanup]), [[CONTAINER, '0', 'pending']]);
    assert.ok(h.storeOf('bnb').get(BSC.chainId, CONTAINER));
    h.chains.bnb.mineQueued();
    const after = await h.svc.leftovers();
    assert.ok(BigInt(after.records[0].balance) > 0n);
  } finally { h.done(); }
});

test('充值时 WALLET_LOST、节点还看不到这笔交易（nonce 已经对上）：宽限期内照样保留', async () => {
  const h = await harness();
  try {
    await lostFund(h, { visible: false });
    // 宽限期从发充值之前记下的 ownerTouchedAt 算（WALLET_LOST 后等交易池还会拨时钟）
    h.clock.t = h.storeOf('bnb').get(BSC.chainId, CONTAINER).ownerTouchedAt + HOUR - 1;
    const r = await h.svc.leftovers();
    assert.deepEqual(r.records.map((x) => [x.container, x.balance, x.cleanup]), [[CONTAINER, '0', 'recent']]);
    assert.ok(h.storeOf('bnb').get(BSC.chainId, CONTAINER));
  } finally { h.done(); }
});

test('leftovers：建了超过 1 小时的空记录通过 publisher 删掉，不列出', async () => {
  const h = await harness();
  try {
    const store = h.storeOf('bnb');
    store.create({ chainId: BSC.chainId, container: ADDR2, owner: OWNER });
    h.clock.t += HOUR;
    assert.deepEqual(await h.svc.leftovers(), { records: [], broken: [], errors: [] });
    assert.equal(store.get(BSC.chainId, ADDR2), null);
  } finally { h.done(); }
});

test('leftovers：一条链的节点出错，另一条链照样列出，错误单列', async () => {
  const h = await harness();
  try {
    const rich = h.storeOf('bnb').create({ chainId: BSC.chainId, container: ADDR3, owner: OWNER });
    h.chains.bnb.balances.set(lower(rich.address), 9n);
    h.storeOf('xlayer').create({ chainId: 196, container: ADDR4, owner: OWNER });
    h.chains.xlayer.hooks.pinBlock = () => { throw Object.assign(new Error('rpc down'), { code: 'X_RPC' }); };
    let pins = 0;
    const pin = h.chains.bnb.pinBlock;
    h.chains.bnb.pinBlock = async () => { pins++; return pin(); };
    h.storeOf('bnb').create({ chainId: BSC.chainId, container: ADDR4, owner: OWNER });
    h.chains.bnb.balances.set(lower(h.storeOf('bnb').get(BSC.chainId, ADDR4).address), 1n);
    const r = await h.svc.leftovers();
    assert.deepEqual(r.records.map((x) => [x.netKey, x.container, x.balance]), [['bnb', ADDR3, '9'], ['bnb', ADDR4, '1']]);
    assert.deepEqual(r.errors, [{ netKey: 'xlayer', code: 'X_RPC', message: 'rpc down' }]);
    // 每条链只钉一次区块
    assert.equal(pins, 1);
    assert.ok(isJsonSafe(r));
  } finally { h.done(); }
});

test('leftovers：私钥解不开的记录标出 decryptable: false', async () => {
  const h = await harness();
  try {
    const bad = h.storeOf('bnb', { encrypt: () => Buffer.from('enc:not-a-key') }).create({ chainId: BSC.chainId, container: ADDR2, owner: OWNER });
    h.chains.bnb.balances.set(lower(bad.address), 4n);
    const good = h.storeOf('bnb').create({ chainId: BSC.chainId, container: ADDR3, owner: OWNER });
    h.chains.bnb.balances.set(lower(good.address), 4n);
    const r = await h.svc.leftovers();
    assert.deepEqual(r.records.map((x) => [x.container, x.decryptable]), [[ADDR2, false], [ADDR3, true]]);
  } finally { h.done(); }
});

test('refund 和 leftovers 同时处理同一个容器：leftovers 报 busy，不删记录', async () => {
  const h = await harness();
  try {
    const store = h.storeOf('bnb');
    store.create({ chainId: BSC.chainId, container: CONTAINER, owner: OWNER });
    h.clock.t += HOUR;
    let release;
    const gate = new Promise((r) => { release = r; });
    const nonceOf = h.chains.bnb.nonceOf;
    h.chains.bnb.nonceOf = async (a) => { await gate; return nonceOf(a); };
    const refunding = h.svc.refund({ netKey: 'bnb', container: CONTAINER });
    const r = await h.svc.leftovers();
    assert.deepEqual(r.records.map((x) => [x.container, x.cleanup]), [[CONTAINER, 'busy']]);
    assert.ok(store.get(BSC.chainId, CONTAINER));
    release();
    await refunding;
  } finally { h.done(); }
});

test('discardDust 经过服务：余额不够付退款手续费时删掉记录，金额是字符串', async () => {
  const h = await harness();
  try {
    const rec = h.storeOf('bnb').create({ chainId: BSC.chainId, container: CONTAINER, owner: OWNER });
    h.chains.bnb.balances.set(lower(rec.address), 21000n * 50000000n);
    assert.deepEqual(await h.svc.discardDust({ netKey: 'bnb', container: CONTAINER }), { discarded: (21000n * 50000000n).toString() });
    assert.equal(h.storeOf('bnb').get(BSC.chainId, CONTAINER), null);
  } finally { h.done(); }
});

test('同一时间只能有一个 inspect：第二个 BUSY，第一个结束后可以再 inspect', async () => {
  const h = await harness();
  try {
    let release;
    h.cpusGate = new Promise((r) => { release = r; });
    const first = h.ins();
    await assert.rejects(h.ins({ netKey: 'xlayer' }), code(E.BUSY));
    release();
    assert.equal((await first).stage, 'ready');
    h.cpusGate = null;
    assert.equal((await h.ins()).stage, 'ready');
  } finally { h.done(); }
});

test('暂停很久以后接着发布、充值时 WALLET_LOST：宽限期从这次持有人交易算，记录保留；再过 1 小时、nonce 对上、余额 0 才删', async () => {
  const h = await harness();
  try {
    // 很早以前建好的记录（授权已经做过一次也没关系，这里只看充值）
    h.storeOf('bnb').create({ chainId: BSC.chainId, container: CONTAINER, owner: OWNER });
    h.clock.t += 3 * 24 * HOUR;
    await lostFund(h, { visible: false });
    const touched = h.storeOf('bnb').get(BSC.chainId, CONTAINER).ownerTouchedAt;
    assert.ok(touched >= h.clock.t - HOUR);
    const r = await h.svc.leftovers();
    assert.deepEqual(r.records.map((x) => [x.container, x.cleanup]), [[CONTAINER, 'recent']]);
    h.clock.t = touched + HOUR;
    assert.deepEqual((await h.svc.leftovers()).records, []);
    assert.equal(h.storeOf('bnb').get(BSC.chainId, CONTAINER), null);
  } finally { h.done(); }
});

test('leftovers：只对列出来的记录调 canDecrypt，每条一次', async () => {
  const h = await harness();
  try {
    const store = h.storeOf('bnb');
    store.create({ chainId: BSC.chainId, container: ADDR2, owner: OWNER });
    const rich = store.create({ chainId: BSC.chainId, container: ADDR3, owner: OWNER });
    h.chains.bnb.balances.set(lower(rich.address), 3n);
    h.clock.t += HOUR;
    let decrypts = 0;
    h.secure.decrypt = (buf) => { decrypts++; return decrypt(buf); };
    const r = await h.svc.leftovers();
    assert.deepEqual(r.records.map((x) => x.container), [ADDR3]);
    assert.equal(decrypts, 1);
  } finally { h.done(); }
});
