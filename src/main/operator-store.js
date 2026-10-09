// 临时钱包（上传操作员）存储：<dir>/<chainId>-<容器地址小写>.json，每个（链, 容器）一个文件，权限 0600。
// 不依赖 Electron：私钥的加解密由调用方注入（阶段 3 接 safeStorage）。
//   encrypt(私钥 hex 字符串) → Buffer | Uint8Array；decrypt(Buffer) → 私钥 hex 字符串
// 文件内容：{ v: 1, chainId, container, owner, address, key, pending, lastNonce, createdAt }
//   chainId    正整数
//   container  容器合约地址（小写）
//   owner      持有人地址（小写），一个容器只能有一个持有人的临时钱包
//   address    临时钱包地址（小写），keyOf 时用它核对解出来的私钥，发现文件被改过
//   key        encrypt(私钥 hex) 的 base64；明文私钥不落盘、不出现在返回值和错误信息里
//   pending    null，或最后一笔已发出、还没确认的交易
//              { raw, hash, kind: 'upload' | 'refund', path?, index?, nonce }，nonce 存十进制字符串
//              已有 pending 时 setPending 拒绝，要先 clearPending
//   lastNonce  最后一笔已确认交易的 nonce（十进制字符串，没有时为 null），只能往大改：
//              防止公共节点落后、读到旧 nonce 后重发
//   createdAt  创建时间（毫秒）
// get / list / create 返回的记录不含 key，并且 lastNonce 是 bigint | null、pending.nonce 是 bigint。
// 这个文件关系到临时钱包里的钱，写盘要落实：先删掉残留的 .tmp，新建 .tmp（0600）写入并 fsync，
// 再 rename，最后尽量 fsync 目录。每次读都直接读文件，不缓存。
// 读不出来或结构不对的文件不会被当成「没有记录」：get 抛出，list 跳过，broken() 列出文件名。

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { newKey, addressOf } from './eth-tx.js';
import { bytesToHex, hexToBytes } from './abi.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const FILE = /^([1-9][0-9]*)-(0x[0-9a-f]{40})\.json$/;
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
  return out;
}

/** 落盘记录 → 返回给调用方的形式（去掉 key，nonce 转 bigint） */
function publicView(rec) {
  const { key: _key, ...r } = rec;
  r.lastNonce = rec.lastNonce == null ? null : BigInt(rec.lastNonce);
  r.pending = rec.pending ? { ...rec.pending, nonce: BigInt(rec.pending.nonce) } : null;
  return r;
}

/** 粗略检查文件结构，list 用它跳过坏文件 */
function looksValid(rec) {
  return !!rec && typeof rec === 'object' && rec.v === 1 && Number.isSafeInteger(rec.chainId)
    && typeof rec.container === 'string' && typeof rec.owner === 'string'
    && typeof rec.address === 'string' && typeof rec.key === 'string'
    && (rec.lastNonce == null || /^[0-9]+$/.test(rec.lastNonce))
    && (rec.pending == null || (typeof rec.pending === 'object' && /^[0-9]+$/.test(rec.pending.nonce)));
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
    if (!looksValid(rec)) throw new Error('临时钱包：记录文件已损坏');
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
    if (!rec) throw new Error('临时钱包不存在');
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
          const err = new Error('这个容器已有另一个持有人的临时钱包，请先把它的余额退回原持有人');
          err.code = 'OPERATOR_OWNER_MISMATCH';
          err.old = publicView(old);
          throw err;
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
          key, pending: null, lastNonce: null, createdAt: now(),
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
      if (!rec) throw new Error('临时钱包不存在');
      let sk;
      try {
        sk = hexToBytes(decrypt(Buffer.from(rec.key, 'base64')));
        if (sk.length !== 32 || addressOf(sk) !== rec.address) throw 0;
      } catch {
        if (sk) sk.fill(0);
        // 不带底层错误：里面可能有密文或私钥的片段
        throw new Error(DECRYPT_FAILED);
      }
      return sk;
    },

    setPending(chainId, container, pending) {
      const p = pendingToDisk(pending);
      update(chainId, container, (rec) => {
        // 一次只能有一笔未确认的交易：覆盖掉旧的会丢掉它的 raw，没法再重发或确认
        if (rec.pending != null) throw new Error('临时钱包还有一笔交易在等确认');
        // 不比已确认的 nonce 大：节点落后读到了旧 nonce，签出来的交易会冲掉已确认的
        if (rec.lastNonce != null && BigInt(p.nonce) <= BigInt(rec.lastNonce)) {
          throw new Error('交易的 nonce 不比已确认的大，节点可能落后');
        }
        rec.pending = p;
      });
    },

    clearPending(chainId, container) {
      update(chainId, container, (rec) => { rec.pending = null; });
    },

    /** 只能往大改：比现有值小或相等时忽略 */
    setLastNonce(chainId, container, nonce) {
      const n = nonceOf(nonce);
      update(chainId, container, (rec) => {
        if (rec.lastNonce != null && n <= BigInt(rec.lastNonce)) return false;
        rec.lastNonce = n.toString();
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
