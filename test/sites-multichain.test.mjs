import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSites } from '../src/main/sites.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const enc = (s) => new TextEncoder().encode(s);

// 每条链：处理器列表 + 有首页的电路（"tokenId-cpu"）+ 首页内容
function fakeChain({ cpus, sites, body = 'x', down = false }) {
  const calls = [];
  const up = () => { if (down) throw new Error('rpc down'); };
  return {
    calls,
    async pinBlock() { up(); return 'latest'; },
    async cpuList() { up(); return cpus; },
    async circuitInfos(items) {
      up();
      calls.push(['circuitInfos', items.map((s) => `${s.tokenId}-${s.cpu}`)]);
      return items.map((s) => ({ exists: true, owner: '0xo', container: '0xsame', opened: sites.includes(`${s.tokenId}-${s.cpu}`) }));
    },
    async fileInfos(pairs) { up(); return pairs.map(() => ({ size: 1, contentType: 'text/html', sha256: sha(enc(body)), updatedAt: 1, chunkCount: 1 })); },
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
