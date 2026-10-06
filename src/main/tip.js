// 打赏：从当前浏览器身份的容器，把 BEM 转进当前网站的容器。不依赖 Electron。
//
// 容器是跟着电路走的合约账户，只有电路持有人能调用它的 execute 转出资产，而且每次要附带一笔手续费
// （BSC 上 0.0002 BNB，X Layer 上 0.0013 OKB，由容器合约决定，这里按合约报错里的数额读出来）。
//
//   交易   from = 身份持有人（当前钱包），to = 身份容器，value = 手续费，
//          data = execute(BEM 合约, 0, transfer(网站容器, 数额), 0)
//   限制   身份和网站必须在同一条链上；不能打赏给自己的身份容器

import { encodeCall, decodeResult, hexToBytes } from './abi.js';
import { BEM_DECIMALS } from './bem.js';

export const EXECUTE = '0x51945447'; // execute(address,uint256,bytes,uint8)
export const TRANSFER = '0xa9059cbb'; // transfer(address,uint256)
// 容器合约「手续费不够」的报错：前 4 字节，后面两个 uint256 是 (已付, 需要)
export const FEE_ERROR = '0xafd49700';

/** 「1.5」→ 150000000n（BEM 8 位精度）；不合法、为 0、小数位太多时抛出 */
export function parseBem(text, tr = (t, v) => (v ? t.replace(/\{(\w+)\}/g, (a, k) => String(v[k] ?? a)) : t)) {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(tr('数额不合法'));
  const [whole, frac = ''] = s.split('.');
  if (frac.length > BEM_DECIMALS) throw new Error(tr('BEM 最多 {n} 位小数', { n: BEM_DECIMALS }));
  const v = BigInt(whole) * 10n ** BigInt(BEM_DECIMALS) + BigInt((frac + '0'.repeat(BEM_DECIMALS)).slice(0, BEM_DECIMALS));
  if (v <= 0n) throw new Error(tr('数额要大于 0'));
  return v;
}

/** 打赏交易的调用数据 */
export function tipCallData(bem, siteContainer, amount) {
  const inner = encodeCall(TRANSFER, ['address', 'uint'], [siteContainer, amount]);
  return encodeCall(EXECUTE, ['address', 'uint', 'bytes', 'uint'], [bem, 0n, hexToBytes(inner), 0n]);
}

/**
 * 读容器 execute 要附带的手续费：不带手续费模拟一次，从报错里取出需要的数额。
 * 模拟直接成功说明不需要手续费，返回 0n；其他报错原样抛出
 */
export async function executeFee(rpc, { from, container, data }) {
  try {
    await rpc('eth_call', [{ from, to: container, data, value: '0x0' }, 'latest']);
    return 0n;
  } catch (e) {
    const d = typeof e?.data === 'string' ? e.data : typeof e?.data?.data === 'string' ? e.data.data : '';
    if (d.toLowerCase().startsWith(FEE_ERROR) && d.length >= 10 + 128) {
      const [, need] = decodeResult(['uint', 'uint'], '0x' + d.slice(10));
      return need;
    }
    throw e;
  }
}

/**
 * 准备一笔打赏：核对条件、读手续费、带上手续费再模拟一次。返回 {tx, fee, amount}；条件不满足时抛出，message 给用户看。
 *   identity  {network, container, owner, opened}（identity.js 的 current）
 *   site      {network, container, opened, label}
 *   account   当前钱包地址
 *   balance   身份容器里的 BEM（最小单位）
 */
const fill = (t, v) => (v ? t.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(v, k) ? String(v[k]) : all)) : t);

/** tr 是界面文字翻译（见 i18n/i18n.cjs），报错文字给用户看 */
export async function prepareTip({ rpc, net, identity, site, account, amount, balance, tr = fill }) {
  if (!identity) throw new Error(tr('请先登录浏览器身份'));
  if (!identity.opened) throw new Error(tr('身份的容器还没开通'));
  if (!site?.container || !site.opened) throw new Error(tr('这个网站没有开通容器，不能打赏'));
  if (identity.network !== site.network) throw new Error(tr('身份在 {a}，网站在 {b}：只能打赏同一条链上的网站', { a: identity.networkName, b: net.name }));
  if (!net.bem) throw new Error(tr('{name} 上没有 BEM', { name: net.name }));
  const me = String(account || '').toLowerCase();
  if (!me || me !== String(identity.owner || '').toLowerCase()) throw new Error(tr('当前钱包不是这个身份的持有人'));
  if (String(identity.container).toLowerCase() === String(site.container).toLowerCase()) throw new Error(tr('不能打赏给自己的身份'));
  if (balance !== null && balance !== undefined && amount > BigInt(balance)) throw new Error(tr('身份容器里的 BEM 不够'));
  const data = tipCallData(net.bem, site.container, amount);
  const fee = await executeFee(rpc, { from: me, container: identity.container, data });
  const tx = { from: me, to: identity.container, value: '0x' + fee.toString(16), data };
  // 带上手续费再模拟一次：余额不够、合约另有限制时在这里就能发现，不会让用户白签一笔失败的交易
  await rpc('eth_call', [{ from: me, to: tx.to, data, value: tx.value }, 'latest']);
  return { tx, fee, amount };
}
