// 签名 / 交易请求的风险解读：把常见的高危操作翻成一句人话，供 TapeBrowser 的确认弹窗用。不依赖 Electron。
//
// 只能识别标准操作（ERC-20 / ERC-721 / ERC-1155 授权和转账、Permit、Permit2、Seaport 挂单），
// 网站调用自己写的合约时只能提示「无法解读」。代币名称和精度直接从链上读，不调用第三方接口。
//
// analyzeRequest(method, params, { net, tokenInfo, tr }) → {level, title, lines, raw}
//   level   danger  高危：可能让对方拿走资产（无限授权、授权全部 NFT、离线签名授权、盲签）
//           warn    需要留意：转出资产、有限额授权、调用无法解读的合约
//           info    普通：签消息、取消授权等
//   net     钱包当前所在的链（config.js 里的网络），不认识的链为 null
//   tokenInfo(address) → Promise<{symbol, decimals} | null>，读不到时返回 null
//   tr      界面文字翻译（见 i18n/i18n.cjs），默认原样输出中文

import { decodeResult, hexToBytes } from './abi.js';

// 大于这个数就当成无限额（有些合约用 2^255、2^160 之类的值）
const HUGE = 1n << 128n;

const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(v, k) ? String(v[k]) : all)) : s);
const short = (s, n = 600) => (s.length > n ? s.slice(0, n) + '…' : s);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));
const big = (v) => { try { return BigInt(v ?? 0); } catch { return null; } };

function hexToText(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const bytes = Buffer.from(hex.slice(2), 'hex');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // 有不可打印字符就当二进制显示
  return /[\u0000-\u0008\u000e-\u001f�]/.test(text) ? null : text;
}

/** 按精度格式化数额：1500000 + 6 → 1.5（小数最多 8 位） */
export function formatUnits(v, decimals = 18) {
  const n = big(v);
  if (n === null) return '?';
  const d = BigInt(decimals);
  const base = 10n ** d;
  const frac = (n % base).toString().padStart(Number(d), '0').slice(0, 8).replace(/0+$/, '');
  return frac ? `${n / base}.${frac}` : String(n / base);
}

// 常见的函数选择器
const SEL = {
  approve: '0x095ea7b3', // approve(address,uint256)：ERC-20 授权额度；ERC-721 授权单个 NFT
  increaseAllowance: '0x39509351', // increaseAllowance(address,uint256)
  setApprovalForAll: '0xa22cb465', // setApprovalForAll(address,bool)
  transfer: '0xa9059cbb', // transfer(address,uint256)
  transferFrom: '0x23b872dd', // transferFrom(address,address,uint256)
  safeTransferFrom: '0x42842e0e', // safeTransferFrom(address,address,uint256)
  safeTransferFromData: '0xb88d4fde', // safeTransferFrom(address,address,uint256,bytes)
  safeTransferFrom1155: '0xf242432a', // safeTransferFrom(address,address,uint256,uint256,bytes)
  permit2Approve: '0x87517c45', // Permit2.approve(address token,address spender,uint160,uint48)
};

/** 解码调用数据里选择器之后的静态参数 */
function args(data, types) {
  try { return decodeResult(types, hexToBytes(data.slice(10))); } catch { return null; }
}

export function createAnalyzer({ tokenInfo = null, tr = fill } = {}) {

  /** 代币数额：读得到精度就按精度显示，读不到就显示原始数 */
  async function amount(token, v) {
    const t = tokenInfo && isAddr(token) ? await tokenInfo(token).catch(() => null) : null;
    if (!t || t.decimals === null || t.decimals === undefined) return { text: tr('{v}（代币合约 {token}）', { v: String(v), token }), known: false };
    return { text: `${formatUnits(v, t.decimals)} ${t.symbol || ''}`.trim(), known: true, symbol: t.symbol };
  }

  /** 交易：识别授权和转账，其他合约调用提示无法解读 */
  async function analyzeTx(tx, net) {
    const to = isAddr(tx.to) ? String(tx.to).toLowerCase() : null;
    const data = typeof tx.data === 'string' && /^0x[0-9a-fA-F]*$/.test(tx.data) ? tx.data : '0x';
    const value = big(tx.value) ?? 0n;
    const coin = net?.currency || tr('原生币');
    const lines = [];
    if (value > 0n && data.length >= 10) lines.push(tr('同时转出 {amount} {coin}', { amount: formatUnits(value), coin }));
    const raw = data !== '0x' ? tr('调用数据：{data}（{bytes} 字节）', { data: short(data, 138), bytes: (data.length - 2) / 2 }) : null;
    const out = (level, title, more = []) => ({ level, title, lines: [...lines, ...more], raw });

    if (!tx.to) return out('warn', tr('部署新合约'), [tr('这笔交易会创建一个新的智能合约。')]);
    if (!to) return out('danger', tr('收款地址不合法'), [String(tx.to)]);
    if (data.length < 10) {
      return out(value > 0n ? 'warn' : 'info', tr('转出 {amount} {coin}', { amount: formatUnits(value), coin }), [tr('收款地址：{to}', { to })]);
    }

    const sel = data.slice(0, 10).toLowerCase();
    if (sel === SEL.approve || sel === SEL.increaseAllowance) {
      const a = args(data, ['address', 'uint']);
      if (a) {
        const [spender, v] = a;
        const t = tokenInfo ? await tokenInfo(to).catch(() => null) : null;
        // ERC-721 的 approve(address,uint256) 第二个参数是 NFT 编号：没有精度的合约按 NFT 处理
        if (sel === SEL.approve && (!t || t.decimals === null || t.decimals === undefined)) {
          return out('warn', tr('授权 NFT #{id}', { id: String(v) }), [
            tr('允许 {spender} 转走你在合约 {to} 里的 NFT #{id}。', { spender, to, id: String(v) }),
            tr('只在你确实要卖出或使用这个 NFT 时才授权。'),
          ]);
        }
        const name = t?.symbol || tr('这种代币');
        if (v === 0n) return out('info', tr('取消 {name} 授权', { name }), [tr('把 {spender} 的授权额度设为 0。', { spender })]);
        if (v >= HUGE) {
          return out('danger', tr('无限额授权 {name}', { name }), [
            tr('允许 {spender} 随时转走你钱包里全部的 {name}，没有数量上限，以后也一直有效。', { spender, name }),
            tr('钓鱼网站最常用这一招。除非你完全信任这个合约，否则请拒绝，或者在钱包里改成本次需要的数额。'),
          ]);
        }
        const amt = await amount(to, v);
        return out('warn', tr('授权 {amount}', { amount: amt.text }), [tr('允许 {spender} 从你的钱包转走最多 {amount}。', { spender, amount: amt.text })]);
      }
    }
    if (sel === SEL.setApprovalForAll) {
      const a = args(data, ['address', 'bool']);
      if (a) {
        const [operator, on] = a;
        if (!on) return out('info', tr('取消 NFT 全部授权'), [tr('收回 {operator} 对这个系列 NFT 的授权。', { operator })]);
        return out('danger', tr('授权这个系列的全部 NFT'), [
          tr('允许 {operator} 转走你在合约 {to} 里的所有 NFT，包括以后收到的，一直有效。', { operator, to }),
          tr('只有在你信任的交易市场挂单时才需要这样授权。不认识这个地址请拒绝。'),
        ]);
      }
    }
    if (sel === SEL.permit2Approve) {
      const a = args(data, ['address', 'address', 'uint', 'uint']);
      if (a) {
        const [token, spender, v] = a;
        if (v >= HUGE) return out('danger', tr('通过 Permit2 无限额授权'), [tr('允许 {spender} 随时转走你全部的这种代币（合约 {token}）。', { spender, token })]);
        const amt = await amount(token, v);
        return out('warn', tr('通过 Permit2 授权 {amount}', { amount: amt.text }), [tr('允许 {spender} 从你的钱包转走最多 {amount}。', { spender, amount: amt.text })]);
      }
    }
    if (sel === SEL.transfer) {
      const a = args(data, ['address', 'uint']);
      if (a) {
        const amt = await amount(to, a[1]);
        return out('warn', tr('转出 {amount}', { amount: amt.text }), [tr('收款地址：{to}', { to: a[0] })]);
      }
    }
    if (sel === SEL.transferFrom || sel === SEL.safeTransferFrom || sel === SEL.safeTransferFromData) {
      const a = args(data, ['address', 'address', 'uint']);
      if (a) {
        return out('warn', tr('转出资产'), [
          tr('从 {from} 转到 {to}', { from: a[0], to: a[1] }),
          tr('合约 {contract}，编号或数额 {v}', { contract: to, v: String(a[2]) }),
        ]);
      }
    }
    if (sel === SEL.safeTransferFrom1155) {
      const a = args(data, ['address', 'address', 'uint', 'uint']);
      if (a) {
        return out('warn', tr('转出 NFT #{id} × {n}', { id: String(a[2]), n: String(a[3]) }), [
          tr('从 {from} 转到 {to}', { from: a[0], to: a[1] }),
          tr('合约 {contract}', { contract: to }),
        ]);
      }
    }
    return out('warn', tr('调用合约（无法解读）'), [
      tr('合约地址：{to}', { to }),
      tr('TapeBrowser 认不出这次调用在做什么。请确认你信任这个网站和这个合约，并在钱包里仔细核对。'),
    ]);
  }

  /** 结构化数据签名：Permit、Permit2、Seaport 挂单等离线授权 */
  async function analyzeTyped(rawData) {
    let d = rawData;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    let pretty = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
    try { pretty = JSON.stringify(typeof rawData === 'string' ? JSON.parse(rawData) : rawData, null, 1); } catch { /* 原样显示 */ }
    const raw = short(pretty);
    const out = (level, title, lines) => ({ level, title, lines, raw });
    // eth_signTypedData v1 是 [{type, name, value}] 数组，没有结构可以解读
    if (!d || typeof d !== 'object' || Array.isArray(d)) return out('warn', tr('签名结构化数据'), [tr('无法解读这份数据，请在钱包里仔细核对。')]);
    const type = String(d.primaryType || '');
    const m = d.message && typeof d.message === 'object' ? d.message : {};
    const domain = d.domain && typeof d.domain === 'object' ? d.domain : {};
    const offline = tr('这是离线签名：不发交易、不花手续费，但签了之后对方就可以拿去用。钓鱼网站常用这种方式骗取授权。');

    // EIP-2612 Permit：签名即授权代币
    if (type === 'Permit' && isAddr(m.spender) && m.value !== undefined) {
      const token = isAddr(domain.verifyingContract) ? domain.verifyingContract : null;
      const v = big(m.value);
      if (v === null || v >= HUGE) {
        return out('danger', tr('签名授权：无限额 {name}', { name: domain.name || tr('代币') }), [
          tr('允许 {spender} 随时转走你全部的这种代币（合约 {token}）。', { spender: m.spender, token: token || '?' }), offline,
        ]);
      }
      const amt = token ? await amount(token, v) : { text: String(v) };
      return out('danger', tr('签名授权 {amount}', { amount: amt.text }), [tr('允许 {spender} 从你的钱包转走最多 {amount}。', { spender: m.spender, amount: amt.text }), offline]);
    }
    // Uniswap Permit2：PermitSingle / PermitBatch / PermitTransferFrom
    if (/^Permit(Single|Batch|TransferFrom|BatchTransferFrom|WitnessTransferFrom)$/.test(type)) {
      const spender = m.spender || m.details?.spender || '?';
      const details = Array.isArray(m.details) ? m.details : m.details ? [m.details] : Array.isArray(m.permitted) ? m.permitted : m.permitted ? [m.permitted] : [];
      const lines = [];
      let unlimited = false;
      for (const x of details.slice(0, 5)) {
        const v = big(x.amount);
        if (v === null || v >= HUGE) { unlimited = true; lines.push(tr('{token}：无限额', { token: x.token })); continue; }
        lines.push((await amount(x.token, v)).text);
      }
      return out('danger', unlimited ? tr('通过 Permit2 签名无限额授权') : tr('通过 Permit2 签名授权'), [
        tr('允许 {spender} 转走以下代币：', { spender }), ...lines, offline,
      ]);
    }
    // Seaport（OpenSea 等）挂单：offer 是你给出的，consideration 是你收到的
    if (type === 'OrderComponents' && Array.isArray(m.offer)) {
      return out('danger', tr('签名 NFT 挂单（Seaport）'), [
        tr('你给出 {n} 项资产，换取 {k} 项回报。', { n: m.offer.length, k: Array.isArray(m.consideration) ? m.consideration.length : 0 }),
        tr('签了之后任何人都可以按这个价格成交。钓鱼网站会伪造 0 元挂单骗走 NFT，请确认价格和收款地址。'),
      ]);
    }
    const lines = [];
    if (domain.name) lines.push(tr('应用：{name}', { name: domain.name }));
    if (isAddr(domain.verifyingContract)) lines.push(tr('合约：{to}', { to: domain.verifyingContract }));
    if (type) lines.push(tr('类型：{type}', { type }));
    // 消息里出现 spender / operator 的，多半是授权类签名
    if (isAddr(m.spender) || isAddr(m.operator)) {
      return out('danger', tr('签名可能是授权'), [...lines, tr('签名内容里有授权对象 {who}。', { who: m.spender || m.operator }), offline]);
    }
    return out('warn', tr('签名结构化数据'), [...lines, tr('TapeBrowser 认不出这份签名的用途，请在钱包里仔细核对。')]);
  }

  /** 解读一个签名 / 交易请求 */
  async function analyze(method, params, { net = null } = {}) {
    const p = Array.isArray(params) ? params : [];
    switch (method) {
      case 'personal_sign': {
        const text = hexToText(p[0]);
        const body = short(text ?? String(p[0] ?? ''));
        // 登录签名（Sign-In with Ethereum）通常带 URI 和 Nonce，签了只证明你是地址主人
        return { level: 'info', title: tr('签名一段消息'), lines: [tr('签消息不会转走资产，但请确认内容是你认可的。')], raw: body };
      }
      case 'eth_sign':
        return {
          level: 'danger',
          title: tr('盲签原始数据'),
          lines: [tr('网站要你签一段看不懂的原始数据，它可能是一笔交易，签了就可能被拿去转走资产。正规网站几乎不会这样要求，请拒绝。')],
          raw: short(String(p[1] ?? '')),
        };
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
        return analyzeTyped(method === 'eth_signTypedData' ? p[0] : p[1]);
      case 'eth_sendTransaction':
        return analyzeTx(p[0] || {}, net);
      default:
        return { level: 'warn', title: method, lines: [], raw: short(JSON.stringify(p)) };
    }
  }

  return { analyze };
}
