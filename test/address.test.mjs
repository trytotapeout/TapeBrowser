import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, parseHost, splitDigits, normalizePath } from '../src/main/address.js';
import { SIG, SEL } from '../src/main/config.js';
import { keccakHex } from '../src/main/keccak.js';

test('明确的电路写法都解析到 tape://4454-0/', () => {
  for (const s of ['tape://4454-0', 'tape://4454-0/', 'tape://4454.0', 'tape://4454.0.tape', '4454-0', '4454.0', '4454.0.tape', '#4454@0', '#4454.0', ' 4454.0 ']) {
    const r = parseInput(s);
    assert.equal(r.kind, 'site', s);
    assert.equal(r.tokenId, 4454);
    assert.equal(r.cpu, 0);
    assert.equal(r.url, 'tape://4454-0/', s);
  }
});

test('电路写法可以带路径', () => {
  assert.equal(parseInput('tape://4454-0/a/b.html?x=1').url, 'tape://4454-0/a/b.html?x=1');
  assert.equal(parseInput('4454.0/docs/').url, 'tape://4454-0/docs/');
  assert.equal(parseInput('#4454@0/x.png').url, 'tape://4454-0/x.png');
});

test('不带分隔符的数字走枚举', () => {
  assert.deepEqual(parseInput('12330.tape'), { kind: 'digits', digits: '12330', path: '/' });
  assert.equal(parseInput('tape://12330').kind, 'digits');
  assert.equal(parseInput('tape://12330.tape').digits, '12330');
  assert.equal(parseInput('12330').kind, 'digits');
});

test('splitDigits 列出所有字面合法的切分', () => {
  const s = (d) => splitDigits(d).map((x) => `${x.tokenId}.${x.cpu}`);
  assert.deepEqual(s('12330'), ['1.2330', '12.330', '123.30', '1233.0']);
  // 处理器编号不能有前导零，ID 不能为 0 开头
  assert.deepEqual(s('1205'), ['1.205', '120.5']);
  assert.deepEqual(s('100'), ['10.0']);
  assert.deepEqual(s('5'), []);
});

test('钱包地址、网址与无法识别', () => {
  assert.deepEqual(parseInput('0x571D447f4f24688ec35ccf07f1d6993655f6af15'), { kind: 'wallet', address: '0x571d447f4f24688ec35ccf07f1d6993655f6af15' });
  assert.deepEqual(parseInput('https://example.com/a'), { kind: 'url', url: 'https://example.com/a' });
  assert.deepEqual(parseInput('example.com'), { kind: 'url', url: 'https://example.com' });
  assert.equal(parseInput('hello world').kind, 'search');
  assert.equal(parseInput('tape://abc').kind, 'search');
  assert.equal(parseInput('0.0').kind, 'search');
  assert.equal(parseInput('').kind, 'empty');
});

test('parseHost 与 normalizePath', () => {
  assert.deepEqual(parseHost('4454-0'), { tokenId: 4454, cpu: 0 });
  assert.deepEqual(parseHost('12.330'), { tokenId: 12, cpu: 330 });
  assert.equal(parseHost('0-1'), null);
  assert.equal(parseHost('12-03'), null);
  assert.equal(normalizePath('/'), 'index.html');
  assert.equal(normalizePath(''), 'index.html');
  assert.equal(normalizePath('/docs/'), 'docs/index.html');
  assert.equal(normalizePath('/a%20b.html'), 'a b.html');
});

test('函数选择器与签名一致', () => {
  for (const [k, sig] of Object.entries(SIG)) {
    assert.equal(keccakHex(new TextEncoder().encode(sig)).slice(0, 10), SEL[k], sig);
  }
});
