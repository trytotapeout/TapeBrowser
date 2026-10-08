// 打赏：用当前钱包直接把 BEM 转进当前网站的容器。不依赖 Electron。
//
//   交易   from = 当前钱包，to = BEM 合约，value = 0，data = transfer(网站容器, 数额)
//   限制   钱包要在网站所在的链上；网站容器要已开通；钱包里的 BEM 要够

import { encodeCall } from './abi.js';
import { BEM_DECIMALS } from './bem.js';

export const TRANSFER = '0xa9059cbb'; // transfer(address,uint256)

const fill = (t, v) => (v ? t.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(v, k) ? String(v[k]) : all)) : t);

/** 「1.5」→ 150000000n（BEM 8 位精度）；不合法、为 0、小数位太多时抛出 */
export function parseBem(text, tr = fill) {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(tr('数额不合法'));
  const [whole, frac = ''] = s.split('.');
  if (frac.length > BEM_DECIMALS) throw new Error(tr('BEM 最多 {n} 位小数', { n: BEM_DECIMALS }));
  const v = BigInt(whole) * 10n ** BigInt(BEM_DECIMALS) + BigInt((frac + '0'.repeat(BEM_DECIMALS)).slice(0, BEM_DECIMALS));
  if (v <= 0n) throw new Error(tr('数额要大于 0'));
  return v;
}

/** 打赏交易的调用数据 */
export const tipCallData = (siteContainer, amount) => encodeCall(TRANSFER, ['address', 'uint'], [siteContainer, amount]);

/**
 * 准备一笔打赏：核对条件，再在链上模拟一次。返回 {tx, amount}；条件不满足时抛出，message 给用户看。
 *   site      {container, opened}
 *   account   当前钱包地址
 *   balance   钱包在这条链上的 BEM（最小单位）；null 表示没读到，交给模拟去发现
 * tr 是界面文字翻译（见 i18n/i18n.cjs）
 */
export async function prepareTip({ rpc, net, site, account, amount, balance, tr = fill }) {
  const me = String(account || '').toLowerCase();
  if (!me) throw new Error(tr('请先连接钱包'));
  if (!site?.container || !site.opened) throw new Error(tr('这个网站没有开通容器，不能打赏'));
  if (!net.bem) throw new Error(tr('{name} 上没有 BEM', { name: net.name }));
  if (balance !== null && balance !== undefined && amount > BigInt(balance)) throw new Error(tr('钱包里的 BEM 不够'));
  const tx = { from: me, to: net.bem, value: '0x0', data: tipCallData(site.container, amount) };
  // 先模拟一次：余额不够、合约另有限制时在这里就能发现，不会让用户白签一笔失败的交易
  await rpc('eth_call', [tx, 'latest']);
  return { tx, amount };
}
