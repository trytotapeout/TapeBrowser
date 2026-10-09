// 发布引擎：把本地文件夹发布到电路的链上容器。依赖全部注入，不依赖 Electron。
// createPublisher({ chain, net, ownerSend, store, readFiles, precheck, now, sleep })
//   chain      createChain 的实例：circuitInfos / fileInfos / openFee / gasPrice / estimateGas 等
//   ownerSend  持有人发交易（开通、授权、充值、撤销），阶段 3 接到桥接页
//   store      operator-store：临时钱包的私钥和进度
//   readFiles  读本地文件 → [{ path, bytes, sha256 }]
//   precheck   已绑定参数的预检查 → { items: [{ level, text }] }
// 流程分三步：
//   inspect  检查网络、预检查、电路状态、发布计划，估算费用；只读链，不发交易
//   run      开通 → 授权 → 充值 → 上传 → 核验（后续任务）
//   refund   把临时钱包剩下的余额退回持有人（后续任务）
// 金额、gas、gasPrice 一律是 bigint；错误信息是给用户看的中文。

import { createHash } from 'node:crypto';
import { PUBLISH_NETWORKS, MAX_GAS_PRICE, MAX_UPLOAD_GAS, MAX_FILE_BYTES } from './config.js';
import { planPublish, stepsOf, chunkOf } from './publish-plan.js';
import { uploadTx } from './publish-tx.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxOf = (a, b) => (a > b ? a : b);
const utf8Len = (s) => BigInt(Buffer.byteLength(String(s), 'utf8'));
const slots = (n) => (n + 31n) / 32n;
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
  const d = e?.data;
  return e?.code === 3 || /revert/i.test(String(e?.message || '')) || (d != null && d !== '' && d !== '0x');
}

const SHA = /^0x[0-9a-f]{64}$/;
const badPath = (p) => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\')
  || p.split('/').some((seg) => !seg || seg === '.' || seg === '..');

/** 本地文件再核对一遍（读文件那一层已经查过，这里防御一下）：路径不重复、合法，大小在范围内，sha256 和内容一致 */
function assertFiles(files) {
  const seen = new Set();
  for (const f of files) {
    const fail = () => { throw new Error(`本地文件异常：${f?.path}`); };
    if (badPath(f.path) || seen.has(f.path)) fail();
    seen.add(f.path);
    const n = f.bytes?.length;
    if (!(n > 0 && n <= MAX_FILE_BYTES)) fail();
    if (!SHA.test(String(f.sha256)) || f.sha256 !== '0x' + createHash('sha256').update(f.bytes).digest('hex')) fail();
  }
}

export function createPublisher({ chain, net, ownerSend, store, readFiles, precheck, now = Date.now, sleep = defaultSleep }) {
  /**
   * 估算上传的 gas：每笔先按上限算；已开通时用节点模拟第一笔 putFile 和第一笔 appendChunk，
   * 算出这类交易除字节以外的固定开销，套到同类型的每一笔，和上限取较大的；每笔再乘 1.25。
   * 模拟遇到合约回滚返回 { revert }，节点问题就只用上限。
   */
  async function estimateUpload({ owner, container, opened, steps, block }) {
    const gasPrice = await chain.gasPrice();
    if (gasPrice <= 0n) throw new Error('读不到有效的 Gas 单价，请稍后再试');
    if (gasPrice > MAX_GAS_PRICE) throw new Error('当前 Gas 单价太高，请稍后再试');
    const overhead = {};
    if (opened) {
      for (const [type, first] of [['put', steps.find((s) => s.index === 0)], ['append', steps.find((s) => s.index > 0)]]) {
        if (!first) continue;
        try {
          const est = BigInt(await chain.estimateGas({ from: owner, ...uploadTx(net, container, first) }, block));
          overhead[type] = est - bytePart(lenOf(first));
        } catch (e) {
          if (isRevert(e)) return { revert: String(e?.message || e) };
        }
      }
    }
    const stepGas = steps.map((s) => {
      const extra = overhead[s.index === 0 ? 'put' : 'append'];
      const gas = extra === undefined ? stepGasBound(s) : maxOf(stepGasBound(s), bytePart(lenOf(s)) + extra);
      return gas * PAD_NUM / PAD_DEN;
    });
    const uploadGas = stepGas.reduce((a, b) => a + b, 0n);
    return { gasPrice, stepGas, uploadGas, uploadCost: uploadGas * gasPrice };
  }

  /**
   * 发布前检查：返回 blocked / conflicts / ready 三种结果之一；网络不支持、电路不存在、本地文件异常、gas 单价不对直接抛出。
   * 传了 files（上一次 inspect 的快照）就跳过预检查和读文件，保证上传途中改了文件也不影响计划。
   * 同一次检查里的链上读取都钉在同一个区块。
   */
  async function inspect({ target, files }) {
    if (!PUBLISH_NETWORKS.includes(net.key)) throw new Error('这条链暂时不支持发布');

    if (!files) {
      const { items } = await precheck();
      const errors = items.filter((i) => i.level === 'error');
      if (errors.length) return { stage: 'blocked', errors };
      files = await readFiles();
    }
    assertFiles(files);

    const block = await chain.pinBlock();
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
    const est = await estimateUpload({ owner, container, opened, steps, block });
    if (est.revert) return { stage: 'blocked', errors: [{ level: 'error', text: '链上模拟上传失败：' + est.revert }] };
    const { gasPrice, stepGas, uploadGas, uploadCost } = est;
    return {
      stage: 'ready', target, files, block, owner, container, opened, openFee, plan, steps,
      gasPrice, stepGas, uploadGas, uploadCost, totalCost: uploadCost + openFee,
    };
  }

  return { inspect };
}
