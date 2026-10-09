// 发布引擎：把本地文件夹发布到电路的链上容器。依赖全部注入，不依赖 Electron。
// createPublisher({ chain, net, ownerSend, store, readFiles, precheck, now, sleep })
//   chain      createChain 的实例：circuitInfos / fileInfos / openFee / gasPrice / estimateGas 等
//   ownerSend  持有人发交易（开通、授权、充值、撤销），阶段 3 接到桥接页
//   store      operator-store：临时钱包的私钥和进度
//   readFiles  读本地文件 → [{ path, bytes, sha256 }]
//   precheck   已绑定参数的预检查 → { items: [{ level, text }] }
// 流程分三步：
//   inspect  检查网络、预检查、电路状态、发布计划，估算费用；只读链，不发交易
//   run      开通 → 临时钱包 → 授权 → 充值 → 上传 → 核验 → 退款
//   refund   放弃发布、只退钱：把临时钱包剩下的余额退回记录里的持有人
// run 每一步都重新读链，不信任上次的进度；中断后再 run 一次就能接着传。
// 金额、gas、gasPrice 一律是 bigint；错误信息是给用户看的中文。

import { createHash } from 'node:crypto';
import { PUBLISH_NETWORKS, MAX_GAS_PRICE, MAX_UPLOAD_GAS, MAX_FILE_BYTES } from './config.js';
import { planPublish, stepsOf, chunkOf } from './publish-plan.js';
import { uploadTx, openTx, grantTx, fundTx, refundTx } from './publish-tx.js';
import { createOperator } from './operator.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxOf = (a, b) => (a > b ? a : b);
const utf8Len = (s) => BigInt(Buffer.byteLength(String(s), 'utf8'));
const slots = (n) => (n + 31n) / 32n;
const minOf = (a, b) => (a < b ? a : b);
const lower = (a) => String(a).toLowerCase();
const hexBlock = (n) => '0x' + n.toString(16);
const sumOf = (xs) => xs.reduce((a, b) => a + b, 0n);
// 每笔 gas 最后乘 1.25，和 Task 10 发交易时的 gasLimit 用同一个系数，充值按它算才够
const PAD_NUM = 125n;
const PAD_DEN = 100n;

// gas 估算按 EVM 规则保守估计，没有在链上实测过：
//   bytePart = 每字节按非零 calldata 16 + 写入代码 200（多算 1 字节 STOP 前缀）；零字节实际更便宜，所以只会多估
//   putFile    = 21000 基础 + 32000 建合约 + 150000 合约逻辑 + 每 32 字节路径 / 类型各一个新存储槽 22100 + bytePart
//   appendChunk = 21000 基础 + 32000 建合约 + 80000 合约逻辑 + bytePart
// 都不超过 MAX_UPLOAD_GAS
const bytePart = (len) => BigInt(len) * 16n + (BigInt(len) + 1n) * 200n;
const lenOf = (step) => chunkOf(step.row.bytes, step.index).length;

/** 一笔上传的 gas 上限；step = { path, index, row }，index 为 0 是 putFile，其余是 appendChunk */
export function stepGasBound(step) {
  const fixed = step.index === 0
    ? 21000n + 32000n + 150000n + 22100n * slots(utf8Len(step.path)) + 22100n * slots(utf8Len(step.row.contentType))
    : 21000n + 32000n + 80000n;
  const gas = fixed + bytePart(lenOf(step));
  return gas > MAX_UPLOAD_GAS ? MAX_UPLOAD_GAS : gas;
}

/** 节点返回的是合约回滚（模拟执行失败），而不是超时、限流之类的节点问题 */
function isRevert(e) {
  // data 只认 0x 开头的返回数据；有的节点限流时在 data 里放对象
  const d = e?.data;
  return e?.code === 3 || /revert/i.test(String(e?.message || '')) || (typeof d === 'string' && d.startsWith('0x') && d.length > 2);
}

const SHA = /^0x[0-9a-f]{64}$/;
const badPath = (p) => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\')
  || p.split('/').some((seg) => !seg || seg === '.' || seg === '..');

/**
 * 本地文件再核对一遍（读文件那一层已经查过，这里防御一下）：路径不重复、合法，大小在范围内，sha256 格式正确并和内容一致。
 * snapshot 为 true 时不重算 sha256：快照在第一次 inspect 已经核对过
 */
function assertFiles(files, snapshot) {
  const seen = new Set();
  for (const f of files) {
    const fail = () => { throw new Error(`本地文件异常：${f?.path}`); };
    if (badPath(f.path) || seen.has(f.path)) fail();
    seen.add(f.path);
    const n = f.bytes?.length;
    if (!(n > 0 && n <= MAX_FILE_BYTES)) fail();
    if (!SHA.test(String(f.sha256))) fail();
    if (!snapshot && f.sha256 !== '0x' + createHash('sha256').update(f.bytes).digest('hex')) fail();
  }
}

// run 里的固定参数：授权剩下不到 5 分钟就重新授权；估算回滚时隔 3 秒重试，最多重试 2 次；每 10 笔重新检查一次
const GRANT_MARGIN_SEC = 300;
const ESTIMATE_POLL_MS = 3000;
const ESTIMATE_RETRIES = 2;
const CHECK_EVERY = 10;
// 普通地址收款的 gas；X Layer 等 safe 区块最多 10 分钟，每 3 秒查一次
const TRANSFER_GAS = 21000n;
const SAFE_TIMEOUT_MS = 600000;
const SAFE_POLL_MS = 3000;
// 退款一直不打包时最多重签 2 次；X Layer 重签时多留 20% 手续费不退（可能有 L1 数据费，没有实测过）
const MAX_RESIGNS = 2;
const RESIGN_MARGIN = { xlayer: 20n };
// 重签的单价至少比旧的高 12.5%：节点按这个比例判断能不能替换交易池里同一个 nonce 的交易
const BUMP_NUM = 1125n;
const BUMP_DEN = 1000n;

// 正在执行 run / refund 的（chainId, 容器）。主进程只有一个实例，内存里互斥就够了
const running = new Map();
/** 同步占住这个容器，返回释放函数；已被占用直接抛出。必须在第一个 await 之前调用 */
function lockContainer(chainId, container) {
  const key = `${chainId}:${lower(container)}`;
  if (running.has(key)) throw new Error('这个容器正在发布');
  const token = {};
  running.set(key, token);
  return () => { if (running.get(key) === token) running.delete(key); };
}

// signal.aborted 时在两笔交易之间抛出它，run 捕获后返回 { stage: 'paused' }
const PAUSED = Symbol('paused');

export function createPublisher({ chain, net, ownerSend, store, readFiles, precheck, now = Date.now, sleep = defaultSleep }) {
  /** 读当前 gas 单价，读不到或太高就抛出 */
  async function currentGasPrice() {
    const gasPrice = await chain.gasPrice();
    if (gasPrice <= 0n) throw new Error('读不到有效的 Gas 单价，请稍后再试');
    if (gasPrice > MAX_GAS_PRICE) throw new Error('当前 Gas 单价太高，请稍后再试');
    return gasPrice;
  }

  /**
   * 估算上传的 gas：每笔先按上限算；已开通时用节点模拟第一笔 putFile 和第一笔能成功的 appendChunk
   * （只有续传那一行的下一块和链上状态对得上；新文件、整个替换的后续块要等 putFile 上链，模拟必然回滚，就只用上限），
   * 算出这类交易除字节以外的固定开销，套到同类型的每一笔，和上限取较大的；每笔再乘 1.25。
   * 模拟遇到合约回滚返回 { revert }，节点问题就只用上限。
   */
  async function estimateUpload({ owner, container, opened, steps, simulate }) {
    const gasPrice = await currentGasPrice();
    const overhead = {};
    // simulate 为 false（run 里重新检查）时不模拟：latest 可能落在落后的节点上，把正常的 appendChunk 模拟成回滚
    if (opened && simulate) {
      const firstPut = steps.find((s) => s.index === 0);
      const firstAppend = steps.find((s) => s.row.action === 'append' && s.index === s.row.from);
      for (const [type, first] of [['put', firstPut], ['append', firstAppend]]) {
        if (!first) continue;
        try {
          // 故意在 latest 上模拟：要的是当前链上状态下能不能执行
          const est = BigInt(await chain.estimateGas({ from: owner, ...uploadTx(net, container, first) }));
          overhead[type] = est - bytePart(lenOf(first));
        } catch (e) {
          if (isRevert(e)) return { revert: String(e?.message || e) };
        }
      }
    }
    const stepGas = steps.map((s) => {
      const extra = overhead[s.index === 0 ? 'put' : 'append'];
      const gas = extra === undefined ? stepGasBound(s) : maxOf(stepGasBound(s), bytePart(lenOf(s)) + extra);
      const padded = gas * PAD_NUM / PAD_DEN;
      return padded > MAX_UPLOAD_GAS ? MAX_UPLOAD_GAS : padded;
    });
    const uploadGas = stepGas.reduce((a, b) => a + b, 0n);
    return { gasPrice, stepGas, uploadGas, uploadCost: uploadGas * gasPrice };
  }

  /**
   * 发布前检查：返回 blocked / conflicts / ready 三种结果之一；网络不支持、电路不存在、本地文件异常、gas 单价不对直接抛出。
   * 传了 files（上一次 inspect 的快照）就跳过预检查和读文件，保证上传途中改了文件也不影响计划。
   * 同一次检查里的链上读取都钉在同一个区块；给了 minBlock（bigint）就不早于它，节点落后时直接用 minBlock（读不到由调用方重试）。
   * simulate 为 false 时不调 estimateGas，每笔只按 stepGasBound × 1.25 算（run 里重新检查用）。
   */
  async function inspect({ target, files, minBlock, simulate = true }) {
    if (!PUBLISH_NETWORKS.includes(net.key)) throw new Error('这条链暂时不支持发布');

    const snapshot = Boolean(files);
    if (!snapshot) {
      const { items } = await precheck();
      const errors = items.filter((i) => i.level === 'error');
      if (errors.length) return { stage: 'blocked', errors };
      files = await readFiles();
    }
    assertFiles(files, snapshot);

    let block = await chain.pinBlock();
    if (minBlock !== undefined && BigInt(block) < minBlock) block = '0x' + minBlock.toString(16);
    const [info] = await chain.circuitInfos([{ circuits: target.circuits, tokenId: target.tokenId }], block);
    if (!info || !info.exists) throw new Error('这个电路不存在');
    const { owner, container, opened } = info;

    // 没开通的容器里没有文件
    let openFee = 0n;
    let infos;
    if (opened) infos = await chain.fileInfos(files.map((f) => ({ container, path: f.path })), block);
    else {
      openFee = await chain.openFee(block);
      infos = files.map(() => null);
    }

    const plan = planPublish(files, infos);
    if (plan.conflicts.length) return { stage: 'conflicts', conflicts: plan.conflicts, plan };

    const steps = stepsOf(plan);
    const est = await estimateUpload({ owner, container, opened, steps, simulate });
    if (est.revert) return { stage: 'blocked', errors: [{ level: 'error', text: '链上模拟上传失败：' + est.revert }] };
    const { gasPrice, stepGas, uploadGas, uploadCost } = est;
    return {
      stage: 'ready', target, files, block, owner, container, opened, openFee, plan, steps,
      gasPrice, stepGas, uploadGas, uploadCost, totalCost: uploadCost + openFee,
    };
  }

  // ---- run：开通 → 临时钱包 → 授权 → 充值 → 上传 ----

  /** 轮询交易回执，超时抛出 message */
  async function waitReceipt(hash, { timeoutMs, pollMs = 3000, message }) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const r = await chain.receipt(hash);
      if (r) return r;
      if (now() >= deadline) throw new Error(message);
      await sleep(pollMs);
    }
  }

  /**
   * 执行一次发布：inspected 是 inspect 返回的 ready 结果；opts = { onProgress, signal }。
   * 返回 { stage: 'done', container, label, uploaded, reused, spent, refunded, dust, verified, reason, safeSkipped }
   * 或 { stage: 'paused' }（只在核验之前停下：核验和退款开始后一定做完）。
   * 同一个（chainId, 容器）同时只能有一个 run / refund
   */
  async function run(inspected, { onProgress, signal } = {}) {
    if (inspected?.stage !== 'ready') throw new Error('还没有检查通过，不能发布');
    // 同步加锁：第二个并发调用在这里就被拒绝
    const unlock = lockContainer(net.chainId, inspected.container);
    try {
      return await runInner(inspected, { onProgress, signal });
    } catch (e) {
      if (e === PAUSED) return { stage: 'paused' };
      throw e;
    } finally { unlock(); }
  }

  async function runInner(inspected, { onProgress, signal }) {
    const ctx = {
      target: inspected.target,
      files: inspected.files,
      container: inspected.container,
      owner: inspected.owner,
      // 最近一笔已确认交易的区块；之后的读取都不早于它
      minBlock: BigInt(inspected.block),
      lastBlock: null,
      uploaded: 0,
      spent: 0n,
      progress: (e) => onProgress?.(e),
      checkAbort: () => { if (signal?.aborted) throw PAUSED; },
    };
    // 临时钱包记录要在任何持有人交易之前就建好：持有人交易的在途记录（ownerPending）存在里面
    const operator = await openOperator(ctx);
    // 上次 run 确认过的区块：落后的节点不会让已开通的容器看起来没开通
    const saved = store.get(net.chainId, ctx.container)?.minBlock;
    if (saved != null && saved > ctx.minBlock) ctx.minBlock = saved;
    await settleOwnerPending(ctx);
    await settleOperator(ctx, operator);
    // 处理完上次留下的交易，再按最新状态决定从哪一步开始
    let cur = await reinspect(ctx);
    if (!cur.opened) cur = await openContainer(ctx, cur);
    await ensureGrant(ctx, operator);
    // reused 按开始上传时的计划算：传完以后再看，这次传的文件也都成了复用
    const { reused } = cur.plan;
    await uploadAll(ctx, cur, operator);
    const { check, refunded, dust } = await verifyThenRefund(ctx, operator);
    return {
      stage: 'done', container: ctx.container, label: ctx.target.label,
      uploaded: ctx.uploaded, reused, spent: ctx.spent, refunded, dust,
      verified: check.verified, reason: check.reason, safeSkipped: check.safeSkipped,
    };
  }

  /** 记下一笔已确认的交易：推进 minBlock / lastBlock，minBlock 同时落盘 */
  function confirmed(ctx, r) {
    const b = BigInt(r.blockNumber);
    if (b > ctx.minBlock) ctx.minBlock = b;
    if (ctx.lastBlock === null || b > ctx.lastBlock) ctx.lastBlock = b;
    store.setMinBlock(net.chainId, ctx.container, ctx.minBlock);
  }

  /** 临时钱包交易的花费：gasUsed × effectiveGasPrice（节点没给就用签名时的 gasPrice） */
  function charge(ctx, r, gasPrice) {
    ctx.spent += BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? gasPrice ?? 0n);
  }

  const OWNER_FAIL = { open: '开通容器失败', grant: '授权失败', fund: '充值失败' };

  /**
   * 等一笔持有人交易确认：有回执（不管成败）就清掉在途记录并返回回执；超时保留记录并抛出。
   * 持有人可能在钱包里加速或取消了这笔（同一个 nonce 换成另一笔交易上链），或者它被节点丢掉后钱包用这个 nonce 发了别的：
   * 原来的哈希永远不会有回执，一直等下去每次 run 都会卡 5 分钟。所以没有回执时再看持有人的 latest nonce，
   * 已经越过这笔的 nonce，就隔一个 pollMs 再查一次回执（回执节点可能落后，和 operator.js 一样）。还是没有，
   * 就取一个钉住的区块，确认它上面 nonce 也已经被用掉，把 minBlock 推到这个区块（替换的那笔一定在它之内），
   * 再清掉记录、返回 null，让调用方按链上状态重新判断这一步（替换的那笔可能做了同样的事，也可能什么都没做）。
   * 不推 minBlock 的话，落后的节点读到替换之前的余额，会再充一次值。钉住的区块还没看到 nonce 被用掉，就当它还在等。
   * 早期记录没有 nonce，只能等回执
   */
  async function awaitOwner(ctx, { kind, hash, nonce }, { timeoutMs = 300000, pollMs = 3000 } = {}) {
    const deadline = now() + timeoutMs;
    for (;;) {
      let r = await chain.receipt(hash);
      if (!r && nonce != null && (await chain.nonceOf(ctx.owner)).latest > nonce) {
        await sleep(pollMs);
        r = await chain.receipt(hash);
        if (!r && await replacedBy(ctx, { kind, nonce })) return null;
      }
      if (r) {
        store.clearOwnerPending(net.chainId, ctx.container);
        if (r.status !== 1) throw new Error(OWNER_FAIL[kind]);
        confirmed(ctx, r);
        return r;
      }
      if (now() >= deadline) throw new Error('持有人的交易还没确认，可以稍后继续');
      await sleep(pollMs);
    }
  }

  /** 钉住的区块上持有人的 nonce 已经越过这笔：推进 minBlock、清掉记录，返回 true；还没看到就返回 false */
  async function replacedBy(ctx, { kind, nonce }) {
    const block = BigInt(await chain.pinBlock());
    if ((await chain.nonceAt(ctx.owner, hexBlock(block))) <= nonce) return false;
    confirmed(ctx, { blockNumber: block });
    store.clearOwnerPending(net.chainId, ctx.container);
    ctx.progress({ stage: kind, replaced: true });
    return true;
  }

  /** 上次留下的持有人交易：不重发，等它确认或确认它被替换了。返回是否处理了一笔 */
  async function settleOwnerPending(ctx) {
    const p = store.get(net.chainId, ctx.container)?.ownerPending;
    if (!p) return false;
    ctx.progress({ stage: p.kind, hash: p.hash });
    await awaitOwner(ctx, p);
    return true;
  }

  /**
   * 持有人发一笔交易并等确认。返回回执；如果先处理了一笔在途的持有人交易就不发，
   * 或者这笔在钱包里被加速 / 取消了，返回 null，调用方按链上状态重新判断这一步还要不要做。
   * 发之前钱包不能有未确认的交易：ownerSend 广播之后却没把哈希交回来（窗口被关、桥接断开）时，
   * 没有可记的在途记录，只能靠这个 nonce 检查拦住重复的开通、充值；它的确认要等节点交易池同步，不是完全没有空档
   */
  async function ownerTx(ctx, kind, tx) {
    if (await settleOwnerPending(ctx)) return null;
    ctx.checkAbort();
    const { latest, pending } = await chain.nonceOf(ctx.owner);
    if (pending > latest) throw new Error('钱包里还有一笔未确认的交易，请等它确认后再继续');
    const hash = await ownerSend(tx);
    // 拿到哈希先落盘，再去等确认：中途崩溃、超时，下次 run 都会等这一笔，不会再发一次
    // nonce 记发出前的 latest：之后被别的交易用掉，说明这笔被替换了
    store.setOwnerPending(net.chainId, ctx.container, { kind, hash, at: now(), nonce: latest });
    ctx.progress({ stage: kind, hash });
    return awaitOwner(ctx, { kind, hash, nonce: latest });
  }

  /** 按 minBlock 重新检查（不模拟），不是 ready 就停下 */
  async function reinspect(ctx) {
    const r = await inspect({ target: ctx.target, files: ctx.files, minBlock: ctx.minBlock, simulate: false });
    if (r.stage !== 'ready') {
      const why = r.stage === 'conflicts' ? r.conflicts.map((c) => c.path).join('、') : (r.errors || []).map((e) => e.text).join('；');
      throw new Error('链上状态变了，请重新检查：' + why);
    }
    return r;
  }

  /** 第 1 步：开通容器，确认后在回执区块上核对开通状态、容器地址、合约已部署，再重新检查 */
  async function openContainer(ctx, cur) {
    const { circuits, tokenId } = ctx.target;
    const r = await ownerTx(ctx, 'open', openTx(net, cur.owner, { circuits, tokenId }, cur.openFee));
    if (r === null) {
      // 先等完了一笔在途的持有人交易：重新看还要不要开通
      const next = await reinspect(ctx);
      return next.opened ? next : openContainer(ctx, next);
    }
    const block = hexBlock(ctx.minBlock);
    const [info] = await chain.circuitInfos([{ circuits, tokenId }], block);
    const deployed = await chain.isDeployed(circuits, tokenId, block);
    if (!info?.opened || lower(info.container) !== lower(cur.container) || !deployed) throw new Error('开通后核对失败');
    const next = await reinspect(ctx);
    if (!next.opened || lower(next.container) !== lower(cur.container)) throw new Error('开通后核对失败');
    return next;
  }

  /**
   * 第 2 步：取出或新建这个容器的临时钱包。
   * 电路换了持有人（OPERATOR_OWNER_MISMATCH）：先把旧临时钱包的余额退回旧持有人（只要临时钱包签名），
   * 全部退完、记录删掉以后再为新持有人新建；退不出来就保留旧记录报错
   */
  async function openOperator(ctx) {
    const create = () => store.create({ chainId: net.chainId, container: ctx.container, owner: ctx.owner });
    try { create(); } catch (e) {
      if (e?.code !== 'OPERATOR_OWNER_MISMATCH') throw e;
      const { dust } = await refundRecord(e.old, { previous: true });
      if (dust) throw new Error('旧持有人的临时钱包余额不够付退款手续费，已保留记录');
      if (store.get(net.chainId, ctx.container)) throw new Error('旧持有人的临时钱包还没退干净，请稍后再试');
      create();
    }
    return createOperator({ store, chain, net, container: ctx.container, owner: ctx.owner, sleep, now });
  }

  /**
   * 处理临时钱包上次留下的 pending。上次停在一笔上传上时，它确认了也算这次的上传；status 0 照常报错。
   * 回执没有 effectiveGasPrice 时按 pending 里记下的签名单价算花费
   */
  async function settleOperator(ctx, operator) {
    const pending = store.get(net.chainId, ctx.container)?.pending;
    const r = await operator.settle();
    if (!r) return;
    confirmed(ctx, r);
    charge(ctx, r, pending?.gasPrice);
    if (pending?.kind === 'upload') {
      if (r.status !== 1) throw new Error(`上传 ${pending.path} 第 ${pending.index} 块失败`);
      ctx.uploaded++;
    }
  }

  /**
   * 第 3 步：在 minBlock 上读授权，没有编辑权限或剩下不到 5 分钟就重新授权，
   * 确认后在回执区块上再读一次，必须已经生效。上传途中每次重新检查都会再跑一遍
   */
  async function ensureGrant(ctx, operator) {
    const state = await chain.operatorState(ctx.container, operator.address, hexBlock(ctx.minBlock));
    if (state.canEdit && state.until >= now() / 1000 + GRANT_MARGIN_SEC) return;
    const r = await ownerTx(ctx, 'grant', grantTx(net, ctx.owner, ctx.container, operator.address));
    if (r === null) return ensureGrant(ctx, operator);
    const after = await chain.operatorState(ctx.container, operator.address, hexBlock(BigInt(r.blockNumber)));
    if (!after.canEdit) throw new Error('授权没有生效');
  }

  /**
   * 第 4 步：充值。节点广播前检查「余额 ≥ gasLimit × gasPrice」，所以每笔上传前都要检查。
   * 余额钉在 minBlock 上读：落后的节点会读到充值之前的余额，再充一次。
   * 第一笔之前（first）按剩下的全部算；之后只在余额不够这一笔时才补。
   * 金额 = max(剩下各步 stepGas 之和 × gasPrice − 余额, 这一笔 gasLimit × gasPrice − 余额)：
   * 节点估出的 gas 比 stepGas 大时也一定能往前走。首页的块在剩下的 steps 里，总是算进去
   */
  async function ensureFunds(ctx, operator, { rest, gasLimit, gasPrice, first }) {
    const balance = await operator.balance(hexBlock(ctx.minBlock));
    if (!first && balance >= gasLimit * gasPrice) return;
    const amount = maxOf(sumOf(rest) * gasPrice, gasLimit * gasPrice) - balance;
    if (amount <= 0n) return;
    const r = await ownerTx(ctx, 'fund', fundTx(ctx.owner, operator.address, amount));
    // 先等完了一笔在途的持有人交易（可能就是上次的充值）：按新余额重新算
    if (r === null) return ensureFunds(ctx, operator, { rest, gasLimit, gasPrice, first: false });
  }

  /**
   * 一笔上传的 gasLimit：用临时钱包地址估算 × 1.25，不超过 MAX_UPLOAD_GAS。
   * 合约回滚可能是节点落后，隔一个 pollMs 重试 2 次仍回滚才报错；超时、限流之类的节点问题用这一步的 stepGas
   */
  async function uploadGasLimit(cur, operator, step, fallback) {
    const tx = { from: operator.address, ...uploadTx(net, cur.container, step) };
    for (let attempt = 0; ; attempt++) {
      try {
        const est = BigInt(await chain.estimateGas(tx));
        return minOf(est * PAD_NUM / PAD_DEN, MAX_UPLOAD_GAS);
      } catch (e) {
        if (!isRevert(e)) return fallback;
        if (attempt >= ESTIMATE_RETRIES) throw new Error(`上传 ${step.path} 第 ${step.index} 块模拟失败：${e?.message || e}`);
        await sleep(ESTIMATE_POLL_MS);
      }
    }
  }

  /**
   * 第 5 步：逐笔上传。每笔先读 gas 单价、估 gasLimit、检查余额，再由临时钱包签名发出并等确认。
   * 每传完一个文件、每 10 笔，按 minBlock 重新检查，用链上的最新状态继续（不信任本地进度），
   * 核对剩下的笔数确实减少了，并再检查一次授权（长时间的上传可能跨过授权到期）。返回最后一次检查的结果
   */
  async function uploadAll(ctx, cur, operator) {
    let first = true;
    let sinceCheck = 0;
    while (cur.steps.length) {
      const [step] = cur.steps;
      ctx.checkAbort();
      const gasPrice = await currentGasPrice();
      const gasLimit = await uploadGasLimit(cur, operator, step, cur.stepGas[0]);
      await ensureFunds(ctx, operator, { rest: cur.stepGas, gasLimit, gasPrice, first });
      first = false;
      ctx.checkAbort();

      const { path, index } = step;
      const hash = await operator.send({ ...uploadTx(net, cur.container, step), gas: gasLimit, gasPrice }, { kind: 'upload', path, index });
      // send 遇到 nonceUsed 时已经在内部确认并清掉了 pending，settle 返回 null；
      // 再查回执可能落在落后的节点上，轮询到确认为止，这一笔照样算进上传
      const r = (await operator.settle())
        ?? (await waitReceipt(hash, { timeoutMs: 120000, message: '交易还没确认，可以稍后继续' }));
      confirmed(ctx, r);
      charge(ctx, r, gasPrice);
      if (r.status !== 1) throw new Error(`上传 ${path} 第 ${index} 块失败`);
      ctx.uploaded++;
      const left = cur.steps.length - 1;
      ctx.progress({ stage: 'upload', done: ctx.uploaded, total: ctx.uploaded + left, path, index, hash });

      sinceCheck++;
      const fileDone = cur.steps[1]?.path !== path;
      if (fileDone || sinceCheck >= CHECK_EVERY) {
        const fresh = await reinspect(ctx);
        if (fresh.steps.length > left) throw new Error(`上传后核对失败：${path} 的块数没有增加`);
        cur = fresh;
        sinceCheck = 0;
        if (cur.steps.length) await ensureGrant(ctx, operator);
      } else {
        cur = { ...cur, steps: cur.steps.slice(1), stepGas: cur.stepGas.slice(1) };
      }
    }
    return cur;
  }

  // ---- 核验 → 退款 ----

  /**
   * X Layer 等 safe 区块覆盖到 block：返回 'ok'、'unsupported'（节点不支持 safe 标签）或 'timeout'。
   * block 可能是钉住的区块而不是回执区块（持有人交易被替换时 confirmed 记的是钉住的区块），
   * 它不早于所有已确认的交易，等 safe ≥ 它照样覆盖了最后一笔回执
   */
  async function waitSafe(block) {
    const deadline = now() + SAFE_TIMEOUT_MS;
    for (;;) {
      const safe = await chain.safeBlock();
      if (safe === null) return 'unsupported';
      if (safe >= block) return 'ok';
      if (now() >= deadline) return 'timeout';
      await sleep(SAFE_POLL_MS);
    }
  }

  // readVerified 内容对不上时的错误（长度或 SHA-256）；其余是节点问题，原样抛出
  const MISMATCH = /SHA-256|长度/;

  /** 一个文件在 block 上读回来和本地一致；不一致返回 false，节点问题抛出 */
  async function sameOnChain(ctx, f, info, block) {
    if (!info || info.sha256 !== f.sha256 || info.size !== f.bytes.length) return false;
    try {
      await chain.readVerified(ctx.container, f.path, info, block);
      return true;
    } catch (e) {
      if (MISMATCH.test(String(e?.message))) return false;
      throw e;
    }
  }

  /**
   * 第 6 步：快照里的每个文件在 minBlock 上读回来核对 sha256。
   * X Layer 先等 safe 区块覆盖最后一笔交易：超时不核验（verified false、reason 'safe'），节点不支持就跳过等待（safeSkipped）。
   * 返回 { verified, reason, safeSkipped, bad }；bad 是第一个对不上的路径
   */
  async function verifyAll(ctx) {
    let safeSkipped = false;
    if (net.key === 'xlayer') {
      const w = await waitSafe(ctx.lastBlock ?? ctx.minBlock);
      if (w === 'timeout') return { verified: false, reason: 'safe', safeSkipped, bad: null };
      safeSkipped = w === 'unsupported';
    }
    const block = hexBlock(ctx.minBlock);
    const infos = await chain.fileInfos(ctx.files.map((f) => ({ container: ctx.container, path: f.path })), block);
    for (const [i, f] of ctx.files.entries()) {
      ctx.progress({ stage: 'verify', done: i, total: ctx.files.length, path: f.path });
      if (!(await sameOnChain(ctx, f, infos[i], block))) return { verified: false, reason: 'mismatch', safeSkipped, bad: f.path };
    }
    return { verified: true, reason: null, safeSkipped, bad: null };
  }

  /**
   * 核验，然后不管核验结果如何都退款：内容对不上、节点出错都先把钱退回持有人，再抛出核验的错误。
   * 这时退款也出错的话，退款的错误放进核验错误的 cause（已有 cause 时只通过 progress 报告），不盖掉原来的错误
   */
  async function verifyThenRefund(ctx, operator) {
    let check = null;
    let failure = null;
    try {
      check = await verifyAll(ctx);
      if (check.bad) failure = new Error(`核验失败：${check.bad}`);
    } catch (e) { failure = e; }
    let result;
    try { result = await refundOperator(ctx, operator); } catch (re) {
      if (!failure) throw re;
      if (failure.cause === undefined) failure.cause = re;
      ctx.progress({ stage: 'refund', error: String(re?.message || re) });
    }
    if (failure) throw failure;
    return { check, ...result };
  }

  /** 退款的 gas：持有人是普通地址用 21000；是合约（有代码）用 estimateGas × 1.25，不超过 MAX_UPLOAD_GAS */
  async function refundGas(ctx, operator, balance, gasPrice) {
    const code = (await chain.hasCode([ctx.owner], hexBlock(ctx.minBlock))).get(lower(ctx.owner));
    if (code === undefined) throw new Error('读不到持有人地址的信息，请稍后再试');
    if (!code) return TRANSFER_GAS;
    // 估算用的金额：先按 21000 留出手续费，余额不够时用 1 试探
    const probe = balance > TRANSFER_GAS * gasPrice ? balance - TRANSFER_GAS * gasPrice : 1n;
    const est = BigInt(await chain.estimateGas({ from: operator.address, to: ctx.owner, value: probe, data: '0x' }));
    return minOf(est * PAD_NUM / PAD_DEN, MAX_UPLOAD_GAS);
  }

  /**
   * 算退款：gas、gasPrice，金额 = 余额 − gas × gasPrice × (100 + margin)%。
   * margin 是多留着不退的手续费百分比；gasPrice 不给就用当前单价
   */
  async function refundQuote(ctx, operator, balance, margin = 0n, price = null) {
    const gasPrice = price ?? await currentGasPrice();
    const gas = await refundGas(ctx, operator, balance, gasPrice);
    return { gas, gasPrice, amount: balance - gas * gasPrice * (100n + margin) / 100n };
  }

  /**
   * 余额为 0 时删除记录，但只在持有人没有在途交易的时候：一笔已经广播、还没记下或还看不到的充值，
   * 删掉记录以后到账就取不出来了。返回是否删了
   */
  /**
   * 重签用的单价：max(当前单价, 旧单价 × 1.125)，不超过 MAX_GAS_PRICE。
   * 封顶后不比旧单价高就没法替换，抛出（pending 保留）
   */
  async function bumpedPrice(old) {
    const want = maxOf(await currentGasPrice(), old * BUMP_NUM / BUMP_DEN);
    if (want <= MAX_GAS_PRICE) return want;
    if (MAX_GAS_PRICE > old) return MAX_GAS_PRICE;
    throw new Error('退款交易一直没有打包，Gas 单价已到上限');
  }

  async function removeIfEmpty(ctx, balance) {
    if (balance !== 0n || store.get(net.chainId, ctx.container)?.ownerPending) return false;
    const { latest, pending } = await chain.nonceOf(ctx.owner);
    if (pending > latest) return false;
    store.remove(net.chainId, ctx.container);
    return true;
  }

  /**
   * 等临时钱包的 pending 确认。是一笔退款、等超时了、nonce 也确实没被用掉（节点收下了却不打包：
   * 最低单价变了、X Layer 的 L1 数据费），就用压过旧单价的新单价重算金额、用同一个 nonce 重签再等，最多 MAX_RESIGNS 次。
   * 返回 { receipt, value }：value 是上链的那个版本的退款金额（重签后可能是旧版本上了链；不是退款时为 0n）；
   * 没有 pending 时 receipt 为 null
   */
  async function settleRefund(ctx, operator) {
    for (let resigns = 0; ; resigns++) {
      const p = store.get(net.chainId, ctx.container)?.pending;
      try {
        const receipt = await operator.settle();
        return { receipt, value: p?.kind === 'refund' ? receipt?.value ?? 0n : 0n };
      } catch (e) {
        const stuck = store.get(net.chainId, ctx.container)?.pending;
        if (e?.code !== 'PENDING_TIMEOUT' || stuck?.kind !== 'refund' || resigns >= MAX_RESIGNS) throw e;
        if ((await chain.nonceOf(operator.address)).latest > stuck.nonce) throw e;
        // 这笔没有上链：余额还是全部，按压过旧单价的新单价重算
        const balance = await operator.balance(hexBlock(ctx.minBlock));
        const price = await bumpedPrice(stuck.gasPrice);
        const q = await refundQuote(ctx, operator, balance, RESIGN_MARGIN[net.key] ?? 0n, price);
        if (q.amount <= 0n) throw new Error('退款交易一直没有打包，余额不够按现在的单价重发');
        const hash = await operator.resignRefund({ value: q.amount, gas: q.gas, gasPrice: q.gasPrice });
        ctx.progress({ stage: 'refund', hash, resigned: true });
      }
    }
  }

  /**
   * 第 7 步：临时钱包的余额减去 gas × gasPrice 转回 ctx.owner。不撤销授权（授权会自己到期）。
   * 先处理上次留下的 pending：是一笔崩溃前发出的退款，确认了就把它的金额算进 refunded，再看剩下的余额。
   * 余额在 minBlock 上读。可退金额 ≤ 0 时保留记录，返回 dust: true；回执 status 0 抛出「退款失败」并保留记录；
   * 确认后在回执区块上余额为 0、持有人也没有在途交易才删除记录。返回 { refunded, dust }
   */
  async function refundOperator(ctx, operator) {
    let refunded = 0n;
    const left = await settleRefund(ctx, operator);
    if (left.receipt) {
      confirmed(ctx, left.receipt);
      if (left.receipt.status === 1) refunded += left.value;
    }
    const balance = await operator.balance(hexBlock(ctx.minBlock));
    if (balance === 0n) {
      await removeIfEmpty(ctx, balance);
      return { refunded, dust: false };
    }
    const { gas, gasPrice, amount } = await refundQuote(ctx, operator, balance);
    if (amount <= 0n) return { refunded, dust: true };

    const sent = await operator.send({ ...refundTx(ctx.owner, amount), gas, gasPrice }, { kind: 'refund' });
    ctx.progress({ stage: 'refund', hash: sent });
    // send 遇到 nonceUsed 时已经确认并清掉了 pending，再按哈希等回执
    const { receipt, value } = await settleRefund(ctx, operator);
    const r = receipt ?? (await waitReceipt(sent, { timeoutMs: 120000, message: '退款交易还没确认，可以稍后再退' }));
    confirmed(ctx, r);
    if (r.status !== 1) throw new Error('退款失败');
    const after = await operator.balance(hexBlock(BigInt(r.blockNumber)));
    await removeIfEmpty(ctx, after);
    return { refunded: refunded + (receipt ? value : amount), dust: false };
  }

  /**
   * 按一条记录退款，退给记录里的持有人（电路可能已经转给别人了）。
   * 持有人钱包里还有未确认的交易就不退：可能是一笔已经广播、还没记下的充值，删掉记录以后到账就取不出来了。
   * 再等这个持有人记下的在途交易（它回执 status 0 不影响退款）；余额不早于 pinBlock 读，刚确认的充值也看得到。
   * previous 为 true 表示退给上一位持有人（电路换了持有人），提示要说清楚是谁的交易
   */
  async function refundRecord(rec, { previous = false } = {}) {
    const { latest, pending } = await chain.nonceOf(rec.owner);
    if (pending > latest) throw new Error('持有人钱包里还有一笔未确认的交易，等它确认后再退款');
    const pinned = BigInt(await chain.pinBlock());
    const ctx = {
      container: rec.container, owner: rec.owner, lastBlock: null, progress: () => {},
      minBlock: rec.minBlock != null && rec.minBlock > pinned ? rec.minBlock : pinned,
    };
    try { await settleOwnerPending(ctx); } catch (e) {
      // status 0 时记录已经清掉，可以接着退；超时之类还在等
      if (store.get(net.chainId, ctx.container)?.ownerPending) {
        throw previous ? new Error('上一位持有人的交易还没确认，可以稍后再试') : e;
      }
    }
    const operator = createOperator({ store, chain, net, container: rec.container, owner: rec.owner, sleep, now });
    return refundOperator(ctx, operator);
  }

  /** 放弃发布、只退钱：返回 { refunded, dust }。和 run 共用同一个容器锁 */
  async function refund({ chainId, container }) {
    if (chainId !== net.chainId) throw new Error('网络不一致');
    const unlock = lockContainer(chainId, container);
    try {
      const rec = store.get(chainId, container);
      if (!rec) throw new Error('没有这个容器的临时钱包');
      return await refundRecord(rec);
    } finally { unlock(); }
  }

  return { inspect, run, refund };
}
