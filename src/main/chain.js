// 只读链访问（从 TapeVault src/chain.js 精简而来）。所有请求都经由传入的 rpc(method, params)。

import { createHash } from 'node:crypto';
import { encodeCall, decodeResult, decodeAggregate3, hexToBytes } from './abi.js';
import { BSC, SEL, MULTICALL_BATCH, MAX_FILE_BYTES, READ_RANGE } from './config.js';

const lower = (a) => String(a).toLowerCase();

export function createChain(rpc, net = BSC) {
  async function pinBlock() {
    const n = BigInt(await rpc('eth_blockNumber', []));
    return '0x' + (n > 2n ? n - 2n : n).toString(16);
  }

  const call = (to, data, block = 'latest') => rpc('eth_call', [{ to, data }, block]);
  const view = async (to, data, types, block) => decodeResult(types, await call(to, data, block));

  /** 批量只读调用：calls = [{target, callData}]，返回 [{success, returnData}]，顺序与输入一致 */
  async function multicall(calls, block = 'latest', batch = MULTICALL_BATCH) {
    const out = [];
    for (let i = 0; i < calls.length; i += batch) {
      const chunk = calls.slice(i, i + batch).map((c) => ({ ...c, allowFailure: true }));
      out.push(...decodeAggregate3(await call(net.multicall3, encodeCall(SEL.aggregate3, ['call3[]'], [chunk]), block)));
    }
    return out;
  }

  function take(r, types) {
    if (!r.success || r.returnData === '0x') return null;
    try { return decodeResult(types, r.returnData); } catch { return null; }
  }

  /** 全部处理器（电路 NFT 合约）地址，下标即处理器编号 */
  async function cpuList(block) {
    const [n] = await view(net.factory, SEL.cpuCount, ['uint'], block);
    const calls = [];
    for (let i = 0; i < Number(n); i++) calls.push({ target: net.factory, callData: encodeCall(SEL.cpuAt, ['uint'], [i]) });
    return (await multicall(calls, block)).map((r) => take(r, ['address'])?.[0] ?? null);
  }

  /** 钱包在每个处理器上持有的电路数量；只返回 balance > 0 的 */
  async function holdings(wallet, cpus, block) {
    const data = encodeCall(SEL.balanceOf, ['address'], [lower(wallet)]);
    const res = await multicall(cpus.map((c) => ({ target: c, callData: data })), block);
    const out = [];
    res.forEach((r, cpu) => {
      const v = take(r, ['uint']);
      if (v && v[0] > 0n && cpus[cpu]) out.push({ cpu, circuits: cpus[cpu], balance: Number(v[0]) });
    });
    return out;
  }

  async function maxTokenId(circuits, block) {
    const [n] = await view(circuits, SEL.nextId, ['uint'], block);
    return Number(n);
  }

  /** 每个处理器的 nextId（最后一个已铸造的编号，含）；处理器地址为空或调用失败时为 0 */
  async function nextIds(cpus, block) {
    const idx = [];
    cpus.forEach((c, i) => { if (c) idx.push(i); });
    const res = await multicall(idx.map((i) => ({ target: cpus[i], callData: SEL.nextId })), block);
    const out = cpus.map(() => 0);
    res.forEach((r, k) => { out[idx[k]] = Number(take(r, ['uint'])?.[0] ?? 0); });
    return out;
  }

  /**
   * 批量查容器是否开通：pairs = [{circuits, tokenId}] → bool[]。
   * 跨处理器打包成每批 MULTICALL_BATCH 个调用；每批之后调用 onBatch(done, total)（可返回 Promise，用来限速）
   */
  async function openedFlags(pairs, block, onBatch) {
    const out = [];
    for (let i = 0; i < pairs.length; i += MULTICALL_BATCH) {
      const chunk = pairs.slice(i, i + MULTICALL_BATCH).map(({ circuits, tokenId }) => ({
        target: net.opener,
        callData: encodeCall(SEL.isOpened, ['address', 'uint'], [circuits, tokenId]),
      }));
      for (const r of await multicall(chunk, block)) out.push(Boolean(take(r, ['bool'])?.[0]));
      await onBatch?.(out.length, pairs.length);
    }
    return out;
  }

  /** 在 [from, to] 编号区间里找出 wallet 持有的电路编号；找够 want 个就提前结束 */
  async function ownedIds(circuits, wallet, from, to, want, block, onProgress) {
    const me = lower(wallet);
    const found = [];
    const step = MULTICALL_BATCH * 4;
    for (let start = from; start <= to && found.length < want; start += step) {
      const end = Math.min(to, start + step - 1);
      const calls = [];
      for (let id = start; id <= end; id++) calls.push({ target: circuits, callData: encodeCall(SEL.ownerOf, ['uint'], [id]) });
      (await multicall(calls, block)).forEach((r, i) => {
        if (take(r, ['address'])?.[0] === me) found.push(start + i);
      });
      onProgress?.(end - from + 1, to - from + 1);
    }
    return found;
  }

  /** 批量读电路状态：items = [{circuits, tokenId}] → [{exists, owner, container, opened}] */
  async function circuitInfos(items, block) {
    const calls = [];
    for (const { circuits, tokenId } of items) {
      calls.push(
        { target: circuits, callData: encodeCall(SEL.ownerOf, ['uint'], [tokenId]) },
        { target: net.opener, callData: encodeCall(SEL.accountOf, ['address', 'uint'], [circuits, tokenId]) },
        { target: net.opener, callData: encodeCall(SEL.isOpened, ['address', 'uint'], [circuits, tokenId]) },
      );
    }
    const res = await multicall(calls, block);
    return items.map((_, i) => {
      const owner = take(res[i * 3], ['address']);
      const container = take(res[i * 3 + 1], ['address']);
      const opened = take(res[i * 3 + 2], ['bool']);
      return { exists: Boolean(owner), owner: owner?.[0] ?? null, container: container?.[0] ?? null, opened: Boolean(opened?.[0]) };
    });
  }

  function decodeFileInfo(v) {
    if (!v || v[4] === 0n) return null;
    return { size: Number(v[0]), contentType: v[1], sha256: v[2], updatedAt: Number(v[3]), chunkCount: Number(v[4]) };
  }

  /** 批量读文件元数据：pairs = [{container, path}] → [info|null]，顺序与输入一致 */
  async function fileInfos(pairs, block) {
    const res = await multicall(pairs.map(({ container, path }) => ({
      target: net.registry,
      callData: encodeCall(SEL.fileInfo, ['address', 'string'], [container, path]),
    })), block);
    return res.map((r) => decodeFileInfo(take(r, ['uint', 'string', 'bytes32', 'uint', 'uint'])));
  }

  /**
   * 交叉校验：让两个不同的节点各自读一遍「电路 → 容器」和「容器 + 路径 → 文件信息」。
   * 返回 [{node, container, opened, sha256}]；节点池不支持或节点不够时返回的少于 2 个
   */
  async function crossRead(circuits, tokenId, container, path) {
    if (typeof rpc.distinct !== 'function') return [];
    const calls = [
      { target: net.opener, callData: encodeCall(SEL.accountOf, ['address', 'uint'], [circuits, tokenId]), allowFailure: true },
      { target: net.opener, callData: encodeCall(SEL.isOpened, ['address', 'uint'], [circuits, tokenId]), allowFailure: true },
      { target: net.registry, callData: encodeCall(SEL.fileInfo, ['address', 'string'], [container, path]), allowFailure: true },
    ];
    const data = encodeCall(SEL.aggregate3, ['call3[]'], [calls]);
    const res = await rpc.distinct('eth_call', [{ to: net.multicall3, data }, 'latest'], 2);
    return res.map(({ url, result }) => {
      const r = decodeAggregate3(result);
      const file = decodeFileInfo(take(r[2], ['uint', 'string', 'bytes32', 'uint', 'uint']));
      let node = url;
      try { node = new URL(url).host; } catch { /* 保留原样 */ }
      return { node, container: take(r[0], ['address'])?.[0] ?? null, opened: Boolean(take(r[1], ['bool'])?.[0]), sha256: file?.sha256 ?? null };
    });
  }

  /**
   * 代币的符号和精度（确认弹窗解读授权数额用）：{symbol, decimals}。
   * decimals 读不到时为 null（NFT 合约没有精度）；合约不存在或都读不到返回 null。symbol 兼容返回 bytes32 的老合约
   */
  async function tokenInfo(token) {
    const res = await multicall([
      { target: token, callData: '0x95d89b41' }, // symbol()
      { target: token, callData: '0x313ce567' }, // decimals()
    ]);
    let symbol = take(res[0], ['string'])?.[0] ?? null;
    if (symbol === null) {
      const b32 = take(res[0], ['bytes32'])?.[0];
      if (b32) symbol = Buffer.from(b32.slice(2), 'hex').toString('utf8').replace(/\0+$/, '') || null;
    }
    const d = take(res[1], ['uint'])?.[0];
    const decimals = d !== undefined && d <= 77n ? Number(d) : null;
    if (symbol === null && decimals === null) return null;
    // 符号来自合约自己，限制长度和字符，避免伪装成别的文字
    if (symbol) symbol = symbol.replace(/[^\w.$+-]/g, '').slice(0, 16) || null;
    return { symbol, decimals };
  }

  /**
   * Uniswap / PancakeSwap V3 池的当前价格：每 1 个 token 值多少 quote（浮点数）。
   * 读 slot0 的 sqrtPriceX96 和 token0，按两边精度换算
   */
  async function v3Price(pool, token, tokenDecimals, quoteDecimals, block = 'latest') {
    const res = await multicall([{ target: pool, callData: '0x3850c7bd' }, { target: pool, callData: '0x0dfe1681' }], block);
    const sp = take(res[0], ['uint'])?.[0];
    const t0 = take(res[1], ['address'])?.[0];
    if (!sp || !t0) throw new Error('读不到池子价格');
    const raw = (Number(sp) / 2 ** 96) ** 2; // token1 最小单位 / token0 最小单位
    const perToken = t0 === lower(token) ? raw : 1 / raw;
    return perToken * 10 ** (tokenDecimals - quoteDecimals);
  }

  /** 原生币余额（BNB / OKB / ETH，最小单位，BigInt） */
  async function nativeBalance(owner, block = 'latest') {
    return BigInt(await rpc('eth_getBalance', [lower(owner), block]));
  }

  /** 代币余额（最小单位，BigInt） */
  async function tokenBalance(token, owner, block = 'latest') {
    const [v] = await view(token, encodeCall(SEL.balanceOf, ['address'], [lower(owner)]), ['uint'], block);
    return v;
  }

  async function fileInfo(container, path, block) {
    return (await fileInfos([{ container, path }], block))[0];
  }

  async function readRange(container, path, offset, len, block) {
    const data = encodeCall(SEL.readRange, ['address', 'string', 'uint', 'uint'], [container, path, offset, len]);
    const [hex] = await view(net.registry, data, ['bytes'], block);
    return hexToBytes(hex);
  }

  /** 读取整个文件并核对长度与 SHA-256（SPEC §5 第 4 条）；分段并发读取 */
  async function readVerified(container, path, info, block = 'latest', concurrency = 4) {
    if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 8.4 MB，拒绝读取');
    const out = new Uint8Array(info.size);
    const offsets = [];
    for (let off = 0; off < info.size; off += READ_RANGE) offsets.push(off);
    let next = 0;
    async function worker() {
      while (next < offsets.length) {
        const off = offsets[next++];
        const want = Math.min(READ_RANGE, info.size - off);
        const part = await readRange(container, path, off, READ_RANGE, block);
        if (part.length !== want) throw new Error('读取长度异常');
        out.set(part, off);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, worker));
    const digest = '0x' + createHash('sha256').update(out).digest('hex');
    if (digest !== info.sha256) throw new Error('SHA-256 校验失败：文件可能还在上传中，或已损坏');
    return out;
  }

  return { pinBlock, crossRead, tokenInfo, tokenBalance, nativeBalance, v3Price, multicall, cpuList, holdings, maxTokenId, nextIds, openedFlags, ownedIds, circuitInfos, fileInfos, fileInfo, readRange, readVerified };
}
