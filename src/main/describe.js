// 签名 / 交易确认弹窗里的说明文字。纯函数。

const short = (s, n = 600) => (s.length > n ? s.slice(0, n) + '…' : s);

function hexToText(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const bytes = Buffer.from(hex.slice(2), 'hex');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // 有不可打印字符就当二进制显示
  return /[\u0000-\u0008\u000e-\u001f�]/.test(text) ? null : text;
}

function weiToBnb(hex) {
  try {
    const wei = BigInt(hex || 0);
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : String(whole);
  } catch { return '?'; }
}

export function describeRequest(method, params) {
  const p = Array.isArray(params) ? params : [];
  switch (method) {
    case 'personal_sign': {
      const text = hexToText(p[0]);
      return { title: '签名一段消息', body: short(text ?? String(p[0] ?? '')) };
    }
    case 'eth_sign':
      return { title: '签名原始数据（有风险：可能被用来签交易）', body: short(String(p[1] ?? '')) };
    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      const raw = method === 'eth_signTypedData' ? p[0] : p[1];
      let body = typeof raw === 'string' ? raw : JSON.stringify(raw);
      try { body = JSON.stringify(JSON.parse(body), null, 1); } catch { /* 原样显示 */ }
      return { title: '签名结构化数据', body: short(body) };
    }
    case 'eth_sendTransaction': {
      const tx = p[0] || {};
      const lines = [`发送到：${tx.to || '（创建合约）'}`, `金额：${weiToBnb(tx.value)} BNB`];
      if (tx.data && tx.data !== '0x') lines.push(`调用数据：${short(tx.data, 74)}（${(tx.data.length - 2) / 2} 字节）`);
      return { title: '发送交易', body: lines.join('\n') };
    }
    default:
      return { title: method, body: short(JSON.stringify(p)) };
  }
}
