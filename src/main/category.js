// DeWEB 应用的分类：没有站长声明（web.json）时，从首页推测一个默认分类。纯函数，不依赖 Electron。
//
// 规则是确定的、在本机算，不把网站内容发给任何服务：
//   1. 关键词：标题、<meta name="description">、<meta name="keywords"> 里的词，每命中一个给对应分类加分
//   2. 页面特征：<canvas> + requestAnimationFrame 偏向游戏；调用 window.ethereum、有合约地址偏向金融或工具
//   3. 最高分不够（MIN_SCORE）就归「其他」，不硬猜
// 结果带上命中的依据（why），界面上标「推测」，鼠标移上去能看到为什么

export const CATEGORIES = ['game', 'finance', 'tool', 'social', 'infra', 'other'];
const MIN_SCORE = 2;

// 标题和描述里的关键词：[正则, 分数]。标题命中的分数翻倍（见 classify）
const WORDS = {
  game: [
    [/游戏|游戏厅|大逃杀|消消乐|五子棋|象棋|围棋|麻将|麻將|德州|扑克|棋牌|彩票|闯关|远征|对战|大乱斗|三国|三國|巨兽|红色警戒|斗地主|抽卡/, 3],
    [/\b(game|games|gaming|arcade|royale|gomoku|chess|mahjong|poker|puzzle|rpg|pvp|strike|quest|kingdom|citadel|voxel|lottery)\b/i, 3],
    [/玩家|关卡|积分榜|排行榜|\b(play|player|level|score|leaderboard)\b/i, 1],
  ],
  finance: [
    [/借贷|抵押|质押|挖矿|矿机|收益|复利|理财|支付|兑换|流动性|交易所|做市|租赁|铸币|铸卡|销毁|看板|行情|利息|金库|美股|股票|对赌|发财|一路发|卡片|会员卡/, 3],
    [/\b(defi|swap|lend|lending|borrow|stake|staking|mining|mint|yield|liquidity|liquid|vault|pay|upay|payment|wrapped|token|tax|fair[- ]launch|dex|amm|farm|card|cards|acquire|marketplace|moon)\b/i, 3],
    [/价格|余额|\b(price|apy|apr|tvl|balance)\b/i, 1],
  ],
  tool: [
    [/钱包|公证|保险箱|验证器|计算器|识别|建站|工具|编辑器|生成器|转换|签名|加密|身份|域名|靓号|控制台/, 3],
    [/\b(wallet|tool|tools|calculator|generator|editor|converter|sign|notary|authenticator|encrypt|domain|domains|builder|id|control room|work)\b/i, 3],
  ],
  social: [
    [/聊天|社区|论坛|留言|日报|博客|主页|个人|设计师|伴学|粉丝|动态|文章|日记|作品集|小镇/, 3],
    [/\b(chat|qq|community|forum|blog|daily|news|fans|portfolio|profile|social|diary)\b/i, 3],
    [/mmlink\.me|linktr|个人网站/i, 3],
  ],
  infra: [
    [/网关|内核|容器|电路|处理器|校验|协议|节点|浏览器|官网|概览|运行时/, 2],
    [/\b(gateway|runtime|kernel|protocol|node|rpc|acceptance|browser|nand|nandout|nandverse|cpu|lightcpu|tapekit|commons|station)\b/i, 2],
  ],
};

const decode = (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256 * 1024));

/** <meta name="description|keywords" content="…"> */
function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  return (tag && /content=["']([^"']*)["']/i.exec(tag)?.[1]) || '';
}

/**
 * 从首页推测分类。title 是目录里取到的 <title>，bytes 是首页内容（可以没有）。
 * 返回 {category, why: [命中的依据]}；category 一定是 CATEGORIES 里的一个
 */
export function classify(title, bytes) {
  const html = bytes ? decode(bytes) : '';
  const desc = html ? `${metaContent(html, 'description')} ${metaContent(html, 'keywords')}` : '';
  const score = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const why = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  const hit = (cat, n, reason) => { score[cat] += n; why[cat].push(reason); };

  for (const [cat, rules] of Object.entries(WORDS)) {
    for (const [re, n] of rules) {
      const t = re.exec(title || '');
      // 标题最能说明网站是做什么的，分数翻倍
      if (t) hit(cat, n * 2, `标题「${t[0]}」`);
      else {
        const d = re.exec(desc);
        if (d) hit(cat, n, `描述「${d[0]}」`);
      }
    }
  }

  if (html) {
    // 游戏：画布 + 动画循环，或者常见的游戏引擎
    // 画布 + 动画循环也可能只是图表或背景动效，再要求监听键盘或触控才算游戏
    const canvas = /<canvas[\s>]/i.test(html);
    const loop = /requestAnimationFrame/.test(html);
    const input = /addEventListener\(\s*['"](keydown|keyup|touchstart|pointerdown)['"]/.test(html);
    if (canvas && loop && input) hit('game', 3, '页面有 canvas 动画和键盘、触控操作');
    else if (canvas && loop) hit('game', 1, '页面有 canvas 动画');
    if (/\b(phaser|pixi|three\.module|babylon|kaboom|matter\.js)\b/i.test(html)) hit('game', 3, '用了游戏引擎');
    // 链上交互：连接钱包、发交易
    const wallet = /window\.ethereum|eth_requestAccounts|eth_sendTransaction/.test(html);
    if (wallet) {
      // 有合约调用、授权、代币转账的偏向金融，只是连钱包、签名的偏向工具
      if (/approve\(|transferFrom|allowance|swapExact|getAmountsOut|0x095ea7b3|0xa9059cbb/i.test(html)) hit('finance', 2, '页面调用代币合约');
      else if (/personal_sign|eth_signTypedData/.test(html)) hit('tool', 1, '页面请求签名');
    }
  }

  const best = CATEGORIES.filter((c) => c !== 'other').sort((a, b) => score[b] - score[a])[0];
  if (score[best] < MIN_SCORE) return { category: 'other', why: [] };
  return { category: best, why: why[best] };
}

/** 站长在 web.json 里声明的分类；不认识的值当作没声明 */
export function declaredCategory(json) {
  const c = json && typeof json.category === 'string' ? json.category.trim().toLowerCase() : '';
  return CATEGORIES.includes(c) ? c : null;
}
