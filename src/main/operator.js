// 临时操作员：发布流程里唯一持有私钥、唯一签名的地方。不依赖 Electron。
// createOperator({ store, chain, net, container, owner, sleep, now })
//   store  operator-store：私钥只在 send 里通过 keyOf 临时取出，签完立刻清零
//   chain  createChain 的实例：nonceOf / sendRaw / receipt / nativeBalance
// 一次只允许一笔未确认的交易（pending）：先写盘再广播，崩溃或断网后由 settle 重发同一笔 raw。
// nonce 取几个节点里的最大值，并且必须比 store 里记的 lastNonce 大，防止节点落后时签出旧 nonce。
// 错误信息和返回值里不会出现私钥。

import { signLegacy } from './eth-tx.js';
import { assertOperatorTx } from './publish-tx.js';

const lower = (a) => String(a).toLowerCase();
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOperator({ store, chain, net, container, owner, sleep = defaultSleep, now = Date.now }) {
  const chainId = net.chainId;
  const rec = store.get(chainId, container);
  if (!rec) throw new Error('临时钱包不存在');
  if (rec.owner !== lower(owner)) throw new Error('临时钱包的持有人不一致');
  const address = rec.address;
  const op = Object.freeze({ address, owner: rec.owner, container: rec.container });

  /** 有回执：先记下 nonce 已用，再清除 pending */
  function confirm(p, r) {
    store.setLastNonce(chainId, container, p.nonce);
    store.clearPending(chainId, container);
    return { hash: p.hash, status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, blockNumber: r.blockNumber };
  }

  /**
   * 查一次 pending 的状态：有回执返回结果；没回执但 nonce 已被用掉时清除 pending 并抛出；否则返回 null。
   * 先读 nonce 再查回执：读 nonce 之后才上链的交易，回执一定查得到，不会误判成被别的交易用掉
   */
  async function check(p) {
    const { latest } = await chain.nonceOf(address);
    const r = await chain.receipt(p.hash);
    if (r) return confirm(p, r);
    if (latest > p.nonce) {
      // 这个 nonce 不管被谁用掉都不能再用了
      store.setLastNonce(chainId, container, p.nonce);
      store.clearPending(chainId, container);
      throw new Error('临时钱包的交易状态异常，请重新检查');
    }
    return null;
  }

  /** 处理 pending：没有时返回 null；确认后返回回执摘要（status 0 也返回，交给调用方判断） */
  async function settle({ timeoutMs = 120000, pollMs = 3000 } = {}) {
    const p = store.get(chainId, container)?.pending;
    if (!p) return null;
    const deadline = now() + timeoutMs;
    for (;;) {
      const done = await check(p);
      if (done) return done;
      if (now() >= deadline) throw new Error('交易还没确认，可以稍后继续');
      // 重发同一笔：节点丢了交易池也能补上；不管返回什么、抛什么都继续轮询
      try { await chain.sendRaw(p.raw); } catch { /* 继续轮询 */ }
      await sleep(pollMs);
    }
  }

  /** 唯一的签名入口。tx = { to, value, data, gas, gasPrice }；meta = { kind: 'upload' | 'refund', path?, index? } */
  async function send(tx, { kind, path, index } = {}) {
    // 先复制，后面的 await 期间调用方改了 tx 也不影响
    const fields = { to: tx.to, value: tx.value, data: tx.data, gas: tx.gas, gasPrice: tx.gasPrice };
    if (store.get(chainId, container)?.pending) throw new Error('还有一笔交易在等确认');

    const { latest, pending } = await chain.nonceOf(address);
    if (pending > latest) throw new Error('临时钱包有未确认的交易');
    // 再读一次记录：lastNonce 以盘上为准
    const lastNonce = store.get(chainId, container)?.lastNonce ?? null;
    if (lastNonce != null && latest <= lastNonce) throw new Error('节点还没同步到最新区块，请稍后再试');

    const frozen = Object.freeze({ ...fields, chainId, nonce: latest });
    assertOperatorTx(op, net, frozen, { refund: kind === 'refund' });

    let signed;
    const sk = store.keyOf(chainId, container);
    try { signed = signLegacy(sk, frozen); } finally { sk.fill(0); }
    const { raw, hash } = signed;

    store.setPending(chainId, container, { raw, hash, kind, path, index, nonce: latest });
    // 网络错误原样抛出，pending 保留，由 settle 重发
    const res = await chain.sendRaw(raw);
    if (typeof res === 'string') {
      if (lower(res) !== lower(hash)) throw new Error('节点返回的交易哈希不一致');
      return hash;
    }
    if (res?.reason === 'nonceUsed') {
      // 可能就是这笔已经上链了，也可能 nonce 被别的交易用掉了；查一次，不等
      const r = await settle({ timeoutMs: 0 });
      if (r && lower(r.hash) === lower(hash)) return hash;
      throw new Error('临时钱包的交易状态异常，请重新检查');
    }
    // reason 'pending'：已在交易池里，算广播成功
    return hash;
  }

  return {
    address,
    balance: () => chain.nativeBalance(address),
    send,
    settle,
  };
}
