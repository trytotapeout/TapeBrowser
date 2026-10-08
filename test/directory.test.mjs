import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectory, extractTitle, FULL_SCAN_EVERY, QUICK_CHECK_EVERY, IMAGE_MAX_BYTES } from '../src/main/directory.js';

const enc = (s) => new TextEncoder().encode(s);

test('extractTitle：解码实体、去掉标签和控制字符', () => {
  assert.equal(extractTitle(enc('<html><head><TITLE lang="zh"> 我的 &amp; <b>网站</b>&#x21;\n </TITLE>')), '我的 & 网站!');
  assert.equal(extractTitle(enc('<p>no title</p>')), '');
  assert.equal(extractTitle(enc('<title>' + 'a'.repeat(300) + '</title>')).length, 120);
  assert.equal(extractTitle(enc('<title>&lt;script&gt;\u0007x</title>')), '<script> x');
});

// 两个处理器：cpu0 有 1..3，cpu1 有 1..2（nextId 是最后一个编号）；已开通：0-1、0-3、1-2；有首页：0-1、1-2
function fakeChain(tag = '') {
  const st = {
    down: false,
    opened: new Set(['1-0', '3-0', '2-1']),
    index: { [`0x${tag}c1-0`]: { sha256: '0xaa', size: 10, updatedAt: 100 }, [`0x${tag}c2-1`]: { sha256: '0xbb', size: 999999, updatedAt: 200 } },
    // 首页以外的文件：'容器/路径' → 文件信息（卡片图片）
    files: {},
    multicalls: 0,
    flagged: 0,
    ids: [3, 2],
  };
  const container = (tokenId, cpu) => `0x${tag}c${tokenId}-${cpu}`;
  const up = () => { if (st.down) throw new Error('rpc down'); };
  return {
    st,
    async pinBlock() { up(); return 1; },
    async cpuList() { up(); return ['0xcpu0', '0xcpu1']; },
    async nextIds() { up(); return st.ids; },
    async openedFlags(pairs, _b, onBatch) { up(); st.multicalls++; st.flagged += pairs.length; await onBatch?.(pairs.length, pairs.length); return pairs.map((p) => st.opened.has(`${p.tokenId}-${p.cpu}`)); },
    async circuitInfos(items) {
      up();
      return items.map((s) => ({ exists: true, owner: '0xOwner', container: container(s.tokenId, s.cpu), opened: st.opened.has(`${s.tokenId}-${s.cpu}`) }));
    },
    async fileInfos(pairs) { up(); return pairs.map((p) => (p.path === 'index.html' ? st.index[p.container] : st.files[`${p.container}/${p.path}`]) ?? null); },
  };
}

function fakeSites(html) {
  let reads = 0;
  const areas = [];
  return {
    reads: () => reads,
    areas,
    async readFile(c, path, area) {
      reads++;
      areas.push(area);
      const f = html[path === 'index.html' ? c : `${c}/${path}`];
      return f ? { info: { sha256: f.sha }, bytes: enc(f.body) } : null;
    },
  };
}

test('完整扫描收录有首页的网站；标题按 sha 缓存；大首页不下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const file = join(dir, 'directory.json');
  let t = 1_000_000;
  const chain = fakeChain();
  const html = { '0xc1-0': { sha: '0xaa', body: '<title>Hello</title>' } };
  const sites = fakeSites(html);
  let changes = 0;
  let pushes = 0;
  const d = createDirectory({ chains: { bnb: chain }, sites, file, now: () => t, pause: 0, onChange: () => changes++, onProgress: () => pushes++ });
  await d.refresh();
  const list = d.list().sort((a, b) => a.cpu - b.cpu);
  assert.deepEqual(list.map((s) => s.label), ['1.0.tape', '2.1.tape']);
  assert.equal(list[0].title, 'Hello');
  assert.equal(list[0].url, 'tape://1-0/');
  assert.equal(list[0].network, 'bnb');
  assert.equal(list[1].title, '');
  assert.equal(sites.reads(), 1);
  assert.ok(changes > 0 && pushes > 0);
  const st = d.status();
  assert.equal(st.count, 2);
  assert.equal(st.running, false);
  assert.equal(st.networks[0].progress, null, '结束后不再显示进度');

  // 还没到期：refresh 什么也不做
  await d.refresh();
  assert.equal(chain.st.multicalls, 1);
  assert.equal(sites.reads(), 1);

  // 一小时后快速检查：首页更新，重新取标题；2.1 下线
  t += QUICK_CHECK_EVERY;
  chain.st.index['0xc1-0'] = { sha256: '0xa2', size: 10, updatedAt: 300 };
  html['0xc1-0'] = { sha: '0xa2', body: '<title>Hello v2</title>' };
  chain.st.opened.delete('2-1');
  await d.refresh();
  // 只查 watch 里容器已开通、没有首页的 3.0
  assert.equal(chain.st.flagged, 5 + 1, '增量检查不做全链扫描');
  assert.deepEqual(d.list().map((s) => [s.label, s.title, s.updatedAt]), [['1.0.tape', 'Hello v2', 300]]);

  // 重启后从文件恢复
  const d2 = createDirectory({ chains: { bnb: chain }, sites, file, now: () => t, pause: 0 });
  assert.equal(d2.list()[0].title, 'Hello v2');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).scans.bnb.lastFullScan);

  // 一天后完整扫描，新开通的网站被收录
  t += FULL_SCAN_EVERY;
  chain.st.opened.add('2-0');
  chain.st.index['0xc2-0'] = { sha256: '0xcc', size: 5, updatedAt: 400 };
  html['0xc2-0'] = { sha: '0xcc', body: '<title>New</title>' };
  await d2.refresh();
  assert.equal(chain.st.multicalls, 3);
  assert.deepEqual(d2.list().map((s) => s.label).sort(), ['1.0.tape', '2.0.tape']);
  rmSync(dir, { recursive: true, force: true });
});

test('多条链各自收录；一条链失败不影响其他链', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const bnb = fakeChain();
  const xlayer = fakeChain('x');
  const html = { '0xc1-0': { sha: '0xaa', body: '<title>BNB</title>' }, '0xxc1-0': { sha: '0xaa', body: '<title>X</title>' } };
  const sites = fakeSites(html);
  const base = fakeChain('b');
  base.st.down = true;
  const d = createDirectory({ chains: { bnb, xlayer, base }, sites, file: join(dir, 'd.json'), pause: 0 });
  await d.refresh();
  const byLabel = Object.fromEntries(d.list().map((s) => [s.label, s]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['1.0.tape', '1.2.0.tape', '2.1.tape', '2.2.1.tape']);
  assert.equal(byLabel['1.2.0.tape'].url, 'tape://1-2-0/');
  assert.equal(byLabel['1.2.0.tape'].network, 'xlayer');
  assert.equal(byLabel['1.2.0.tape'].title, 'X');
  assert.equal(byLabel['1.0.tape'].title, 'BNB');
  // 读标题时带上区号，X Layer 的容器不会去 BNB 上找
  assert.deepEqual(sites.areas.sort(), [2, null].sort());
  const st = d.status();
  const net = Object.fromEntries(st.networks.map((n) => [n.key, n]));
  assert.equal(net.bnb.count, 2);
  assert.equal(net.xlayer.count, 2);
  assert.equal(net.base.progress.stage, 'error');
  assert.match(net.base.progress.message, /rpc down/);
  // 有一条链没扫成，整体不算「已更新」
  assert.equal(st.lastFullScan, 0);

  // Base 恢复后再刷新：只补扫 Base，已扫过的链不重扫
  base.st.down = false;
  await d.refresh();
  assert.equal(bnb.st.multicalls, 1);
  assert.equal(base.st.multicalls, 1);
  assert.ok(d.status().lastFullScan > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('同一时间只跑一次；全部链失败时 reject', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const chain = fakeChain();
  chain.st.down = true;
  const d = createDirectory({ chains: { bnb: chain }, sites: fakeSites({}), file: join(dir, 'd.json'), pause: 0 });
  const a = d.refresh();
  assert.equal(d.refresh({ force: true }), a);
  await assert.rejects(a, /rpc down/);
  assert.equal(d.status().networks[0].progress.stage, 'error');
  assert.equal(d.status().running, false);
  rmSync(dir, { recursive: true, force: true });
});

test('第 1 版目录文件：沿用条目并补上区号，但重新完整扫描', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const file = join(dir, 'd.json');
  writeFileSync(file, JSON.stringify({ sites: { '1-0': { tokenId: 1, cpu: 0, label: '1.0.tape', title: 'Old', titleSha: '0xaa', sha256: '0xaa' } }, lastFullScan: 5, lastQuickCheck: 5 }));
  const chain = fakeChain();
  const d = createDirectory({ chains: { bnb: chain }, sites: fakeSites({}), file, pause: 0 });
  assert.equal(d.list()[0].area, null);
  assert.equal(d.list()[0].title, 'Old');
  await d.refresh();
  assert.equal(chain.st.multicalls, 1);
  // 首页 sha 没变，旧标题沿用，不重新下载
  assert.equal(d.list().find((s) => s.label === '1.0.tape').title, 'Old');
  rmSync(dir, { recursive: true, force: true });
});

test('增量检查：新铸造的编号、首页晚上传的电路都会被收录；新处理器从 1 开始', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const file = join(dir, 'directory.json');
  let t = 1_000_000;
  const chain = fakeChain();
  const html = { '0xc1-0': { sha: '0xaa', body: '<title>A</title>' }, '0xc4-0': { sha: '0xdd', body: '<title>D</title>' }, '0xc3-0': { sha: '0xee', body: '<title>C</title>' }, '0xc1-2': { sha: '0xff', body: '<title>N</title>' } };
  const d = createDirectory({ chains: { bnb: chain }, sites: fakeSites(html), file, now: () => t, pause: 0 });
  await d.refresh();
  const flaggedAfterFull = chain.st.flagged;
  assert.equal(flaggedAfterFull, 5);

  // 一小时后：cpu0 新铸造 4、5（4 开通并上传首页，5 还没开通）
  t += QUICK_CHECK_EVERY;
  chain.st.ids = [5, 2];
  chain.st.opened.add('4-0');
  chain.st.index['0xc4-0'] = { sha256: '0xdd', size: 5, updatedAt: 1 };
  await d.refresh();
  // watch：3.0（已开通无首页）+ 4.0、5.0
  assert.equal(chain.st.flagged - flaggedAfterFull, 3);
  assert.ok(d.list().some((s) => s.label === '4.0.tape'));
  let sc = JSON.parse(readFileSync(file, 'utf8')).scans.bnb;
  assert.deepEqual(sc.seen, { '0xcpu0': 5, '0xcpu1': 2 });
  assert.deepEqual(Object.keys(sc.watch).sort(), ['3-0', '5-0']);

  // 再一小时：3.0 上传了首页；新增一个处理器 cpu2，铸造了 1
  t += QUICK_CHECK_EVERY;
  chain.st.index['0xc3-0'] = { sha256: '0xee', size: 5, updatedAt: 2 };
  chain.cpuList = async () => ['0xcpu0', '0xcpu1', '0xcpu2'];
  chain.st.ids = [5, 2, 1];
  chain.st.opened.add('1-2');
  chain.st.index['0xc1-2'] = { sha256: '0xff', size: 5, updatedAt: 3 };
  await d.refresh();
  assert.deepEqual(d.list().map((s) => s.label).sort(), ['1.0.tape', '1.2.tape', '2.1.tape', '3.0.tape', '4.0.tape']);
  sc = JSON.parse(readFileSync(file, 'utf8')).scans.bnb;
  assert.deepEqual(Object.keys(sc.watch), ['5-0']);
  assert.equal(sc.seen['0xcpu2'], 1);

  // 一周后完整扫描；没有 seen 的旧扫描记录也会完整扫描
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  delete raw.scans.bnb.seen;
  writeFileSync(file, JSON.stringify(raw));
  t += QUICK_CHECK_EVERY;
  const before = chain.st.flagged;
  const d2 = createDirectory({ chains: { bnb: chain }, sites: fakeSites(html), file, now: () => t, pause: 0 });
  await d2.refresh();
  assert.equal(chain.st.flagged - before, 8, '没有 seen 时完整扫描');
  rmSync(dir, { recursive: true, force: true });
});

test('firstPublished：记首页最早的上链时间，首页更新后不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const file = join(dir, 'directory.json');
  let t = 1_000_000;
  const chain = fakeChain();
  const d = createDirectory({ chains: { bnb: chain }, sites: fakeSites({ '0xc1-0': { sha: '0xaa', body: '' }, '0xc2-1': { sha: '0xbb', body: '' } }), file, now: () => t, pause: 0 });
  await d.refresh();
  const first = d.list().find((s) => s.label === '1.0.tape');
  assert.equal(first.firstPublished, 100);
  t += QUICK_CHECK_EVERY;
  chain.st.index['0xc1-0'] = { sha256: '0xa2', size: 10, updatedAt: 900 };
  await d.refresh();
  const after = d.list().find((s) => s.label === '1.0.tape');
  assert.equal(after.updatedAt, 900);
  assert.equal(after.firstPublished, 100, '首页更新后发布时间不变');
  rmSync(dir, { recursive: true, force: true });
});

test('卡片图片：logo、cover 各取第一个存在的格式；超过 50 KB 不用；按记下的 sha256 读取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const file = join(dir, 'directory.json');
  let t = 1_000_000;
  const chain = fakeChain();
  // 1.0：logo 有 png 也有 jpg（用 png），cover 只有 jpg；2.1：logo.png 太大，不退回 logo.jpg
  chain.st.files = {
    '0xc1-0/logo.png': { sha256: '0xl1', size: 2000, updatedAt: 1 },
    '0xc1-0/logo.jpg': { sha256: '0xl2', size: 1000, updatedAt: 1 },
    '0xc1-0/cover.jpg': { sha256: '0xv1', size: 3000, updatedAt: 1 },
    '0xc2-1/logo.png': { sha256: '0xl3', size: IMAGE_MAX_BYTES + 1, updatedAt: 1 },
    '0xc2-1/logo.jpg': { sha256: '0xl4', size: 100, updatedAt: 1 },
  };
  const html = { '0xc1-0': { sha: '0xaa', body: '<title>A</title>' }, '0xc1-0/logo.png': { sha: '0xl1', body: 'PNG' }, '0xc1-0/cover.jpg': { sha: '0xv1', body: 'JPG' } };
  let changes = 0;
  const d = createDirectory({ chains: { bnb: chain }, sites: fakeSites(html), file, now: () => t, pause: 0, onChange: () => changes++ });
  await d.refresh();
  const [a, b] = d.list().sort((x, y) => x.cpu - y.cpu);
  assert.deepEqual(a.logo, { path: 'logo.png', sha256: '0xl1', size: 2000 });
  assert.deepEqual(a.cover, { path: 'cover.jpg', sha256: '0xv1', size: 3000 });
  assert.equal(b.logo, null, '太大的 logo.png 不用，也不换成 logo.jpg');
  assert.equal(b.cover, null);

  const logo = await d.imageFor('1-0', 'logo');
  assert.equal(logo.type, 'image/png');
  assert.equal(new TextDecoder().decode(logo.bytes), 'PNG');
  assert.equal((await d.imageFor('1-0', 'cover')).type, 'image/jpeg');
  assert.equal(await d.imageFor('2-1', 'logo'), null);
  assert.equal(await d.imageFor('1-0', 'index'), null, '只能取 logo / cover');
  assert.equal(await d.imageFor('9-9', 'logo'), null);
  // 链上图片已经换了、目录还没检查到：sha256 对不上就不显示
  html['0xc1-0/logo.png'] = { sha: '0xnew', body: 'NEW' };
  assert.equal(await d.imageFor('1-0', 'logo'), null);

  // 只换了图片、首页没变，增量检查也会更新并通知界面
  t += QUICK_CHECK_EVERY;
  chain.st.files['0xc1-0/logo.png'] = { sha256: '0xnew', size: 2100, updatedAt: 2 };
  const before = changes;
  await d.refresh();
  assert.equal(d.list().find((s) => s.cpu === 0).logo.sha256, '0xnew');
  assert.ok(changes > before);
  assert.equal(new TextDecoder().decode((await d.imageFor('1-0', 'logo')).bytes), 'NEW');
  rmSync(dir, { recursive: true, force: true });
});
