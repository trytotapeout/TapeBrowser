import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, declaredCategory, CATEGORIES } from '../src/main/category.js';

const enc = (s) => new TextEncoder().encode(s);

test('按标题关键词推测，标题命中带上依据', () => {
  assert.equal(classify('五子棋 · Gomoku').category, 'game');
  assert.equal(classify('BEM · 抵押借贷').category, 'finance');
  assert.equal(classify('TapeSign · 链上公证处').category, 'tool');
  assert.equal(classify('TapeOut On-Chain Chat').category, 'social');
  assert.equal(classify('TapeNow Gateway • Base').category, 'infra');
  assert.deepEqual(classify('BEM 消消乐').why, ['标题「消消乐」']);
});

test('标题看不出来时看描述和页面特征', () => {
  const game = enc('<title>NEON</title><canvas></canvas><script>addEventListener("keydown",f);requestAnimationFrame(t)</script>');
  assert.equal(classify('NEON', game).category, 'game');
  // 只有画布动画（可能是背景动效）不够分
  assert.equal(classify('Hello', enc('<canvas></canvas><script>requestAnimationFrame(t)</script>')).category, 'other');
  const desc = enc('<meta name="description" content="A lending market for BEM">');
  assert.equal(classify('Foo', desc).category, 'finance');
  assert.deepEqual(classify('Foo', desc).why, ['描述「lending」']);
  const token = enc('<script>window.ethereum.request({method:"eth_sendTransaction"}); approve(</script>');
  assert.equal(classify('Foo', token).category, 'finance', '通过钱包调用代币授权');
  const connect = enc('<script>window.ethereum.request({method:"eth_requestAccounts"})</script>');
  assert.equal(classify('Foo', connect).category, 'other', '只是连钱包，不硬猜');
});

test('认不出来归其他；结果一定在分类列表里', () => {
  assert.deepEqual(classify('海思'), { category: 'other', why: [] });
  assert.deepEqual(classify('', null), { category: 'other', why: [] });
  assert.ok(CATEGORIES.includes(classify('random words').category));
});

test('declaredCategory：只认分类列表里的值，大小写和空格不敏感', () => {
  assert.equal(declaredCategory({ category: ' Game ' }), 'game');
  assert.equal(declaredCategory({ category: 'casino' }), null);
  assert.equal(declaredCategory({ category: 3 }), null);
  assert.equal(declaredCategory(null), null);
});
