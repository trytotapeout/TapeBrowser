// 主网只读冒烟测试（需要联网）：npm run live
import { createRpcPool } from '../src/main/rpc.js';
import { createChain } from '../src/main/chain.js';
import { createSites } from '../src/main/sites.js';
import { createTapeHandler } from '../src/main/tape-protocol.js';
import { DEFAULT_RPCS } from '../src/main/config.js';

const WALLET = '0x571d447f4f24688ec35ccf07f1d6993655f6af15';

const rpc = createRpcPool(() => DEFAULT_RPCS);
const sites = createSites(createChain(rpc));
const handle = createTapeHandler(sites);

const t0 = Date.now();
const cpus = await sites.cpus();
console.log('处理器数量', cpus.length);

for (const url of ['tape://4454-0/', 'tape://4453-0/', 'tape://4246-0/']) {
  const r = await handle(new Request(url));
  const body = await r.text();
  console.log(url, r.status, r.headers.get('content-type'), body.length, 'bytes');
}

const e = await sites.enumerateDigits('44540');
console.log('44540 候选', e.candidates, '有首页', e.sites.map((s) => s.label));

const w = await sites.scanWallet(WALLET, (p) => p.stage !== 'ids' && console.log('  进度', p));
console.log('钱包电路', w.circuits, '有首页', w.sites.map((s) => s.label), '跳过', w.skipped);
console.log('耗时', Date.now() - t0, 'ms');
