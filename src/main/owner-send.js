// 持有人发交易：把 publisher 要发的开通、授权、充值交易交给桥接页里的钱包签名并广播。纯模块，不依赖 Electron。
// createOwnerSend({ bridge, net, origin, onStep, sleep }) → ownerSend(tx, kind)
//   bridge  bridge-server 的实例：state（ready / accounts / chainId）和 request(method, params, origin)
//   net     当前链：chainId、chainIdHex、name
//   origin  发请求时带给桥接页的来源
//   onStep  发之前调 onStep({ kind, value })，界面据此提示这一步要签什么（kind: open | grant | fund）
//   sleep   切链后等状态更新用，测试里注入
// 签名前核对账户和链：持有人交易里没有 chainId 字段，切错链会把开通费或充值发到别的链上。
// 返回钱包给的哈希原样交回，格式由 publisher 检查（BAD_WALLET_HASH）。

import * as E from './publish-errors.js';

const { fail } = E;

// 切链之后桥接页的状态是异步推过来的：最多再查这么多次，每次隔 SWITCH_POLL_MS
const SWITCH_POLLS = 10;
const SWITCH_POLL_MS = 200;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** bigint 和非负安全整数转 0x 十六进制，其他值（字符串等）原样 */
function toHexField(v) {
  if (typeof v === 'bigint') return '0x' + v.toString(16);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return '0x' + v.toString(16);
  return v;
}

export function createOwnerSend({ bridge, net, origin, onStep, sleep = defaultSleep }) {
  const chainOk = () => bridge.state.chainId === net.chainIdHex;
  const chainError = () => fail(E.WALLET_CHAIN, `钱包没有切换到 ${net.name}`);

  /** 让钱包切到 net；用户拒绝、切完仍不对都抛 WALLET_CHAIN */
  async function ensureChain() {
    try {
      await bridge.request('wallet_switchEthereumChain', [{ chainId: net.chainIdHex }], origin);
    } catch (e) {
      // 用户拒绝切链（超时也算没切成）；这时还没发交易，不会有钱发出去
      if (e?.code === 4001) throw chainError();
      if (e?.code === 4900) throw fail(E.WALLET_NOT_CONNECTED, '请先连接钱包');
      throw e;
    }
    for (let i = 0; i < SWITCH_POLLS && !chainOk(); i++) await sleep(SWITCH_POLL_MS);
    if (!chainOk()) throw chainError();
  }

  /** 钱包已连接且当前账户就是 from（不分大小写） */
  function checkWallet(from) {
    const s = bridge.state;
    if (!s.ready) throw fail(E.WALLET_NOT_CONNECTED, '请先连接钱包');
    if (String(s.accounts?.[0] ?? '').toLowerCase() !== String(from).toLowerCase()) {
      throw fail(E.WALLET_ACCOUNT, '钱包当前账户不是这个电路的持有人');
    }
  }

  return async function ownerSend(tx, kind) {
    checkWallet(tx.from);
    if (!chainOk()) {
      await ensureChain();
      // 切链期间用户可能换了账户或断开了，再核对一次
      checkWallet(tx.from);
    }

    onStep?.({ kind, value: tx.value });
    const params = Object.fromEntries(Object.entries(tx).map(([k, v]) => [k, toHexField(v)]));
    try {
      return await bridge.request('eth_sendTransaction', [params], origin);
    } catch (e) {
      // 超时和断开时钱包可能已经广播了：publisher 下次 run 先查 nonce 兜底
      if (e?.code === 4001 && e.timeout) throw fail(E.WALLET_LOST, '钱包没有回应，交易可能已经发出；稍后继续时会先检查');
      if (e?.code === 4001) throw fail(E.USER_REJECTED, '你在钱包里拒绝了这笔交易');
      if (e?.code === 4900) throw fail(E.WALLET_LOST, '钱包没有回应，交易可能已经发出；稍后继续时会先检查');
      throw e;
    }
  };
}
