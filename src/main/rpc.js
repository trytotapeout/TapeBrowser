// 公共节点池：JSON-RPC 请求按顺序轮换节点，遇到限流（429）、网络错误、节点内部错误时换下一个重试。
// 合约 revert 之类的业务错误（JSON-RPC error 带 code 3 / -32000 且有 data）原样抛出，不重试。
// rpc.distinct：同一个请求发给几个不同的节点，用于交叉校验。

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** 节点返回的 error 是否值得换节点重试（限流、节点过载、区块还没同步到） */
function retryableRpcError(e) {
  const msg = String(e?.message || '').toLowerCase();
  if (e?.code === -32005 || e?.code === -32603) return true;
  return /limit|too many|rate|timeout|header not found|unknown block|busy|capacity/.test(msg);
}

export function createRpcPool(getUrls, { fetchImpl = globalThis.fetch, timeoutMs = 15000, rounds = 2 } = {}) {
  let cursor = 0;
  let seq = 0;

  async function once(url, body) {
    const ctrl = new AbortController();
    let timer;
    // 同时用 race 兜底：不是每种 fetch 实现都支持 signal
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(Object.assign(new Error('RPC timeout'), { name: 'AbortError' })); }, timeoutMs);
    });
    try {
      const r = await Promise.race([timeout, fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      })]);
      if (!r.ok) return { retry: RETRYABLE_HTTP.has(r.status) || r.status >= 500, error: new RpcError(`HTTP ${r.status}`, -32603) };
      const j = await r.json();
      if (j.error) {
        const err = new RpcError(j.error.message || 'RPC error', j.error.code, j.error.data);
        return { retry: retryableRpcError(j.error), error: err };
      }
      return { result: j.result };
    } catch (e) {
      return { retry: true, error: new RpcError(e.name === 'AbortError' ? 'RPC timeout' : String(e.message || e), -32603) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** rpc(method, params)：返回 result，失败抛 RpcError */
  async function rpc(method, params = []) {
    const urls = getUrls();
    if (!urls.length) throw new RpcError('没有可用的 RPC 节点', -32603);
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params });
    let last;
    for (let attempt = 0; attempt < urls.length * rounds; attempt++) {
      const url = urls[cursor % urls.length];
      const r = await once(url, body);
      if (!r.error) return r.result;
      last = r.error;
      if (!r.retry) throw r.error;
      cursor++;
      // 第二轮开始稍微退避，避免把所有节点同时打到限流
      if (attempt >= urls.length - 1) await new Promise((res) => setTimeout(res, 300 * (attempt - urls.length + 2)));
    }
    throw last;
  }

  /**
   * 交叉校验用：同一个请求分别发给 n 个不同的节点，返回 [{url, result}]（成功的节点，最多 n 个）。
   * 节点不够或都失败时返回的少于 n 个，由调用方判断；业务错误（revert）直接抛出
   */
  rpc.distinct = async function distinct(method, params = [], n = 2) {
    const urls = getUrls();
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params });
    const out = [];
    // 从主节点的下一个开始，尽量避开显示网页用的那个节点
    const start = cursor + 1;
    for (let k = 0; k < urls.length && out.length < n; k++) {
      const url = urls[(start + k) % urls.length];
      const r = await once(url, body);
      if (!r.error) out.push({ url, result: r.result });
      else if (!r.retry) throw r.error;
    }
    return out;
  };

  return rpc;
}
