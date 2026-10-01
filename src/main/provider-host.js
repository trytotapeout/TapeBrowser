// 网页里 window.ethereum 的请求在主进程这里处理（EIP-1193）。不依赖 Electron。
//
//   只读请求      链是 BSC 时走内置节点池（快、不打扰钱包）；钱包切到别的链时转给钱包
//   连接          eth_requestAccounts：没连上桥接页面就打开它，等用户选好钱包；
//                 网站第一次要地址时由 TapeBrowser 弹窗确认（钱包扩展只看得到 127.0.0.1，看不到真正的网站）
//   签名 / 交易    已授权的网站才能发；先由 TapeBrowser 弹窗说明是哪个网站，再交给钱包扩展确认
//
// deps:
//   bridge        createBridgeServer() 的返回值
//   rpc           内置节点池 rpc(method, params)
//   settings      createSettings() 的返回值
//   openBridge()  在系统浏览器里打开桥接页面
//   confirm({kind, origin, method, params}) → Promise<{ok, remember}>
//   emit(origin|null, event, payload)  向网页派发事件；origin 为 null 表示所有网页

import { BSC } from './config.js';

const READ_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_syncing',
  'web3_clientVersion',
]);

const SIGN_METHODS = new Set([
  'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_sendTransaction',
]);

const WALLET_METHODS = new Set(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset']);

const CONNECT_TIMEOUT = 3 * 60 * 1000;

export const providerError = (code, message, data) => ({ code, message, ...(data === undefined ? {} : { data }) });

export function createProviderHost({ bridge, rpc, settings, openBridge, confirm, emit }) {
  let readyWait = null;
  // 本次运行里用户勾选了"不再询问"的网站：签名与交易直接交给钱包确认
  const trusted = new Set();

  const chainId = () => bridge.state.chainId || BSC.chainIdHex;
  const accountsFor = (origin) => (settings.isPermitted(origin) && bridge.state.ready ? bridge.state.accounts.slice(0, 1) : []);

  async function ensureBridge() {
    if (bridge.state.ready) return;
    if (!readyWait) {
      if (!bridge.state.connected) openBridge();
      readyWait = bridge.waitReady(CONNECT_TIMEOUT).finally(() => { readyWait = null; });
    }
    await readyWait;
  }

  async function connect(origin) {
    await ensureBridge();
    let accounts = bridge.state.accounts;
    if (!accounts.length) accounts = (await bridge.request('eth_requestAccounts', [], origin)) || [];
    if (!accounts.length) throw providerError(4001, '钱包没有返回地址');
    const account = String(accounts[0]).toLowerCase();
    if (!settings.isPermitted(origin)) {
      const r = await confirm({ kind: 'connect', origin, account });
      if (!r.ok) throw providerError(4001, '用户拒绝连接');
      settings.permit(origin);
    }
    // 桥接页面的 state 消息可能比请求结果晚到，这里直接用钱包返回的地址
    return [account];
  }

  async function handle(origin, method, params = []) {
    if (typeof method !== 'string') throw providerError(-32600, 'method 必须是字符串');
    if (!Array.isArray(params) && params !== undefined && (typeof params !== 'object' || params === null)) throw providerError(-32602, 'params 不合法');

    switch (method) {
      case 'eth_chainId': return chainId();
      case 'net_version': return String(parseInt(chainId(), 16));
      case 'eth_accounts': return accountsFor(origin);
      case 'eth_coinbase': return accountsFor(origin)[0] ?? null;
      case 'eth_requestAccounts': return connect(origin);
      case 'wallet_requestPermissions': {
        await connect(origin);
        return [{ parentCapability: 'eth_accounts', invoker: origin }];
      }
      case 'wallet_getPermissions':
        return settings.isPermitted(origin) ? [{ parentCapability: 'eth_accounts', invoker: origin }] : [];
      case 'wallet_revokePermissions':
        settings.revoke(origin);
        trusted.delete(origin);
        emit(origin, 'accountsChanged', []);
        return null;
      case 'eth_subscribe':
      case 'eth_unsubscribe':
        throw providerError(4200, '不支持订阅，请改用轮询');
      default: break;
    }

    if (READ_METHODS.has(method)) {
      if (chainId() === BSC.chainIdHex || !bridge.state.ready) {
        try { return await rpc(method, params); } catch (e) { throw providerError(e.code ?? -32603, e.message, e.data); }
      }
      return bridge.request(method, params, origin);
    }

    if (SIGN_METHODS.has(method) || WALLET_METHODS.has(method)) {
      if (!settings.isPermitted(origin) || !bridge.state.ready) throw providerError(4100, '网站还没有连接钱包，请先调用 eth_requestAccounts');
      if (SIGN_METHODS.has(method)) {
        const from = signerOf(method, params);
        if (from && !bridge.state.accounts.includes(from)) throw providerError(4100, '签名地址不是当前连接的钱包地址');
        if (!trusted.has(origin)) {
          const r = await confirm({ kind: 'sign', origin, method, params });
          if (!r.ok) throw providerError(4001, '用户拒绝请求');
          if (r.remember) trusted.add(origin);
        }
      }
      return bridge.request(method, params, origin);
    }

    // 其他方法：已授权网站直接转给钱包，由钱包决定是否支持
    if (settings.isPermitted(origin) && bridge.state.ready) return bridge.request(method, params, origin);
    throw providerError(4200, `不支持的方法 ${method}`);
  }

  /** 从签名请求里取出签名地址（小写），取不到返回 null */
  function signerOf(method, params) {
    const p = Array.isArray(params) ? params : [];
    let a = null;
    if (method === 'personal_sign') a = p[1];
    else if (method === 'eth_sign' || method.startsWith('eth_signTypedData')) a = p[0];
    else if (method === 'eth_sendTransaction') a = p[0]?.from;
    // eth_signTypedData（v1）参数顺序是 [data, address]
    if (method === 'eth_signTypedData' && !/^0x[0-9a-fA-F]{40}$/.test(String(a))) a = p[1];
    return /^0x[0-9a-fA-F]{40}$/.test(String(a)) ? String(a).toLowerCase() : null;
  }

  // 钱包状态变化 → 网页事件
  bridge.on('state', (s, prev) => {
    const now = s.ready ? s.accounts.slice(0, 1) : [];
    const before = prev.ready ? prev.accounts.slice(0, 1) : [];
    if (now.join() !== before.join()) {
      for (const origin of settings.permittedOrigins()) emit(origin, 'accountsChanged', now);
    }
    const c1 = s.chainId || BSC.chainIdHex;
    const c0 = prev.chainId || BSC.chainIdHex;
    if (c1 !== c0) emit(null, 'chainChanged', c1);
  });

  return {
    handle,
    /** 网页加载时取初始状态 */
    initial: (origin) => ({ chainId: chainId(), accounts: accountsFor(origin) }),
    revoke(origin) {
      settings.revoke(origin);
      trusted.delete(origin);
      emit(origin, 'accountsChanged', []);
    },
  };
}
