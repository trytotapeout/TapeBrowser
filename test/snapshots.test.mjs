import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshots, fitJpeg, coverRect } from '../src/main/snapshots.js';

test('coverRect：从顶部裁 16:10，宽页面裁两边', () => {
  assert.deepEqual(coverRect(1600, 1200), { x: 0, y: 0, width: 1600, height: 1000 });
  assert.deepEqual(coverRect(2000, 500), { x: 600, y: 0, width: 800, height: 500 });
  assert.equal(coverRect(0, 100), null);
});

test('fitJpeg：降宽度和质量直到不超过上限', () => {
  const tried = [];
  const encode = (w, q) => { tried.push([w, q]); return new Uint8Array(w * q); };
  // 640 宽最低质量 40 还是 25600，超过 25000，换 480 宽：480×50=24000
  assert.equal(fitJpeg(encode, 25000).length, 480 * 50);
  assert.deepEqual(tried.at(-1), [480, 50]);
  assert.equal(fitJpeg(encode, 10), null);
});

test('createSnapshots：按首页 sha256 对应，超出上限删最旧的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  try {
    let t = 0;
    const snaps = createSnapshots(dir, { now: () => ++t, max: 2 });
    snaps.put('1-0', '0xa', new Uint8Array([1, 2]));
    assert.ok(snaps.has('1-0', '0xa'));
    assert.equal(snaps.has('1-0', '0xb'), false);
    assert.deepEqual([...snaps.get('1-0', '0xa')], [1, 2]);
    assert.equal(snaps.get('1-0', '0xb'), null);
    assert.equal(snaps.get('../x', '0xa'), null);
    snaps.put('2-0', '0xc', new Uint8Array([3]));
    snaps.put('3-0', '0xd', new Uint8Array([4]));
    assert.equal(snaps.has('1-0', '0xa'), false);
    assert.equal(existsSync(join(dir, '1-0.jpg')), false);
    // 重新打开还在
    const again = createSnapshots(dir);
    assert.ok(again.has('3-0', '0xd'));
    assert.ok(again.has('2-0', '0xc'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
