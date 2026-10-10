// 发布流程（publisher / operator / operator-store）里给界面看的错误码。message 是给用户看的中文，界面按 code 区分怎么处理。
// 没有 code 的错误是节点故障之类，界面照原样显示 message。

export const LATER = 'LATER';                     // 交易还没确认、节点还没同步之类：稍后可以继续
export const PENDING_TIMEOUT = 'PENDING_TIMEOUT'; // 临时钱包的交易一直没打包（operator.settle 超时），也是稍后可以继续
export const STATE_CHANGED = 'STATE_CHANGED';     // 链上状态变了，请重新检查
export const BUSY = 'BUSY';                       // 容器正在发布 / 临时钱包正在处理另一笔交易
export const WALLET_PENDING = 'WALLET_PENDING';   // 持有人钱包里还有未确认的交易
export const BAD_WALLET_HASH = 'BAD_WALLET_HASH'; // 钱包返回的交易哈希格式不对
export const OWNER_TX_FAILED = 'OWNER_TX_FAILED'; // 开通、授权、充值失败或没有生效
export const DECRYPT = 'DECRYPT';                 // 临时钱包无法解密
export const RECORD_BROKEN = 'RECORD_BROKEN';     // 临时钱包记录文件已损坏
export const OLD_OWNER_DUST = 'OLD_OWNER_DUST';   // 旧持有人的临时钱包余额不够付退款手续费
export const VERIFY_FAILED = 'VERIFY_FAILED';     // 读回来的内容和本地对不上（退款也出错时放在 cause 里）
export const GAS_PRICE = 'GAS_PRICE';             // Gas 单价太高 / 读不到有效单价 / 重签已到上限
export const CHAIN_UNSUPPORTED = 'CHAIN_UNSUPPORTED';
export const CHAIN_MISMATCH = 'CHAIN_MISMATCH';   // 网络不一致
export const CIRCUIT_MISSING = 'CIRCUIT_MISSING';
export const LOCAL_FILES = 'LOCAL_FILES';         // 本地文件异常
export const NOT_READY = 'NOT_READY';             // 还没有检查通过
export const UPLOAD_FAILED = 'UPLOAD_FAILED';     // 上传回执失败、模拟失败、上传后核对失败
export const REFUND_FAILED = 'REFUND_FAILED';
export const NO_OPERATOR = 'NO_OPERATOR';         // 没有这个容器的临时钱包
export const NOT_DUST = 'NOT_DUST';               // 临时钱包里的余额还能退回，不能直接放弃
export const WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED'; // 钱包没连接（桥接页没打开或没授权）
export const WALLET_ACCOUNT = 'WALLET_ACCOUNT';   // 钱包当前账户不是电路持有人
export const WALLET_CHAIN = 'WALLET_CHAIN';       // 钱包不在要发布的链上，切链被拒绝或没切成
export const USER_REJECTED = 'USER_REJECTED';     // 用户在钱包里拒绝了交易
export const WALLET_LOST = 'WALLET_LOST';         // 发交易时钱包没回应（超时、桥接断开），交易可能已经发出
export const WALLET_ERROR = 'WALLET_ERROR';       // 钱包返回的其他错误，原始错误在 cause，钱包的错误码在 walletCode
export const BAD_ARGS = 'BAD_ARGS';               // 渲染进程传来的参数不对
export const NOT_LOCAL = 'NOT_LOCAL';             // 文件夹没有在本地预览里打开过
export const NO_ENCRYPTION = 'NO_ENCRYPTION';     // 这台电脑无法安全保存临时钱包（safeStorage 不可用或是 basic_text），不能发布
// 只有 operator-store.create 抛出的 OPERATOR_OWNER_MISMATCH 带 old（旧记录，不含私钥），调用方据此先退款给旧持有人
export const OPERATOR_OWNER_MISMATCH = 'OPERATOR_OWNER_MISMATCH'; // 容器已有另一个持有人的临时钱包，带 old
export const OWNER_MISMATCH_OPERATOR = 'OWNER_MISMATCH_OPERATOR'; // createOperator 传入的持有人和记录不一致，不带 old

/** 带 code 的 Error；extra 里的字段（cause、old 等）一起挂到错误上。返回错误，由调用方 throw */
export function fail(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra);
}

/**
 * 上面这些错误码抛出时用的全部 message（中文，同时是 en.json 的 key）。IPC 层用 translateMessage 翻译。
 * {name} 是消息里拼进去的变量（文件路径、块序号、链名之类）；test/publish-messages.test.mjs 核对它和源码一致
 */
export const PUBLISH_MESSAGES = [
  // publish-service.js
  '这台电脑无法安全保存临时钱包，暂时不能发布',
  '这条链暂时不支持发布',
  '这个电路不存在',
  '请先连接钱包',
  '正在检查另一次发布',
  '本地文件异常：{path}',
  '还没有检查通过，不能发布',
  '正在发布另一个网站',
  '参数不对：{name}',
  '这个文件夹没有在本地预览里打开过',
  // operator.js
  '临时钱包不存在',
  '临时钱包的持有人不一致',
  '临时钱包的交易状态异常，请重新检查',
  '交易还没确认，可以稍后继续',
  '临时钱包正在处理另一笔交易',
  '还有一笔交易在等确认',
  '临时钱包有未确认的交易',
  '节点还没同步到最新区块，请稍后再试',
  '节点返回的交易哈希不一致',
  // operator-store.js
  '临时钱包无法解密（系统钥匙串可能已重置）',
  '临时钱包：记录文件已损坏',
  '这个容器已有另一个持有人的临时钱包，请先把它的余额退回原持有人',
  '交易的 nonce 不比已确认的大，节点可能落后',
  // publisher.js
  '这个容器正在发布',
  '读不到有效的 Gas 单价，请稍后再试',
  '当前 Gas 单价太高，请稍后再试',
  '开通容器失败',
  '授权失败',
  '充值失败',
  '持有人的交易还没确认，可以稍后继续',
  '钱包里还有一笔未确认的交易，请等它确认后再继续',
  '钱包返回的交易哈希格式不对',
  '链上状态变了，请重新检查：{reason}',
  '开通后核对失败',
  '旧持有人的临时钱包余额不够付退款手续费，已保留记录',
  '旧持有人的临时钱包还没退干净，请稍后再试',
  '上传 {path} 第 {index} 块失败',
  '授权没有生效',
  '上传 {path} 第 {index} 块模拟失败：{error}',
  '上传后核对失败：{path} 的块数没有增加',
  '核验失败：{path}',
  '读不到持有人地址的信息，请稍后再试',
  '退款交易一直没有打包，Gas 单价已到上限',
  '退款交易一直没有打包，余额不够按现在的单价重发',
  '退款交易还没确认，可以稍后再退',
  '退款失败',
  '持有人钱包里还有一笔未确认的交易，等它确认后再退款',
  '上一位持有人的交易还没确认，可以稍后再试',
  '网络不一致',
  '没有这个容器的临时钱包',
  '临时钱包还有一笔交易在等确认',
  '持有人还有一笔交易在等确认',
  '持有人钱包里还有一笔未确认的交易，等它确认后再处理',
  '临时钱包里的余额还能退回，请先退款',
  // owner-send.js
  '钱包当前账户不是这个电路的持有人',
  '钱包没有回应，交易可能已经发出；稍后继续时会先检查',
  '钱包没有切换到 {chain}',
  '你在钱包里拒绝了这笔交易',
];

// 不转义 { }：留给下面换成捕获组
const escapeRe = (s) => s.replace(/[.*+?^$()[\]\\|]/g, '\\$&');
// 带变量的消息：{name} → 捕获组，按整句匹配
const TEMPLATES = PUBLISH_MESSAGES.filter((m) => /\{\w+\}/.test(m)).map((m) => {
  const names = [...m.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
  const re = new RegExp('^' + escapeRe(m).replace(/\{\w+\}/g, '([\\s\\S]*?)') + '$');
  return { key: m, names, re };
});

/** message 对上 PUBLISH_MESSAGES 里的哪一条：返回 { key, vars }，都对不上返回 null */
export function matchMessage(message) {
  const m = String(message ?? '');
  if (PUBLISH_MESSAGES.includes(m)) return { key: m, vars: null };
  for (const t of TEMPLATES) {
    const hit = t.re.exec(m);
    if (hit) return { key: t.key, vars: Object.fromEntries(t.names.map((n, i) => [n, hit[i + 1]])) };
  }
  return null;
}

/**
 * 把错误的 message 翻译成界面语言：完全一样的直接查字典，带变量的按 PUBLISH_MESSAGES 里的模板拆出变量再填回去。
 * 都对不上（钱包原样返回的错误之类）原样交给 tr，没有翻译就显示原文
 */
export function translateMessage(message, tr) {
  const hit = matchMessage(message);
  return hit ? tr(hit.key, hit.vars ?? undefined) : tr(String(message ?? ''));
}
