import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectory, extractTitle, FULL_SCAN_EVERY, QUICK_CHECK_EVERY } from '../src/main/directory.js';

const enc = (s) => new TextEncoder().encode(s);

test('extractTitle：解码实体、去掉标签和控制字符', () => {
  assert.equal(extractTitle(enc('<html><head><TITLE lang="zh"> 我的 &amp; <b>网站</b>&#x21;\n </TITLE>')), '我的 & 网站!');
  assert.equal(extractTitle(enc('<p>no title</p>')), '');
  assert.equal(extractTitle(enc('<title>' + 'a'.repeat(300) + '</title>')).length, 120);
  assert.equal(extractTitle(enc('<title>&lt;script&gt;\u0007x</title>')), '<script> x');
});

// 两个处理器：cpu0 有 1..3，cpu1 有 1..2；已开通：0-1、0-3、1-2；有首页：0-1、1-2
function fakeChain() {
  const st = {
    opened: new Set(['1-0', '3-0', '2-1']),
    index: { '0xc1-0': { sha256: '0xaa', size: 10, updatedAt: 100 }, '0xc2-1': { sha256: '0xbb', size: 999999, updatedAt: 200 } },
    multicalls: 0,
  };
  const container = (tokenId, cpu) => `0xc${tokenId}-${cpu}`;
  return {
    st,
    async pinBlock() { return 1; },
    async cpuList() { return ['0xcpu0', '0xcpu1']; },
    async nextIds() { return [4, 3]; },
    async openedFlags(pairs, _b, onBatch) { st.multicalls++; await onBatch?.(pairs.length, pairs.length); return pairs.map((p) => st.opened.has(`${p.tokenId}-${p.cpu}`)); },
    async circuitInfos(items) {
      return items.map((s) => ({ exists: true, owner: '0xOwner', container: container(s.tokenId, s.cpu), opened: st.opened.has(`${s.tokenId}-${s.cpu}`) }));
    },
    async fileInfos(pairs) { return pairs.map((p) => st.index[p.container] ?? null); },
  };
}

function fakeSites(html) {
  let reads = 0;
  return { reads: () => reads, async readFile(c) { reads++; return { info: { sha256: html[c].sha }, bytes: enc(html[c].body) }; } };
}

test('完整扫描收录有首页的网站；标题按 sha 缓存；大首页不下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const file = join(dir, 'directory.json');
  let t = 1_000_000;
  const chain = fakeChain();
  const html = { '0xc1-0': { sha: '0xaa', body: '<title>Hello</title>' } };
  const sites = fakeSites(html);
  let changes = 0;
  let last;
  const d = createDirectory({ chain, sites, file, now: () => t, pause: 0, onChange: () => changes++, onProgress: (p) => { last = p; } });
  await d.refresh();
  const list = d.list().sort((a, b) => a.cpu - b.cpu);
  assert.deepEqual(list.map((s) => s.label), ['1.0.tape', '2.1.tape']);
  assert.equal(list[0].title, 'Hello');
  assert.equal(list[0].url, 'tape://1-0/');
  assert.equal(list[1].title, '');
  assert.equal(sites.reads(), 1);
  assert.ok(changes > 0);
  assert.equal(d.status().count, 2);
  assert.equal(d.status().running, false);
  assert.equal(last, null, '结束时推送的状态不再是 running');

  // 还没到期：refresh 什么也不做
  await d.refresh();
  assert.equal(chain.st.multicalls, 1);
  assert.equal(sites.reads(), 1);

  // 一小时后快速检查：首页更新，重新取标题；1-2 下线
  t += QUICK_CHECK_EVERY;
  chain.st.index['0xc1-0'] = { sha256: '0xa2', size: 10, updatedAt: 300 };
  html['0xc1-0'] = { sha: '0xa2', body: '<title>Hello v2</title>' };
  chain.st.opened.delete('2-1');
  await d.refresh();
  assert.equal(chain.st.multicalls, 1, '快速检查不做全链扫描');
  assert.deepEqual(d.list().map((s) => [s.label, s.title, s.updatedAt]), [['1.0.tape', 'Hello v2', 300]]);

  // 重启后从文件恢复
  const d2 = createDirectory({ chain, sites, file, now: () => t, pause: 0 });
  assert.equal(d2.list()[0].title, 'Hello v2');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).lastFullScan);

  // 一天后完整扫描，新开通的网站被收录
  t += FULL_SCAN_EVERY;
  chain.st.opened.add('2-0');
  chain.st.index['0xc2-0'] = { sha256: '0xcc', size: 5, updatedAt: 400 };
  html['0xc2-0'] = { sha: '0xcc', body: '<title>New</title>' };
  await d2.refresh();
  assert.equal(chain.st.multicalls, 2);
  assert.deepEqual(d2.list().map((s) => s.label).sort(), ['1.0.tape', '2.0.tape']);
  rmSync(dir, { recursive: true, force: true });
});

test('同一时间只跑一次；失败时状态显示错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dir-'));
  const chain = fakeChain();
  chain.cpuList = async () => { throw new Error('rpc down'); };
  const d = createDirectory({ chain, sites: fakeSites({}), file: join(dir, 'd.json'), pause: 0 });
  const a = d.refresh();
  assert.equal(d.refresh({ force: true }), a);
  await assert.rejects(a, /rpc down/);
  assert.equal(d.status().progress.stage, 'error');
  assert.equal(d.status().running, false);
  rmSync(dir, { recursive: true, force: true });
});
