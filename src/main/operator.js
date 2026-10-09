// 临时操作员：发布流程里唯一持有私钥、唯一签名的地方。不依赖 Electron。
// createOperator({ store, chain, net, container, owner, sleep, now })
//   store  operator-store：私钥只在 send 里通过 keyOf 临时取出，签完立刻清零
//   chain  createChain 的实例：nonceOf / sendRaw / receipt / nativeBalance
// 一次只允许一笔未确认的交易（pending）：先写盘再广播，崩溃或断网后由 settle 重发同一笔 raw。
// nonce 取几个节点里的最大值，并且必须比 store 里记的 lastNonce 大，防止节点落后时签出旧 nonce。
// 退款的 pending 节点永远不打包时（最低单价变了、X Layer 的 L1 数据费），resignRefund 用同一个 nonce 重签，
// 原子地替换 pending：每个版本都转给同一个持有人，只有一笔能上链。
// 错误信息和返回值里不会出现私钥。

import { signLegacy, uint } from './eth-tx.js';
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
   * 先读 nonce 再查回执：在同一个节点上，读 nonce 之后才上链的交易回执一定查得到。
   * 但 nonce 取的是几个节点里的最大值，回执只问一个节点，回执节点可能落后；
   * 所以看起来「nonce 被别的交易用掉」时，先等一轮再查一次回执，还是没有才算异常
   */
  async function check(p, pollMs) {
    const { latest } = await chain.nonceOf(address);
    let r = await chain.receipt(p.hash);
    if (r) return confirm(p, r);
    if (latest <= p.nonce) return null;
    await sleep(pollMs);
    r = await chain.receipt(p.hash);
    if (r) return confirm(p, r);
    if ((await chain.nonceOf(address)).latest <= p.nonce) return null;
    // 这个 nonce 不管被谁用掉都不能再用了
    store.setLastNonce(chainId, container, p.nonce);
    store.clearPending(chainId, container);
    throw new Error('临时钱包的交易状态异常，请重新检查');
  }

  /** settle 的实际逻辑，不检查 busy：给 send 内部调用 */
  async function settleInner({ timeoutMs = 120000, pollMs = 3000 } = {}) {
    const p = store.get(chainId, container)?.pending;
    if (!p) return null;
    const deadline = now() + timeoutMs;
    for (;;) {
      const done = await check(p, pollMs);
      if (done) return done;
      if (now() >= deadline) {
        // 带 code：调用方据此判断是「一直没打包」，而不是节点出错
        const e = new Error('交易还没确认，可以稍后继续');
        e.code = 'PENDING_TIMEOUT';
        throw e;
      }
      // 重发同一笔：节点丢了交易池也能补上；不管返回什么、抛什么都继续轮询
      try { await chain.sendRaw(p.raw); } catch { /* 继续轮询 */ }
      await sleep(pollMs);
    }
  }

  // 同一进程里 send / settle 不能并发：两次 send 都过了 pending 检查就会用同一个 nonce 签两笔。
  // 在第一个 await 之前同步检查并设置
  let busy = false;
  function enter() {
    if (busy) throw new Error('临时钱包正在处理另一笔交易');
    busy = true;
  }

  /** 处理 pending：没有时返回 null；确认后返回回执摘要（status 0 也返回，交给调用方判断） */
  // timeoutMs 限制的是轮询轮数；看似 nonce 被用掉时的复查还可能多等一个 pollMs
  async function settle(opts) {
    enter();
    try { return await settleInner(opts); } finally { busy = false; }
  }

  /** 唯一的签名入口。tx = { to, value, data, gas, gasPrice }；meta = { kind: 'upload' | 'refund', path?, index? } */
  async function send(tx, meta) {
    enter();
    try { return await sendInner(tx, meta); } finally { busy = false; }
  }

  /** 白名单检查后签名；私钥用完立刻清零 */
  function sign(frozen, kind) {
    assertOperatorTx(op, net, frozen, { refund: kind === 'refund' });
    const sk = store.keyOf(chainId, container);
    try { return signLegacy(sk, frozen); } finally { sk.fill(0); }
  }

  /** pending 的落盘形式；退款记下金额，崩溃后再确认时能报出退了多少 */
  function pendingOf({ raw, hash }, frozen, { kind, path, index }) {
    const p = { raw, hash, kind, path, index, nonce: frozen.nonce, gasPrice: uint('gasPrice', frozen.gasPrice) };
    if (kind === 'refund') p.value = uint('value', frozen.value);
    return p;
  }

  async function sendInner(tx, { kind, path, index } = {}) {
    // 先复制，后面的 await 期间调用方改了 tx 也不影响
    const fields = { to: tx.to, value: tx.value, data: tx.data, gas: tx.gas, gasPrice: tx.gasPrice };
    if (store.get(chainId, container)?.pending) throw new Error('还有一笔交易在等确认');

    const { latest, pending } = await chain.nonceOf(address);
    if (pending > latest) throw new Error('临时钱包有未确认的交易');
    // 再读一次记录：lastNonce 以盘上为准
    const lastNonce = store.get(chainId, container)?.lastNonce ?? null;
    if (lastNonce != null && latest <= lastNonce) throw new Error('节点还没同步到最新区块，请稍后再试');

    const frozen = Object.freeze({ ...fields, chainId, nonce: latest });
    const signed = sign(frozen, kind);
    const { raw, hash } = signed;

    store.setPending(chainId, container, pendingOf(signed, frozen, { kind, path, index }));
    // 网络错误原样抛出，pending 保留，由 settle 重发
    const res = await chain.sendRaw(raw);
    if (typeof res === 'string') {
      if (lower(res) !== lower(hash)) throw new Error('节点返回的交易哈希不一致');
      return hash;
    }
    if (res?.reason === 'nonceUsed') {
      // 可能就是这笔已经上链了，也可能 nonce 被别的交易用掉了；查一次，不轮询（看似被用掉时会多等一轮复查）
      const r = await settleInner({ timeoutMs: 0 });
      if (r && lower(r.hash) === lower(hash)) return hash;
      throw new Error('临时钱包的交易状态异常，请重新检查');
    }
    // reason 'pending'：已在交易池里，算广播成功
    return hash;
  }

  /**
   * 用 pending 那笔退款的 nonce 重签一笔退款（金额、gas、单价可以变），替换 pending 后广播，返回新哈希。
   * 只有 pending 是退款时允许；之后照常 settle。广播出错不要紧：pending 已经是新的这笔，settle 会重发
   */
  async function resignRefund({ value, gas, gasPrice }) {
    enter();
    try {
      const p = store.get(chainId, container)?.pending;
      if (p?.kind !== 'refund') throw new Error('只有退款交易可以重签');
      const frozen = Object.freeze({ to: op.owner, value, data: '0x', gas, gasPrice, chainId, nonce: p.nonce });
      const signed = sign(frozen, 'refund');
      store.replacePending(chainId, container, pendingOf(signed, frozen, { kind: 'refund' }));
      try { await chain.sendRaw(signed.raw); } catch { /* settle 会重发 */ }
      return signed.hash;
    } finally { busy = false; }
  }

  return {
    address,
    resignRefund,
    // block 可以钉在最近一笔确认交易的区块上，防止落后的节点读到充值之前的余额
    balance: (block) => chain.nativeBalance(address, block),
    send,
    settle,
  };
}
