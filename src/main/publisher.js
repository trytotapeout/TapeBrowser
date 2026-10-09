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

import { PUBLISH_NETWORKS, MAX_GAS_PRICE, MAX_UPLOAD_GAS } from './config.js';
import { planPublish, stepsOf, chunkOf } from './publish-plan.js';
import { uploadTx } from './publish-tx.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxOf = (a, b) => (a > b ? a : b);

/** 一块的 gas 上限：基础 21000 + calldata 每字节 16 + 存储每字节 200 + 合约逻辑 100000，不超过 MAX_UPLOAD_GAS */
function chunkGasBound(len) {
  const n = BigInt(len);
  const gas = 21000n + n * 16n + n * 200n + 100000n;
  return gas > MAX_UPLOAD_GAS ? MAX_UPLOAD_GAS : gas;
}

// ownerSend / store / now / sleep 给 run、refund 用，inspect 不用
export function createPublisher({ chain, net, ownerSend, store, readFiles, precheck, now = Date.now, sleep = defaultSleep }) {
  /** 估算上传的 gas：每块按上限算；已开通时第一笔再用节点估一次，取较大的；总数乘 1.2 */
  async function estimateUpload({ owner, container, opened, steps }) {
    const gasPrice = await chain.gasPrice();
    if (gasPrice <= 0n || gasPrice > MAX_GAS_PRICE) throw new Error('当前 Gas 单价太高，请稍后再试');
    const each = steps.map((s) => chunkGasBound(chunkOf(s.row.bytes, s.index).length));
    if (opened && steps.length) {
      try {
        const est = await chain.estimateGas({ from: owner, ...uploadTx(net, container, steps[0]) });
        each[0] = maxOf(each[0], BigInt(est));
      } catch {
        // 节点估不了（持有人还不是编辑者、回滚等）就只用上限
      }
    }
    const uploadGas = each.reduce((a, b) => a + b, 0n) * 12n / 10n;
    return { gasPrice, uploadGas, uploadCost: uploadGas * gasPrice };
  }

  /** 发布前检查：返回 blocked / conflicts / ready 三种结果之一；网络不支持、电路不存在、gas 太贵直接抛出 */
  async function inspect({ target }) {
    if (!PUBLISH_NETWORKS.includes(net.key)) throw new Error('这条链暂时不支持发布');

    const { items } = await precheck();
    const errors = items.filter((i) => i.level === 'error');
    if (errors.length) return { stage: 'blocked', errors };

    const files = await readFiles();
    const [info] = await chain.circuitInfos([{ circuits: target.circuits, tokenId: target.tokenId }]);
    if (!info || !info.exists) throw new Error('这个电路不存在');
    const { owner, container, opened } = info;

    // 没开通的容器里没有文件
    let openFee = 0n;
    let infos;
    if (opened) infos = await chain.fileInfos(files.map((f) => ({ container, path: f.path })));
    else {
      openFee = await chain.openFee();
      infos = files.map(() => null);
    }

    const plan = planPublish(files, infos);
    if (plan.conflicts.length) return { stage: 'conflicts', conflicts: plan.conflicts, plan };

    const steps = stepsOf(plan);
    const { gasPrice, uploadGas, uploadCost } = await estimateUpload({ owner, container, opened, steps });
    return {
      stage: 'ready', target, owner, container, opened, openFee, plan, steps,
      gasPrice, uploadGas, uploadCost, totalCost: uploadCost + openFee,
    };
  }

  return { inspect };
}
