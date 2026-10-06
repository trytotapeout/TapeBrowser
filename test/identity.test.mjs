import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../src/main/identity.js';

const ME = '0xaaaa000000000000000000000000000000000001';
const OTHER = '0xbbbb000000000000000000000000000000000002';
const PROCS = [
  { network: 'bnb', cpu: 1196, circuits: '0xc1' },
  { network: 'xlayer', cpu: 281, circuits: '0xc2' },
];

// owners: { 'bnb:1': addr, ... }；opened：已开通容器的 key
function fakes({ owners, opened = [], failNet = null }) {
  const chainFor = (net) => ({
    async holdings(wallet, [circuits]) {
      if (net === failNet) throw new Error('rpc down');
      const n = Object.entries(owners).filter(([k, a]) => k.startsWith(net + ':') && a === wallet).length;
      return n ? [{ cpu: 0, circuits, balance: n }] : [];
    },
    async maxTokenId() { return 5; },
    async ownedIds(_c, wallet, from, to) {
      const out = [];
      for (let i = from; i <= to; i++) if (owners[`${net}:${i}`] === wallet) out.push(i);
      return out;
    },
  });
  const chains = { bnb: chainFor('bnb'), xlayer: chainFor('xlayer') };
  const area = (a) => (a === 2 ? 'xlayer' : 'bnb');
  const sites = {
    async site(tokenId, _cpu, a) { const k = `${area(a)}:${tokenId}`; return { exists: true, owner: owners[k], opened: opened.includes(k), container: '0xcont' + tokenId }; },
    async containerAssets() { return [{ symbol: 'BNB', decimals: 18, amount: '1000000000000000' }, { symbol: 'BEM', decimals: 8, amount: '1000000' }]; },
  };
  let saved = null;
  const store = { get: () => saved, set: (v) => { saved = v; } };
  return { chains, sites, store, saved: () => saved };
}

const settle = async (id) => { for (let i = 0; i < 50 && (id.view().scanning || !id.view().identities); i++) await new Promise((r) => setImmediate(r)); };

test('列出钱包在各个身份处理器上持有的电路；登录后读容器资产', async () => {
  const f = fakes({ owners: { 'bnb:1': ME, 'bnb:3': ME, 'bnb:2': OTHER, 'xlayer:5': ME }, opened: ['bnb:1'] });
  const id = createIdentity({ chains: f.chains, sites: f.sites, store: f.store, processors: PROCS });
  id.setAccount(ME.toUpperCase().replace('0X', '0x'));
  await settle(id);
  assert.deepEqual(id.view().identities.map((x) => x.label), ['1.1196', '3.1196', '5.2.281']);
  assert.equal(id.view().current, null);
  const v = await id.login({ network: 'bnb', cpu: 1196, tokenId: 1 });
  id.stop();
  assert.equal(v.current.label, '1.1196');
  assert.equal(v.current.opened, true);
  assert.equal(v.current.container, '0xcont1');
  assert.equal(v.current.assets[1].symbol, 'BEM');
  assert.equal(f.saved().account, ME);
});

test('不能用别人持有的电路登录；容器没开通时标出来', async () => {
  const f = fakes({ owners: { 'bnb:1': ME, 'bnb:2': OTHER } });
  const id = createIdentity({ chains: f.chains, sites: f.sites, store: f.store, processors: PROCS });
  id.setAccount(ME);
  await settle(id);
  await assert.rejects(id.login({ network: 'bnb', cpu: 1196, tokenId: 2 }), /没有持有/);
  const v = await id.login({ network: 'bnb', cpu: 1196, tokenId: 1 });
  id.stop();
  assert.equal(v.current.opened, false);
  assert.deepEqual(v.current.assets, []);
});

test('电路转走后自动退出登录；换钱包也退出', async () => {
  const owners = { 'bnb:1': ME };
  const f = fakes({ owners, opened: ['bnb:1'] });
  const id = createIdentity({ chains: f.chains, sites: f.sites, store: f.store, processors: PROCS });
  id.setAccount(ME);
  await settle(id);
  await id.login({ network: 'bnb', cpu: 1196, tokenId: 1 });
  owners['bnb:1'] = OTHER;
  await id.refresh();
  assert.equal(id.view().current, null);
  assert.equal(f.saved(), null);
  // 换钱包
  owners['bnb:1'] = ME;
  await id.refresh();
  await id.login({ network: 'bnb', cpu: 1196, tokenId: 1 });
  id.setAccount(OTHER);
  id.stop();
  assert.equal(f.saved(), null);
});

test('身份所在的链读取失败时不退出登录，只提示', async () => {
  const f = fakes({ owners: { 'bnb:1': ME }, opened: ['bnb:1'] });
  const id = createIdentity({ chains: f.chains, sites: f.sites, store: f.store, processors: PROCS });
  id.setAccount(ME);
  await settle(id);
  await id.login({ network: 'bnb', cpu: 1196, tokenId: 1 });
  f.chains.bnb.holdings = async () => { throw new Error('rpc down'); };
  await id.refresh();
  id.stop();
  assert.ok(f.saved(), '保留登录');
  assert.match(id.view().error, /rpc down/);
});
