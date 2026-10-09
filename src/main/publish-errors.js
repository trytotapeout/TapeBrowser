// 发布流程（publisher / operator / operator-store）里给界面看的错误码。message 是给用户看的中文，界面按 code 区分怎么处理。
// 没有 code 的错误是节点故障、参数校验之类，界面照原样显示 message。

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
export const OPERATOR_OWNER_MISMATCH = 'OPERATOR_OWNER_MISMATCH'; // 容器已有另一个持有人的临时钱包，带 old

/** 带 code 的 Error；extra 里的字段（cause、old 等）一起挂到错误上。返回错误，由调用方 throw */
export function fail(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra);
}
