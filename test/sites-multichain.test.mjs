import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSites } from '../src/main/sites.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const enc = (s) => new TextEncoder().encode(s);

// 每条链：处理器列表 + 有首页的电路（"tokenId-cpu"）+ 首页内容
// 钱包扫描用（可选）：holds = [{cpu, ids, maxId?}] 钱包持有的电路；containers = {"tokenId-cpu": 容器} 已开通的电路；
// indexed = [容器] 有首页的容器。给了 containers 时 sites 不再决定开通状态
function fakeChain({ cpus, sites = [], body = 'x', down = false, holds = [], containers = null, indexed = null }) {
  const calls = [];
  const up = () => { if (down) throw new Error('rpc down'); };
  return {
    calls,
    async pinBlock() { up(); return 'latest'; },
    async cpuList() { up(); return cpus; },
    async circuitInfos(items) {
      up();
      calls.push(['circuitInfos', items.map((s) => `${s.tokenId}-${s.cpu}`)]);
      if (containers) {
        return items.map((s) => {
          const c = containers[`${s.tokenId}-${s.cpu}`];
          return { exists: true, owner: '0xo', container: c ?? '0xpredicted', opened: !!c };
        });
      }
      return items.map((s) => ({ exists: true, owner: '0xo', container: '0xsame', opened: sites.includes(`${s.tokenId}-${s.cpu}`) }));
    },
    async fileInfos(pairs) {
      up();
      calls.push(['fileInfos', pairs.map((p) => `${p.container}/${p.path}`)]);
      return pairs.map((p) => (indexed && !indexed.includes(p.container) ? null : { size: 1, contentType: 'text/html', sha256: sha(enc(body)), updatedAt: 1, chunkCount: 1 }));
    },
    async holdings(wallet, list) {
      up();
      return holds.map((h) => ({ cpu: h.cpu, circuits: list[h.cpu], balance: BigInt(h.ids.length) }));
    },
    async maxTokenId(circuits) {
      const h = holds.find((x) => cpus[x.cpu] === circuits);
      return h.maxId ?? Math.max(...h.ids);
    },
    async ownedIds(circuits, wallet, from, to, balance, block, onProgress) {
      const h = holds.find((x) => cpus[x.cpu] === circuits);
      onProgress?.(h.ids.length, h.ids.length);
      return h.ids;
    },
    async fileInfo() { up(); return { size: body.length, contentType: 'text/html', sha256: sha(enc(body)), updatedAt: 1, chunkCount: 1 }; },
    async readVerified() { return enc(body); },
  };
}

const many = (n) => Array.from({ length: n }, (_, i) => '0xcpu' + i);

test('12248：BNB 和 X Layer 的组合都查，只在各自的链上查', async () => {
  const bnb = fakeChain({ cpus: many(300), sites: ['12-248'] });
  const xlayer = fakeChain({ cpus: many(300), sites: ['1-248'] });
  const base = fakeChain({ cpus: many(300), sites: [] });
  const s = createSites({ bnb, xlayer, base });
  const r = await s.enumerateDigits('12248');
  assert.deepEqual(r.sites.map((x) => [x.label, x.url, x.network]), [
    ['12.248.tape', 'tape://12-248/', 'BNB Chain'],
    ['1.2.248.tape', 'tape://1-2-248/', 'X Layer'],
  ]);
  assert.deepEqual(xlayer.calls[0][1], ['1-248', '12-48']);
  // 12248 里没有区号 3 的切法，不去 Base 查
  assert.equal(base.calls.length, 0);
  assert.deepEqual(r.failed, []);
});

test('一条链读不了时其他链照常返回，并报告失败的链', async () => {
  const bnb = fakeChain({ cpus: many(300), sites: ['12-248'] });
  const xlayer = fakeChain({ cpus: [], sites: [], down: true });
  const s = createSites({ bnb, xlayer, base: fakeChain({ cpus: [], sites: [] }) });
  const r = await s.enumerateDigits('12248');
  assert.deepEqual(r.sites.map((x) => x.label), ['12.248.tape']);
  assert.deepEqual(r.failed.map((f) => f.network), ['X Layer']);
});

test('X Layer 和 Base 合约地址相同：同一个容器地址按链分开读，不会串', async () => {
  const xlayer = fakeChain({ cpus: many(10), sites: ['1-5'], body: 'on xlayer' });
  const base = fakeChain({ cpus: many(10), sites: ['1-5'], body: 'on base' });
  const s = createSites({ bnb: fakeChain({ cpus: [], sites: [] }), xlayer, base });
  const a = await s.site(1, 5, 2);
  const b = await s.site(1, 5, 3);
  assert.equal(a.container, b.container);
  assert.equal(new TextDecoder().decode((await s.readFile(a.container, 'index.html', 2)).bytes), 'on xlayer');
  assert.equal(new TextDecoder().decode((await s.readFile(b.container, 'index.html', 3)).bytes), 'on base');
  const d = await s.describe(1, 5, 'index.html', 3);
  assert.equal(d.network, 'Base');
  assert.equal(d.label, '1.3.5.tape');
  assert.equal(d.file.source, 'chain');
});

test('未知区号直接报错', async () => {
  const s = createSites({ bnb: fakeChain({ cpus: [], sites: [] }) });
  await assert.rejects(s.site(1, 5, 2), /区号/);
});

test('交叉校验：两个节点一致为 ok，有节点读到别的容器或哈希为 mismatch，节点不够为 single', async () => {
  const body = '<html>hi</html>';
  const chain = fakeChain({ cpus: many(3), sites: ['1-0'], body });
  let reads = [];
  chain.crossRead = async () => reads;
  // site() 只传 {circuits, tokenId}，这里直接当作已开通
  chain.circuitInfos = async (items) => items.map(() => ({ exists: true, owner: '0xo', container: '0xsame', opened: true }));
  const s = createSites({ bnb: chain });
  // 还没读过页面：不核对
  assert.equal((await s.verify(1, 0, 'index.html')).status, 'skip');
  await s.readFile('0xsame', 'index.html');
  reads = [{ node: 'n1', container: '0xSAME', opened: true, sha256: sha(enc(body)) }, { node: 'n2', container: '0xsame', opened: true, sha256: sha(enc(body)) }];
  assert.equal((await s.verify(1, 0, 'index.html')).status, 'ok');
  // 十分钟内同一个哈希用缓存
  reads = [];
  assert.equal((await s.verify(1, 0, 'index.html')).status, 'ok');
  const s2 = createSites({ bnb: chain });
  await s2.readFile('0xsame', 'index.html');
  reads = [{ node: 'n1', container: '0xevil', opened: true, sha256: sha(enc(body)) }, { node: 'n2', container: '0xsame', opened: true, sha256: '0xbad' }];
  const bad = await s2.verify(1, 0, 'index.html');
  assert.equal(bad.status, 'mismatch');
  assert.deepEqual(bad.mismatches.map((m) => [m.node, m.field]), [['n1', 'container'], ['n2', 'sha256']]);
  reads = [{ node: 'n1', container: '0xsame', opened: true, sha256: sha(enc(body)) }];
  assert.equal((await s2.verify(1, 0, 'index.html')).status, 'single');
});

test('容器资产：网站所在链的原生币，有 BEM 的链再加 BEM；一项失败不影响另一项', async () => {
  const mk = (bemFails) => ({
    ...fakeChain({ cpus: many(3), sites: ['1-0'] }),
    circuitInfos: async (items) => items.map(() => ({ exists: true, owner: '0xo', container: '0xc0ffee', opened: true })),
    nativeBalance: async (a) => { assert.equal(a, '0xc0ffee'); return 15n * 10n ** 17n; },
    tokenBalance: async (t, a) => { if (bemFails) throw new Error('rpc down'); assert.equal(a, '0xc0ffee'); return 12345678n; },
  });
  const s = createSites({ bnb: mk(false), xlayer: mk(true), base: mk(false) });
  assert.deepEqual(await s.containerAssets(1, 0), [
    { symbol: 'BNB', decimals: 18, amount: '1500000000000000000' },
    { symbol: 'BEM', decimals: 8, amount: '12345678' },
  ]);
  const x = await s.containerAssets(1, 0, 2);
  assert.equal(x[0].symbol, 'OKB');
  assert.match(x[1].error, /rpc down/);
  // Base 上没有 BEM，只查 ETH
  assert.deepEqual((await s.containerAssets(1, 0, 3)).map((a) => a.symbol), ['ETH']);
});

// 钱包在 X Layer 上持有：1.2.5（没开通）、1.2.12（开通、没首页）、1.2.3（开通、有首页）、1.2.40（开通、有首页），
// 处理器 7 的 id 太多被跳过
const walletChain = () => fakeChain({
  cpus: many(10),
  holds: [{ cpu: 5, ids: [3, 1] }, { cpu: 2, ids: [12, 5, 40] }, { cpu: 7, ids: [1], maxId: 10 ** 9 }],
  containers: { '1-5': '0xa', '12-2': '0xb', '40-2': '0xc' },
  indexed: ['0xa', '0xc'],
});

test('circuitsOf：没开通、开通没首页、开通有首页的电路都列出来，按处理器、编号排序', async () => {
  const xlayer = walletChain();
  const s = createSites({ bnb: fakeChain({ cpus: [] }), xlayer });
  const events = [];
  const r = await s.circuitsOf('xlayer', '0xw', (p) => events.push(p.stage));
  assert.deepEqual(r.circuits, [
    { tokenId: 5, cpu: 2, circuits: '0xcpu2', label: '5.2.2.tape', container: '0xpredicted', opened: false, hasIndex: false },
    { tokenId: 12, cpu: 2, circuits: '0xcpu2', label: '12.2.2.tape', container: '0xb', opened: true, hasIndex: false },
    { tokenId: 40, cpu: 2, circuits: '0xcpu2', label: '40.2.2.tape', container: '0xc', opened: true, hasIndex: true },
    { tokenId: 1, cpu: 5, circuits: '0xcpu5', label: '1.2.5.tape', container: '0xa', opened: true, hasIndex: true },
    { tokenId: 3, cpu: 5, circuits: '0xcpu5', label: '3.2.5.tape', container: '0xpredicted', opened: false, hasIndex: false },
  ]);
  assert.deepEqual(r.skipped.map((x) => [x.cpu, x.network]), [[7, 'X Layer']]);
  // 只读已开通电路的首页
  assert.deepEqual(xlayer.calls.find((c) => c[0] === 'fileInfos')[1].sort(), ['0xa/index.html', '0xb/index.html', '0xc/index.html']);
  assert.ok(events.includes('circuits'));
  assert.ok(events.indexOf('circuits') > events.lastIndexOf('ids'));
});

test('circuitsOf：不在发布链列表里的链抛 CHAIN_UNSUPPORTED', async () => {
  const s = createSites({ bnb: fakeChain({ cpus: [] }), base: walletChain() });
  await assert.rejects(s.circuitsOf('base', '0xw'), (e) => e.code === 'CHAIN_UNSUPPORTED');
});

test('scanWallet 仍然只返回有首页的网站', async () => {
  const s = createSites({ bnb: fakeChain({ cpus: [] }), xlayer: walletChain() });
  const r = await s.scanWallet('0xw');
  assert.equal(r.circuits, 5);
  assert.deepEqual(r.sites.map((x) => x.label).sort(), ['1.2.5.tape', '40.2.2.tape']);
  assert.deepEqual(r.skipped.map((x) => x.cpu), [7]);
  assert.deepEqual(r.failed, []);
});
