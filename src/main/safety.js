// 安全体检：站在访客的角度，静态分析一个 DeWEB 网站的全部文件，列出「这个网站会对你的钱包做什么」和作恶特征。
// 纯函数，不依赖 Electron。链上网站和本地文件夹都用它（链上的读全站文件，本地的读文件夹）。
//
// audit({files, read, external, hasCode, tr}) → {abilities, findings, addresses, coverage}
//   files      [{path, size}]
//   read(path) → Promise<Uint8Array | null>
//   external   预览时实际加载过的外部资源 [{origin, risky}]（page-audit.js），可选
//   hasCode(addresses) → Promise<Map<address, bool>>：地址上有没有合约代码（读链），可选
//   abilities  这个网站能请你做的钱包操作：[{key, level, text, where}]
//   findings   作恶特征：[{level, text, where}]，level 是 danger / warn / info
//   addresses  代码里写死的地址：[{address, kind: contract | wallet | unknown, where}]
//   coverage   检查范围：{files, scanned, skipped: [没检查的路径], remote: 运行时加载了外部脚本}
//   extraSkipped 调用方没读的文件（超过上限、读取失败），一起列进 coverage.skipped
//
// 只是静态特征检查：能可靠认出现成的盗币工具包、钓鱼和骗助记词的页面，
// 作者有意规避（按时间或钱包触发、从别处读代码执行）时查不出来。报告里要写清楚这一点。

const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(v, k) ? String(v[k]) : all)) : s);

const TEXT = /\.(html?|m?js|cjs|css|json|svg|txt|map)$/i;
// 单个文件、全部文件最多扫多少字节
export const SCAN_FILE_MAX = 4 * 1024 * 1024;
export const SCAN_TOTAL_MAX = 24 * 1024 * 1024;
const MAX_WHERE = 3;
const READ_CONCURRENCY = 6;
const MAX_ADDRESSES = 40;

// ---- 1. 钱包操作：函数选择器（交易的 data 开头）和方法名
const abilityRules = (tr) => [
  { key: 'approve', level: 'warn', text: tr('请你授权代币（approve）：对方可以转走授权额度内的代币'), re: /0x095ea7b3|\bapprove\s*\(|"approve"|'approve'/ },
  { key: 'approveAll', level: 'danger', text: tr('请你授权全部 NFT（setApprovalForAll）：对方可以转走这个系列的所有 NFT'), re: /0xa22cb465|setApprovalForAll/ },
  { key: 'unlimited', level: 'danger', text: tr('代码里有无限额授权的数额（2^256-1）：一旦签了，对方可以随时转走你全部的这种代币'), re: /0x[fF]{64}\b|MaxUint256|maxUint256|ethers\.constants\.MaxUint256|2n\s*\*\*\s*256n\s*-\s*1n|\(1n\s*<<\s*256n\)\s*-\s*1n/ },
  { key: 'permit', level: 'danger', text: tr('请你签离线授权（Permit / Permit2）：不用发交易、不花 gas，签名本身就能授权对方转走代币'), re: /0xd505accf|0x2b67b570|0x87517c45|PermitSingle|PermitBatch|PermitTransferFrom|"Permit"\s*:|\bPermit\s*:\s*\[/ },
  { key: 'seaport', level: 'danger', text: tr('请你签 Seaport 挂单：可能以极低价格把 NFT 挂给对方'), re: /OrderComponents|ConsiderationItem|seaport/i },
  { key: 'ethSign', level: 'danger', text: tr('请你用 eth_sign 盲签：签的是一串看不懂的哈希，可能是任意交易'), re: /['"]eth_sign['"]/ },
  { key: 'transfer', level: 'warn', text: tr('请你转出代币或 NFT（transfer / transferFrom）'), re: /0xa9059cbb|0x23b872dd|0x42842e0e|0xb88d4fde|0xf242432a|\btransferFrom\s*\(|\.transfer\s*\(/ },
  { key: 'sendTx', level: 'info', text: tr('请你发交易（eth_sendTransaction）'), re: /eth_sendTransaction/ },
  { key: 'signTyped', level: 'info', text: tr('请你签结构化数据（eth_signTypedData）'), re: /eth_signTypedData/ },
  { key: 'personalSign', level: 'info', text: tr('请你签消息（personal_sign）'), re: /personal_sign/ },
  { key: 'connect', level: 'info', text: tr('请你连接钱包'), re: /eth_requestAccounts|wallet_requestPermissions|window\.ethereum|eip6963/ },
];

// ---- 2. 作恶特征
const signRules = (tr) => [
  // 骗你交出秘密：正规网站永远不会要助记词和私钥
  { level: 'danger', html: true, text: tr('页面让你输入助记词或私钥。正规网站永远不会要这些，输入了钱包就归别人了'), test: asksForSecret },
  // 盗币工具包：拿到钱包地址后查你持有的全部代币、按价值排序，再逐个骗授权
  { level: 'danger', text: tr('先查你钱包里所有代币和它们值多少钱，再逐个发起授权或转账，这是盗币工具包的典型写法'),
    test: (t) => INDEXER.test(t) && LOOP_APPROVE.test(t) },
  { level: 'warn', text: tr('在循环里连续请你授权或签 Permit：盗币工具包常这样批量清空钱包，正常应用一次授权多个代币时也会这样写，签之前看清每一笔'),
    test: (t) => !INDEXER.test(t) && LOOP_APPROVE.test(t) },
  // 把数据发出去：盗币网站常用 Telegram 机器人、Discord webhook 接收受害者信息
  { level: 'danger', text: tr('会把数据发到 Telegram 机器人或 Discord webhook。盗币网站常用这种方式把受害者的地址、签名发回给作者'),
    test: (t) => /api\.telegram\.org\/bot|discord(app)?\.com\/api\/webhooks/i.test(t) },
  { level: 'info', text: tr('用 navigator.sendBeacon 往外发数据：页面关闭时也能发出去，常用于统计，也可能用来回传信息'),
    test: (t) => /sendBeacon\s*\(/.test(t) },
  // 劫持钱包：改写 window.ethereum.request、替换 fetch，2025 年 npm 投毒事件注入的就是这种代码
  { level: 'danger', text: tr('改写了钱包的 request 方法，或用 Proxy 包住了 window.ethereum：可以偷偷替换你要签的交易，把收款地址换成别人的'),
    test: (t) => /\bethereum\.request\s*=(?!=)|ethereum\.send(Async)?\s*=(?!=)|new\s+Proxy\(\s*window\.ethereum\b/.test(t) },
  { level: 'warn', text: tr('替换了 fetch 或 XMLHttpRequest：可以拦截和篡改页面发出的所有请求'),
    test: (t) => /window\.fetch\s*=(?!=)|globalThis\.fetch\s*=(?!=)|XMLHttpRequest\.prototype\.(open|send)\s*=(?!=)/.test(t) },
  // 绕过链上校验：链上的代码不是实际运行的代码
  { level: 'info', text: tr('运行时用 eval / new Function 执行字符串代码：模拟器、模板引擎常这样用；如果字符串来自网络，实际运行的代码就不是链上这一份'),
    test: (t) => /\beval\s*\(|new\s+Function\s*\(/.test(t) },
  { level: 'danger', text: tr('从外部网址动态加载代码（import("https://…") 或创建 script 标签）：链上校验对这部分代码无效，作者可以随时换掉它'),
    test: (t) => /import\s*\(\s*['"`]https?:\/\//.test(t) || /createElement\(\s*['"]script['"]\s*\)[\s\S]{0,300}\.src\s*=\s*['"`]https?:\/\//.test(t) },
  // 混淆：链上网站的价值就是代码公开可查，故意混淆本身是一个信号
  { level: 'warn', text: tr('代码被混淆过（_0x 变量名、大段十六进制转义）：很难看出它在做什么，正规项目通常不会这样发布'),
    test: (t) => (t.match(/\b_0x[0-9a-f]{4,6}\b/g) || []).length > 20 || (t.match(/\\x[0-9a-f]{2}/gi) || []).length > 400 },
  // 冒充：标题或页面在冒充知名钱包和交易所，或者用「领空投、验证钱包」诱导操作
  { level: 'warn', htmlOnly: true, text: tr('页面在冒充知名钱包或交易所（MetaMask、Uniswap、Binance 等），或者用「领取空投、验证钱包、同步钱包」诱导你操作'),
    test: impersonates },
];

// 查钱包全部资产的索引接口（盗币工具包用它挑值钱的代币先下手）
const INDEXER = /alchemy_getTokenBalances|ankr_getAccountBalance|api\.debank\.com|pro-openapi\.debank|covalenthq\.com|deep-index\.moralis\.io|api\.zapper\.(fi|xyz)|getWalletTokenBalances/i;
// 在循环里请你授权、签 Permit
const LOOP_APPROVE = /\b(for|while)\s*\([^)]*\)\s*\{[^}]{0,400}(\.approve\s*\(|setApprovalForAll|0x095ea7b3|0xa22cb465|signTypedData)/s;

// 钱包的秘密：助记词、私钥。只出现在说明文字里不算（教程、密钥管理工具也会提到）
const SECRET = /助记词|私钥|seed\s*phrase|secret\s*recovery|recovery\s*phrase|mnemonic|private\s*key|12\s*个单词|24\s*个单词|12[\s-]*words?|24[\s-]*words?/i;
// 更明确指向钱包的说法：紧挨着输入框出现时才算
const WALLET_SECRET = /助记词|钱包私钥|seed\s*phrase|secret\s*recovery|recovery\s*phrase|mnemonic|wallet'?s?\s*private\s*key|12\s*个单词|24\s*个单词|12[\s-]*words?|24[\s-]*words?/i;
const FIELD = /<(input|textarea)\b[^>]*>/gi;

/** 页面要你输入助记词或私钥：输入框自己的提示文字（placeholder、name、aria-label）提到秘密，或钱包类秘密词紧挨着输入框 */
function asksForSecret(text) {
  for (const m of text.matchAll(FIELD)) {
    if (/type\s*=\s*["']?(hidden|checkbox|radio|submit|button|file)/i.test(m[0])) continue;
    if (SECRET.test(m[0])) return true;
    const near = text.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300);
    if (WALLET_SECRET.test(near)) return true;
  }
  return false;
}

// 冒充：标题里是知名钱包、交易所的名字，或者页面文字用「领空投、验证钱包」诱导操作
const BRAND_TITLE = /<title[^>]*>[^<]*\b(metamask|trust\s*wallet|uniswap|pancakeswap|binance|okx|opensea|ledger|trezor)\b/i;
const LURE = /\bclaim\s+(your\s+)?airdrop\b|领取空投|\bverify\s+(your\s+)?wallet\b|验证钱包|\bvalidate\s+(your\s+)?wallet\b|\bsync\s+(your\s+)?wallet\b|同步钱包|\brectify\s+(your\s+)?wallet\b/i;
/** 只看页面上能看到的文字：去掉脚本和样式，免得 walletVerified 这类变量名被当成诱导文字 */
function impersonates(html) {
  if (BRAND_TITLE.test(html)) return true;
  const visible = html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ');
  return LURE.test(visible);
}

const ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g;
// 预编译合约和系统地址（0x…01 ecrecover 等）：前面全是 0
const PRECOMPILE = /^0x0{36}[0-9a-f]{4}$/;
// 常见的公共地址，不用一个个列出来：Multicall3、零地址、销毁地址、Permit2
const KNOWN = new Set([
  '0xca11bde05977b3631167028862be2a173976ca11',
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x000000000022d473030f116ddee9f6b43ac78ba3',
]);

/** 第几行：报告里告诉访客问题出在哪 */
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export async function audit({ files, read, external = [], hasCode = null, extraSkipped = [], tr = fill }) {
  const abilities = new Map();
  const findings = new Map();
  const addrs = new Map();
  const skipped = [...extraSkipped];
  const ABILITIES = abilityRules(tr);
  const SIGNS = signRules(tr);
  let scanned = 0;

  const note = (map, key, item, where) => {
    let e = map.get(key);
    if (!e) map.set(key, (e = { ...item, where: [] }));
    if (where && e.where.length < MAX_WHERE && !e.where.includes(where)) e.where.push(where);
  };

  // 先挑出要扫的文本文件，并发读取（链上读取慢，逐个读几百个文件要很久）
  const todo = [];
  let planned = 0;
  for (const f of files) {
    if (!TEXT.test(f.path)) continue;
    if (f.size > SCAN_FILE_MAX || planned + f.size > SCAN_TOTAL_MAX) { skipped.push(f.path); continue; }
    planned += f.size;
    todo.push(f);
  }
  const contents = new Array(todo.length);
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const i = next++;
      try { contents[i] = await read(todo[i].path); } catch { contents[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, todo.length) }, worker));

  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    const bytes = contents[i];
    if (!bytes) { skipped.push(f.path); continue; }
    scanned += bytes.length;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const html = /\.html?$/i.test(f.path);

    for (const a of ABILITIES) {
      const m = a.re.exec(text);
      if (m) note(abilities, a.key, { key: a.key, level: a.level, text: a.text }, `${f.path}:${lineOf(text, m.index)}`);
    }
    for (const s of SIGNS) {
      if (s.html && !html && !/\.m?js$/i.test(f.path)) continue;
      if (s.htmlOnly && !html) continue;
      if (s.test(text)) note(findings, s.text, { level: s.level, text: s.text }, f.path);
    }
    for (const m of text.matchAll(ADDRESS)) {
      const a = m[0].toLowerCase();
      if (KNOWN.has(a) || PRECOMPILE.test(a)) continue;
      if (!addrs.has(a) && addrs.size >= MAX_ADDRESSES) continue;
      note(addrs, a, { address: a }, `${f.path}:${lineOf(text, m.index)}`);
    }
  }

  // 运行时实际加载的外部脚本：这部分代码不在链上，体检看不到
  const remote = external.filter((e) => e.risky).map((e) => e.origin);
  if (remote.length) note(findings, 'remote', { level: 'warn', text: tr('页面运行时加载了不在链上的外部脚本或接口：{list}。这部分代码体检看不到，作者可以随时换掉', { list: remote.slice(0, 4).join(tr('、')) }) });

  // 地址是合约还是普通钱包：授权给普通钱包几乎一定是盗币
  let codes = new Map();
  if (hasCode && addrs.size) { try { codes = await hasCode([...addrs.keys()]); } catch { /* 读不到不下结论 */ } }
  const addresses = [...addrs.values()].map((a) => ({ ...a, kind: codes.has(a.address) ? (codes.get(a.address) ? 'contract' : 'wallet') : 'unknown' }));
  const asksApproval = abilities.has('approve') || abilities.has('approveAll') || abilities.has('permit') || abilities.has('transfer');
  const wallets = addresses.filter((a) => a.kind === 'wallet');
  if (asksApproval && wallets.length) {
    note(findings, 'wallets', { level: 'info', text: tr('代码会请你授权或转账，同时写死了 {n} 个普通钱包地址（不是合约）：{list}。签名时核对授权对象和收款方：如果是这些普通钱包，钱会直接到某个人手里', { n: wallets.length, list: wallets.slice(0, 3).map((a) => a.address).join(tr('、')) }) });
  }

  const order = { danger: 0, warn: 1, info: 2 };
  const sort = (arr) => arr.sort((a, b) => order[a.level] - order[b.level]);
  return {
    abilities: sort([...abilities.values()]),
    findings: sort([...findings.values()]),
    addresses,
    coverage: { files: files.length, scanned, skipped, remote: remote.length > 0 },
  };
}
