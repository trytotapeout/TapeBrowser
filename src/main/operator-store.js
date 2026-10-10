// 临时钱包（上传操作员）存储：<dir>/<chainId>-<容器地址小写>.json，每个（链, 容器）一个文件，权限 0600。
// 不依赖 Electron：私钥的加解密由调用方注入（阶段 3 接 safeStorage）。
//   encrypt(私钥 hex 字符串) → Buffer | Uint8Array；decrypt(Buffer) → 私钥 hex 字符串
// 文件内容：{ v: 1, chainId, container, owner, address, key, pending, ownerPending, lastNonce, minBlock, createdAt }
//   chainId    正整数
//   container  容器合约地址（小写）
//   owner      持有人地址（小写），一个容器只能有一个持有人的临时钱包
//   address    临时钱包地址（小写），keyOf 时用它核对解出来的私钥，发现文件被改过
//   key        encrypt(私钥 hex) 的 base64；明文私钥不落盘、不出现在返回值和错误信息里
//   pending    null，或最后一笔已发出、还没确认的交易
//              { raw, hash, kind: 'upload' | 'refund', path?, index?, nonce, gasPrice?, value? }，nonce、gasPrice、value 存十进制字符串
//              （gasPrice 是签名用的单价，回执没有 effectiveGasPrice 时按它算花费；旧记录没有）
//              （value 是退款的金额：崩溃后再确认时照样能报出退了多少）
//              已有 pending 时 setPending 拒绝，要先 clearPending；
//              只有退款可以用 replacePending 换成同一个 nonce 的另一笔退款（重签，见 operator.resignRefund）；
//              被替换的版本记在 prior: [{ hash, value }]（旧的在前，最多 PRIOR_MAX 个，value 存十进制字符串）：
//              它们也可能上链，确认时要一起查
//   ownerPending  null，或持有人已经发出、还没确认的一笔交易 { kind: 'open' | 'grant' | 'fund', hash, at, nonce }
//              下次发布先等它确认，不会再发一次（重复交开通费、重复充值）；旧记录没有这个字段，按 null 处理
//              nonce 是这笔交易的 nonce（十进制字符串；节点查不到时退回发出前读到的持有人 latest）：
//              它被别的交易用掉，说明这笔在钱包里被加速或取消了。
//              早期记录没有 nonce，读出来是 null，只能等回执
//   lastNonce  最后一笔已确认交易的 nonce（十进制字符串，没有时为 null），只能往大改：
//              防止公共节点落后、读到旧 nonce 后重发
//   minBlock   这个容器最近一笔已确认交易（开通、授权、充值、上传）的区块号（十进制字符串，没有时为 null），只能往大改：
//              下次发布的读取不早于它，落后的节点不会让已开通的容器看起来没开通
//   createdAt  创建时间（毫秒）
// get / list / create 返回的记录不含 key，并且 lastNonce、minBlock 是 bigint | null、pending.nonce / pending.gasPrice 是 bigint。
// 这个文件关系到临时钱包里的钱，写盘要落实：先删掉残留的 .tmp，新建 .tmp（0600）写入并 fsync，
// 再 rename，最后尽量 fsync 目录。每次读都直接读文件，不缓存。
// 读不出来或结构不对的文件不会被当成「没有记录」：get 抛出，list 跳过，broken() 列出文件名。
// 界面要区分的错误带 code（见 publish-errors.js）：DECRYPT、RECORD_BROKEN、NO_OPERATOR、OPERATOR_OWNER_MISMATCH 等；参数校验的错误不带。

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { newKey, addressOf } from './eth-tx.js';
import { bytesToHex, hexToBytes } from './abi.js';
import { fail, DECRYPT, RECORD_BROKEN, NO_OPERATOR, OPERATOR_OWNER_MISMATCH, LATER } from './publish-errors.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const FILE = /^([1-9][0-9]*)-(0x[0-9a-f]{40})\.json$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const OWNER_KINDS = ['open', 'grant', 'fund'];
const PRIOR_MAX = 3;
const DECRYPT_FAILED = '临时钱包无法解密（系统钥匙串可能已重置）';

function chainOf(chainId) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('临时钱包：链 ID 不正确');
  return chainId;
}

function addrOf(a, what) {
  if (typeof a !== 'string' || !ADDR.test(a)) throw new Error(`临时钱包：${what}地址不正确`);
  return a.toLowerCase();
}

/** bigint / 安全非负整数 → bigint，其余抛出 */
function nonceOf(n) {
  if (typeof n === 'bigint' && n >= 0n) return n;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) return BigInt(n);
  throw new Error('临时钱包：nonce 不正确');
}

/** 校验 pending 并转成落盘形式（nonce 十进制字符串） */
function pendingToDisk(p) {
  if (!p || typeof p !== 'object') throw new Error('临时钱包：待确认交易不正确');
  if (typeof p.raw !== 'string' || typeof p.hash !== 'string') throw new Error('临时钱包：待确认交易不正确');
  if (p.kind !== 'upload' && p.kind !== 'refund') throw new Error('临时钱包：待确认交易类型不正确');
  const out = { raw: p.raw, hash: p.hash, kind: p.kind };
  if (p.path !== undefined) out.path = String(p.path);
  if (p.index !== undefined) {
    if (!Number.isSafeInteger(p.index) || p.index < 0) throw new Error('临时钱包：待确认交易序号不正确');
    out.index = p.index;
  }
  out.nonce = nonceOf(p.nonce).toString();
  if (p.gasPrice !== undefined) {
    if (typeof p.gasPrice !== 'bigint' || p.gasPrice < 0n) throw new Error('临时钱包：待确认交易的 Gas 单价不正确');
    out.gasPrice = p.gasPrice.toString();
  }
  if (p.value !== undefined) {
    if (typeof p.value !== 'bigint' || p.value < 0n) throw new Error('临时钱包：待确认交易的金额不正确');
    out.value = p.value.toString();
  }
  return out;
}

/** 校验持有人的待确认交易并转成落盘形式 */
function ownerPendingToDisk(p) {
  if (!p || typeof p !== 'object' || !OWNER_KINDS.includes(p.kind)) throw new Error('临时钱包：持有人的待确认交易不正确');
  if (typeof p.hash !== 'string' || !HASH.test(p.hash)) throw new Error('临时钱包：持有人的交易哈希不正确');
  if (!Number.isSafeInteger(p.at) || p.at < 0) throw new Error('临时钱包：持有人的交易时间不正确');
  if (typeof p.nonce !== 'bigint' || p.nonce < 0n) throw new Error('临时钱包：持有人的交易 nonce 不正确');
  return { kind: p.kind, hash: p.hash.toLowerCase(), at: p.at, nonce: p.nonce.toString() };
}

const ownerPendingOk = (p) => p == null || (typeof p === 'object' && OWNER_KINDS.includes(p.kind)
  && typeof p.hash === 'string' && HASH.test(p.hash) && Number.isSafeInteger(p.at)
  && (p.nonce == null || (typeof p.nonce === 'string' && /^[0-9]+$/.test(p.nonce))));

/** 落盘记录 → 返回给调用方的形式（去掉 key，nonce 转 bigint） */
function publicView(rec) {
  const { key: _key, ...r } = rec;
  r.lastNonce = rec.lastNonce == null ? null : BigInt(rec.lastNonce);
  r.minBlock = rec.minBlock == null ? null : BigInt(rec.minBlock);
  r.pending = null;
  if (rec.pending) {
    r.pending = { ...rec.pending, nonce: BigInt(rec.pending.nonce) };
    if (rec.pending.gasPrice != null) r.pending.gasPrice = BigInt(rec.pending.gasPrice);
    if (rec.pending.value != null) r.pending.value = BigInt(rec.pending.value);
    if (rec.pending.prior) r.pending.prior = rec.pending.prior.map((x) => ({ hash: x.hash, value: BigInt(x.value) }));
  }
  r.ownerPending = rec.ownerPending
    ? { ...rec.ownerPending, nonce: rec.ownerPending.nonce == null ? null : BigInt(rec.ownerPending.nonce) }
    : null;
  return r;
}

/** 粗略检查文件结构，list 用它跳过坏文件 */
function looksValid(rec) {
  return !!rec && typeof rec === 'object' && rec.v === 1 && Number.isSafeInteger(rec.chainId)
    && typeof rec.container === 'string' && typeof rec.owner === 'string'
    && typeof rec.address === 'string' && typeof rec.key === 'string'
    && (rec.lastNonce == null || /^[0-9]+$/.test(rec.lastNonce))
    && (rec.minBlock == null || /^[0-9]+$/.test(rec.minBlock))
    && (rec.pending == null || (typeof rec.pending === 'object' && /^[0-9]+$/.test(rec.pending.nonce)
      && (rec.pending.gasPrice == null || /^[0-9]+$/.test(rec.pending.gasPrice))
      && (rec.pending.value == null || /^[0-9]+$/.test(rec.pending.value))
      && (rec.pending.prior == null || (Array.isArray(rec.pending.prior)
        && rec.pending.prior.every((x) => typeof x?.hash === 'string' && /^[0-9]+$/.test(x.value))))))
    && ownerPendingOk(rec.ownerPending);
}

export function createOperatorStore({ dir, encrypt, decrypt, now = Date.now }) {
  const fileOf = (chainId, container) => join(dir, `${chainOf(chainId)}-${addrOf(container, '容器')}.json`);

  /** 读落盘记录；没有文件返回 null */
  function read(file) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    let rec;
    try { rec = JSON.parse(text); } catch { rec = null; }
    // 不带解析器的错误：里面可能有文件内容
    if (!looksValid(rec)) throw fail(RECORD_BROKEN, '临时钱包：记录文件已损坏');
    return rec;
  }

  function write(file, rec) {
    mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    // 残留的 .tmp 可能权限更宽，openSync 的 mode 只在新建时生效，所以先删掉
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(rec, null, 2));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, file);
    // 让 rename 本身也落盘；Windows 等平台不支持对目录 fsync，忽略错误
    try {
      const d = openSync(dir, 'r');
      try { fsyncSync(d); } finally { closeSync(d); }
    } catch { /* 尽力而为 */ }
  }

  /** 目录里符合文件名格式的文件；目录不存在时为空 */
  function names() {
    try { return readdirSync(dir).filter((n) => FILE.test(n)); } catch { return []; }
  }

  /** 读出记录、修改、写回；没有记录时抛出 */
  function update(chainId, container, fn) {
    const file = fileOf(chainId, container);
    const rec = read(file);
    if (!rec) throw fail(NO_OPERATOR, '临时钱包不存在');
    if (fn(rec) === false) return;
    write(file, rec);
  }

  return {
    create({ chainId, container, owner }) {
      const file = fileOf(chainId, container);
      const o = addrOf(owner, '持有人');
      const old = read(file);
      if (old) {
        if (old.owner !== o) {
          // 带上旧记录（不含私钥），让调用方能先把余额退回原持有人
          throw fail(OPERATOR_OWNER_MISMATCH, '这个容器已有另一个持有人的临时钱包，请先把它的余额退回原持有人', { old: publicView(old) });
        }
        return publicView(old);
      }
      const sk = newKey();
      let rec;
      try {
        // 交给 encrypt 的 hex 字符串没法清零（safeStorage 只收字符串）
        // encrypt 抛错（钥匙串不可用）时原样抛出，此时还没写盘
        const key = Buffer.from(encrypt(bytesToHex(sk))).toString('base64');
        rec = {
          v: 1, chainId, container: container.toLowerCase(), owner: o, address: addressOf(sk),
          key, pending: null, ownerPending: null, lastNonce: null, minBlock: null, createdAt: now(),
        };
      } finally { sk.fill(0); }
      write(file, rec);
      return publicView(rec);
    },

    get(chainId, container) {
      const rec = read(fileOf(chainId, container));
      return rec ? publicView(rec) : null;
    },

    /** 解密后的私钥，只给签名入口用 */
    keyOf(chainId, container) {
      const rec = read(fileOf(chainId, container));
      if (!rec) throw fail(NO_OPERATOR, '临时钱包不存在');
      let sk;
      try {
        sk = hexToBytes(decrypt(Buffer.from(rec.key, 'base64')));
        if (sk.length !== 32 || addressOf(sk) !== rec.address) throw 0;
      } catch {
        if (sk) sk.fill(0);
        // 不带底层错误：里面可能有密文或私钥的片段
        throw fail(DECRYPT, DECRYPT_FAILED);
      }
      return sk;
    },

    /** 私钥能不能解出来（解密并核对地址，用完清零）：启动时找残留用，解不开意味着钱找不回来。不抛错 */
    canDecrypt(chainId, container) {
      try {
        this.keyOf(chainId, container).fill(0);
        return true;
      } catch { return false; }
    },

    setPending(chainId, container, pending) {
      const p = pendingToDisk(pending);
      update(chainId, container, (rec) => {
        // 一次只能有一笔未确认的交易：覆盖掉旧的会丢掉它的 raw，没法再重发或确认
        if (rec.pending != null) throw new Error('临时钱包还有一笔交易在等确认');
        // 不比已确认的 nonce 大：节点落后读到了旧 nonce，签出来的交易会冲掉已确认的
        if (rec.lastNonce != null && BigInt(p.nonce) <= BigInt(rec.lastNonce)) {
          throw fail(LATER, '交易的 nonce 不比已确认的大，节点可能落后');
        }
        rec.pending = p;
      });
    },

    /**
     * 用同一个 nonce 的另一笔退款替换在等确认的退款（一次写盘，不会出现没有 pending 的空档）。
     * 每个版本都转给同一个持有人、只有一笔能上链，所以替换是安全的；上传不能替换
     */
    replacePending(chainId, container, pending) {
      const p = pendingToDisk(pending);
      update(chainId, container, (rec) => {
        const cur = rec.pending;
        if (!cur || cur.kind !== 'refund' || p.kind !== 'refund' || cur.nonce !== p.nonce) {
          throw new Error('临时钱包：只能用同一个 nonce 的退款替换退款');
        }
        // prior 只由这里维护：在原来的 prior 后面接上被替换的这一笔，只留最近的几个
        const prior = [...(cur.prior ?? []), { hash: cur.hash, value: cur.value ?? '0' }].slice(-PRIOR_MAX);
        rec.pending = { ...p, prior };
      });
    },

    clearPending(chainId, container) {
      update(chainId, container, (rec) => { rec.pending = null; });
    },

    /** 记下持有人刚发出的交易；已有一笔时拒绝（覆盖掉就不知道它有没有上链了） */
    setOwnerPending(chainId, container, pending) {
      const p = ownerPendingToDisk(pending);
      update(chainId, container, (rec) => {
        if (rec.ownerPending != null) throw new Error('持有人还有一笔交易在等确认');
        rec.ownerPending = p;
      });
    },

    /**
     * 持有人那笔在途交易查到了真正的 nonce：只在 ownerPending 就是这个哈希时改它的 nonce（先按发出前的 latest 落盘，见 publisher.ownerTx）
     */
    updateOwnerPendingNonce(chainId, container, hash, nonce) {
      if (typeof nonce !== 'bigint' || nonce < 0n) throw new Error('临时钱包：持有人的交易 nonce 不正确');
      const h = String(hash).toLowerCase();
      update(chainId, container, (rec) => {
        if (rec.ownerPending?.hash !== h) throw new Error('临时钱包：持有人没有这笔在等确认的交易');
        rec.ownerPending = { ...rec.ownerPending, nonce: nonce.toString() };
      });
    },

    clearOwnerPending(chainId, container) {
      update(chainId, container, (rec) => { rec.ownerPending = null; });
    },

    /** 只能往大改：比现有值小或相等时忽略 */
    setLastNonce(chainId, container, nonce) {
      const n = nonceOf(nonce);
      update(chainId, container, (rec) => {
        if (rec.lastNonce != null && n <= BigInt(rec.lastNonce)) return false;
        rec.lastNonce = n.toString();
      });
    },

    /** 只能往大改：比现有值小或相等时不写盘 */
    setMinBlock(chainId, container, block) {
      if (typeof block !== 'bigint' || block < 0n) throw new Error('临时钱包：区块号不正确');
      update(chainId, container, (rec) => {
        if (rec.minBlock != null && block <= BigInt(rec.minBlock)) return false;
        rec.minBlock = block.toString();
      });
    },

    remove(chainId, container) {
      rmSync(fileOf(chainId, container), { force: true });
    },

    /** 全部记录（不含私钥），启动时找残留用；坏文件跳过 */
    list() {
      const out = [];
      for (const name of names()) {
        try {
          const rec = read(join(dir, name));
          if (rec) out.push(publicView(rec));
        } catch { /* 坏文件跳过 */ }
      }
      return out;
    },

    /** 读不出来或结构不对的记录文件名，给界面提示用 */
    broken() {
      return names().filter((name) => {
        try { read(join(dir, name)); return false; } catch { return true; }
      });
    },
  };
}
