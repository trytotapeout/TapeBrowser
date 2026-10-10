// 发布服务：主进程里发布到容器的编排，main.js 只把真实依赖传进来、把这里的方法接到 IPC。不依赖 Electron。
// createPublishService({ chains, sites, localSites, precheck, bridge, secure, dir, networks, origin, now, sleep, onEvent, tr })
//   chains      { bnb: chain, xlayer: chain }，createChain 的实例
//   sites       createSites 的实例：cpus(area)、circuitsOf(netKey, wallet, onProgress)
//   localSites  createLocalSites 的实例：roots()、list(root)、bytesOf(root, path)
//   precheck    precheck.js 的 precheck
//   bridge      bridge-server 的实例（state、request），给 owner-send 用
//   secure      { available(), backend, encrypt(str) → Buffer, decrypt(Buffer) → str }，main.js 接 safeStorage
//   dir         临时钱包记录的根目录，每条链一个子目录 dir/<netKey>
//   onEvent     onEvent('publish', { id, ... }) 发布进度；onEvent('publishScan', { netKey, ... }) 扫电路的进度
// 对外的方法就是 IPC 能调用的全部（阶段 3 契约第 3 条）：
//   available / targets / inspect / run / pause / refund / discardDust / leftovers
// 参数全部来自渲染进程，当成不可信的：每个方法先核对参数，再确认 secure 可用。
// inspect 的结果只留在这里（sessions），渲染进程只拿脱敏摘要和 id；返回值、事件里的 bigint 一律转十进制字符串。
// 错误原样抛出（带 code），由 main.js 的 IPC 层转成 { code, message }；参数不对的错误不带 code。

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PUBLISH_NETWORKS, networkByKey } from './config.js';
import { siteLabel } from './address.js';
import { createPublisher } from './publisher.js';
import { createOperatorStore } from './operator-store.js';
import { createOwnerSend } from './owner-send.js';
import * as E from './publish-errors.js';

const { fail } = E;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
// 同时只保留最近这么多次检查的结果
const MAX_SESSIONS = 5;
const INDEX = 'index.html';

/** 参数校验失败：不带 code，界面照原样显示 */
const badArg = (name) => new Error(`参数不对：${name}`);
const uint = (v, name) => {
  if (!Number.isSafeInteger(v) || v < 0) throw badArg(name);
  return v;
};
const address = (v, name) => {
  if (typeof v !== 'string' || !ADDR.test(v)) throw badArg(name);
  return v;
};
/** 参数对象：渲染进程可能传 undefined、字符串之类 */
const argsOf = (a) => (a && typeof a === 'object' && !Array.isArray(a) ? a : {});

/** 转成能过 IPC、能 JSON 序列化的值：bigint → 十进制字符串，递归处理数组和普通对象 */
function plain(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}
const str = (v) => (v === undefined || v === null ? null : v.toString());

/** inspect 的结果 → 给渲染进程的摘要：只有可序列化的字段，没有文件内容、sha256、计划步骤和 store 记录 */
function summaryOf(id, netKey, label, r) {
  const rows = r.plan?.rows ?? [];
  const counts = { create: 0, append: 0, replace: 0, reuse: 0 };
  for (const row of rows) counts[row.action]++;
  const index = rows.find((row) => row.path === INDEX && row.action === 'replace');
  return {
    id,
    stage: r.stage,
    label,
    netKey,
    container: r.container ?? null,
    opened: r.opened ?? null,
    openFee: str(r.openFee),
    gasPrice: str(r.gasPrice),
    uploadCost: str(r.uploadCost),
    totalCost: str(r.totalCost),
    counts,
    transactions: r.plan?.transactions ?? 0,
    uploadBytes: r.plan?.uploadBytes ?? 0,
    files: rows.map((row) => ({ path: row.path, size: row.bytes.length, action: row.action })),
    errors: (r.errors ?? []).map((e) => ({ level: String(e.level), text: String(e.text) })),
    conflicts: (r.conflicts ?? []).map((c) => ({ path: c.path, reason: c.reason })),
    indexChunks: index ? index.chunks : null,
  };
}

export function createPublishService({
  chains, sites, localSites, precheck, bridge, secure, dir,
  networks = PUBLISH_NETWORKS, origin = 'tape://publish', now, sleep, onEvent, tr,
}) {
  const emit = (name, data) => onEvent?.(name, data);
  // netKey → { net, store, publisher }：每条链一组，懒创建，整个服务只有这一组（契约第 6 条）
  const bundles = new Map();
  // id → { netKey, bundle, inspected }：inspect 的原件只留在主进程（契约第 2 条）
  const sessions = new Map();
  // 正在跑的 run：{ id, controller }。服务级别同时只有一个
  let current = null;
  // 正在进行的 inspect：同一时间只有一个（读整个文件夹、估 gas，不让渲染进程并发刷）
  let inspecting = false;

  function available() {
    if (!secure?.available?.()) return { ok: false, reason: 'no-encryption' };
    if (secure.backend === 'basic_text') return { ok: false, reason: 'basic-text' };
    return { ok: true };
  }
  /** 不能安全保存临时钱包就拒绝，不退回明文（契约第 5 条） */
  function requireSecure() {
    if (!available().ok) throw fail(E.NO_ENCRYPTION, '这台电脑无法安全保存临时钱包，暂时不能发布');
  }

  function netOf(netKey) {
    const ok = typeof netKey === 'string' && networks.includes(netKey) && PUBLISH_NETWORKS.includes(netKey) && Object.hasOwn(chains, netKey);
    const net = ok ? networkByKey(netKey) : null;
    if (!net) throw fail(E.CHAIN_UNSUPPORTED, '这条链暂时不支持发布');
    return net;
  }

  function bundleOf(net) {
    let b = bundles.get(net.key);
    if (b) return b;
    const store = createOperatorStore({
      dir: join(dir, net.key),
      // 每次加密前再确认一次：钥匙串在运行中变得不可用也不会写出明文
      encrypt: (s) => { requireSecure(); return secure.encrypt(s); },
      decrypt: (buf) => secure.decrypt(buf),
      ...(now ? { now } : {}),
    });
    const ownerSend = createOwnerSend({
      bridge, net, origin,
      onStep: ({ kind }) => { if (current) emit('publish', { id: current.id, stage: 'wallet', kind }); },
      ...(sleep ? { sleep } : {}),
    });
    // readFiles / precheck 每次 inspect 按当次的文件夹传入；这里的只是兜底，不应被调用
    const never = async () => { throw new Error('发布服务没有传入本地文件'); };
    const publisher = createPublisher({
      chain: chains[net.key], net, ownerSend, store, readFiles: never, precheck: never,
      ...(now ? { now } : {}), ...(sleep ? { sleep } : {}),
    });
    b = { net, store, publisher };
    bundles.set(net.key, b);
    return b;
  }

  /** root 必须和 localSites 登记过的真实路径完全一样：不接受子文件夹、..、末尾斜杠之类的变体 */
  function rootOf(root) {
    if (typeof root !== 'string' || !localSites.roots().some(([, r]) => r === root)) {
      throw new Error('这个文件夹没有在本地预览里打开过');
    }
    return root;
  }

  /** 电路合约地址：sites.cpus(area)[cpu]；处理器不存在抛 CIRCUIT_MISSING */
  async function circuitsOf(net, cpu) {
    const list = await sites.cpus(net.area);
    const circuits = Array.isArray(list) ? list[cpu] : null;
    if (typeof circuits !== 'string' || !ADDR.test(circuits)) throw fail(E.CIRCUIT_MISSING, '这个电路不存在');
    return circuits;
  }

  /** 钱包当前账户；没连接抛 WALLET_NOT_CONNECTED */
  function account() {
    const a = bridge.state?.ready ? bridge.state.accounts?.[0] : null;
    if (typeof a !== 'string' || !ADDR.test(a)) throw fail(E.WALLET_NOT_CONNECTED, '请先连接钱包');
    return a;
  }

  /** 当前钱包在这条链上的全部电路（发布页选电路用） */
  async function targets(args) {
    const { netKey } = argsOf(args);
    const net = netOf(netKey);
    requireSecure();
    const wallet = account();
    return plain(await sites.circuitsOf(net.key, wallet, (p) => emit('publishScan', plain({ netKey: net.key, ...p }))));
  }

  /**
   * 检查一次发布：target 在这里按 root 和电路编号构造，文件从 localSites 读（契约第 2、3 条）。
   * 能发布（ready）时把原件存进 sessions，摘要里带 id；blocked / conflicts 不存，id 为 null
   */
  async function inspect(args) {
    const a = argsOf(args);
    const net = netOf(a.netKey);
    const tokenId = uint(a.tokenId, 'tokenId');
    const cpu = uint(a.cpu, 'cpu');
    requireSecure();
    const root = rootOf(a.root);
    if (inspecting) throw fail(E.BUSY, '正在检查另一次发布');
    // 同步占住：第二个并发调用在上面就被拒绝
    inspecting = true;
    try {
      return await inspectInner(net, tokenId, cpu, root);
    } finally { inspecting = false; }
  }

  async function inspectInner(net, tokenId, cpu, root) {
    const circuits = await circuitsOf(net, cpu);
    const label = siteLabel(tokenId, cpu, net.area);
    const target = { circuits, tokenId, cpu, label };

    // 列一次文件，预检查和读文件都用这份清单：两步之间多出来的文件不会被传上去
    const listing = await localSites.list(root);
    const readFiles = async () => {
      const out = [];
      for (const { path } of listing.files) {
        const bytes = await localSites.bytesOf(root, path);
        if (!bytes) throw fail(E.LOCAL_FILES, `本地文件异常：${path}`);
        out.push({ path, bytes, sha256: '0x' + createHash('sha256').update(bytes).digest('hex') });
      }
      return out;
    };
    const check = () => precheck({ ...listing, read: (p) => localSites.bytesOf(root, p), ...(tr ? { tr } : {}) });

    const bundle = bundleOf(net);
    const r = await bundle.publisher.inspect({ target, readFiles, precheck: check });
    let id = null;
    if (r.stage === 'ready') {
      id = randomUUID();
      sessions.set(id, { netKey: net.key, inspected: r });
      // 只留最近的几次：Map 按插入顺序，最早的在前
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    return summaryOf(id, net.key, label, r);
  }

  /**
   * 按 id 取出主进程里的原件发布（契约第 2 条）；渲染进程传来的其他字段一概不看。
   * 同一时间只能有一个 run，第二个抛 BUSY。返回 publisher.run 的结果（bigint 转字符串），
   * done 之后这个 id 作废；paused 或出错时保留，同一个 id 可以再 run 接着传
   */
  async function run(args) {
    const { id } = argsOf(args);
    if (typeof id !== 'string') throw badArg('id');
    requireSecure();
    const s = sessions.get(id);
    if (!s) throw fail(E.NOT_READY, '还没有检查通过，不能发布');
    if (current) throw fail(E.BUSY, '正在发布另一个网站');
    const controller = new AbortController();
    // 同步占住：第二个并发调用在上面就被拒绝
    current = { id, controller };
    try {
      const { publisher } = bundleOf(netOf(s.netKey));
      const r = await publisher.run(s.inspected, {
        signal: controller.signal,
        onProgress: (p) => emit('publish', plain({ ...p, id })),
      });
      if (r.stage === 'done') sessions.delete(id);
      return plain(r);
    } finally { current = null; }
  }

  /** 让正在跑的这次 run 在下两笔交易之间停下；不是这个 id 在跑返回 false */
  function pause(args) {
    const { id } = argsOf(args);
    if (typeof id !== 'string') throw badArg('id');
    requireSecure();
    if (current?.id !== id) return false;
    current.controller.abort();
    return true;
  }

  /** refund / discardDust 的公共部分：核对参数，交给这条链的 publisher */
  async function forward(args, method) {
    const a = argsOf(args);
    const net = netOf(a.netKey);
    const container = address(a.container, 'container');
    requireSecure();
    return plain(await bundleOf(net).publisher[method]({ chainId: net.chainId, container }));
  }
  const refund = (args) => forward(args, 'refund');
  const discardDust = (args) => forward(args, 'discardDust');

  /**
   * 启动时找残留（契约第 4 条）：每条发布链的记录和坏文件，返回 { records, broken, errors }。
   * 余额为 0、没有在途交易的记录交给 publisher.cleanupIfEmpty 删（容器锁、持有人 nonce 检查、1 小时宽限期都在那里），
   * 服务自己不删记录；没删掉的照样列出，cleanup 是原因（busy / pending / recent …），删掉的不列。
   * 有余额、pending 或 ownerPending 的列出来，界面提示「继续发布」或「退款」；decryptable 为 false 表示私钥解不开，钱找不回来。
   * 余额不早于记录的 minBlock 读（latest 落后时刚确认的充值也看得到），每条链只钉一次区块。
   * 一条链出错不影响别的链，错误放在 errors 里
   */
  async function leftovers() {
    if (!available().ok) return { unavailable: true };
    const records = [];
    const broken = [];
    const errors = [];
    for (const key of networks) {
      if (!PUBLISH_NETWORKS.includes(key) || !Object.hasOwn(chains, key)) continue;
      try {
        const { net, store, publisher } = bundleOf(netOf(key));
        for (const file of store.broken()) broken.push({ netKey: key, file });
        const list = store.list();
        if (!list.length) continue;
        const pinned = BigInt(await chains[key].pinBlock());
        for (const rec of list) {
          const block = rec.minBlock != null && rec.minBlock > pinned ? rec.minBlock : pinned;
          const balance = await chains[key].nativeBalance(rec.address, '0x' + block.toString(16));
          const pending = Boolean(rec.pending);
          const ownerPending = Boolean(rec.ownerPending);
          let cleanup = null;
          if (balance === 0n && !pending && !ownerPending) {
            const c = await publisher.cleanupIfEmpty({ chainId: net.chainId, container: rec.container });
            if (c.removed) continue;
            cleanup = c.reason;
          }
          records.push({
            netKey: key, container: rec.container, owner: rec.owner, address: rec.address,
            balance: balance.toString(), pending, ownerPending,
            decryptable: store.canDecrypt(net.chainId, rec.container), cleanup,
          });
        }
      } catch (e) {
        errors.push({ netKey: key, code: e?.code ?? null, message: String(e?.message || e) });
      }
    }
    return { records, broken, errors };
  }

  return { available, targets, inspect, run, pause, refund, discardDust, leftovers };
}
