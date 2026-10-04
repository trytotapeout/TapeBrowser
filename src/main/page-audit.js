// 页面审计：记录每个电路网站实际加载了哪些链上文件（及其 sha256），以及哪些不在链上的外部资源。不依赖 Electron。
//
//   链上文件   tape:// 协议每返回一个文件就记一次 {path → sha256}（按网站 origin 记）
//   外部资源   网页发出的 http / https / ws 请求，按 origin 分组，记资源类型（脚本最危险）
//   签名基线   用户每次同意网站的签名或交易后，把当时已加载的链上文件快照存下来（持久化）；
//              下次再签名时比对，列出这期间改过的文件。只比两次都加载过的文件：
//              这次才加载到的文件可能早就存在，不能当成「新增」吓唬用户
//
// store 是 { get(origin), set(origin, files) }，存每个网站上次签名时的文件快照

const MAX_FILES = 500;
const MAX_EXTERNAL = 200;
// 外部资源类型（Electron webRequest 的 resourceType）：脚本、接口请求、WebSocket、内嵌页面能改变网页行为，
// 比图片、字体、样式危险得多
const RISKY = new Set(['script', 'xhr', 'webSocket', 'subFrame', 'object']);

export function createPageAudit(store) {
  // origin → { files: Map<path, sha256>, external: Map<url origin, {types: Set, count}> }
  const pages = new Map();

  const pageOf = (origin) => {
    let p = pages.get(origin);
    if (!p) pages.set(origin, (p = { files: new Map(), external: new Map() }));
    return p;
  };

  return {
    /** 网页重新加载或换了页面：清空外部资源记录（链上文件保留，签名比对需要整站已加载的文件） */
    reset(origin) {
      const p = pages.get(origin);
      if (p) p.external.clear();
    },

    /** tape:// 返回了一个文件 */
    file(origin, path, sha256) {
      const p = pageOf(origin);
      if (p.files.size >= MAX_FILES && !p.files.has(path)) return;
      p.files.set(path, String(sha256).toLowerCase());
    },

    /** 网页请求了一个不在链上的地址；type 是 Electron webRequest 的 resourceType */
    external(origin, url, type) {
      let host;
      try { host = new URL(url).origin; } catch { return; }
      const p = pageOf(origin);
      let e = p.external.get(host);
      if (!e) {
        if (p.external.size >= MAX_EXTERNAL) return;
        p.external.set(host, (e = { types: new Set(), count: 0 }));
      }
      e.types.add(type || 'other');
      e.count++;
    },

    /** 网站信息面板用：[{origin, types, count, risky}]，危险的排前面 */
    externalOf(origin) {
      const p = pages.get(origin);
      if (!p) return [];
      return [...p.external].map(([host, e]) => ({ origin: host, types: [...e.types], count: e.count, risky: [...e.types].some((t) => RISKY.has(t)) }))
        .sort((a, b) => Number(b.risky) - Number(a.risky) || b.count - a.count);
    },

    /** 签名前调用：和上次同意签名时比，哪些已加载的链上文件变了。{first, changed: [path]}；first 表示没有基线 */
    compare(origin) {
      const p = pages.get(origin);
      const prev = store.get(origin);
      if (!prev) return { first: true, changed: [] };
      const changed = p ? [...p.files].filter(([path, sha]) => path in prev && prev[path] !== sha).map(([path]) => path) : [];
      return { first: false, changed };
    },

    /** 用户同意签名后调用：把当前已加载的文件记为新的基线（这次没加载到的文件保留上次的哈希） */
    commit(origin) {
      const p = pages.get(origin);
      store.set(origin, { ...(store.get(origin) || {}), ...(p ? Object.fromEntries(p.files) : {}) });
    },
  };
}
