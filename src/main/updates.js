// 检查更新：只提示、不自动下载安装。读 GitHub Releases 的最新正式版，比当前版本新就提示用户去下载页。
// 纯模块，不依赖 Electron（fetch 和设置由调用方传入）。
//   设置里存 updateCheckedAt（上次自动检查的时间）和 updateSkip（用户选了“跳过这个版本”的版本号）

export const RELEASES_API = 'https://api.github.com/repos/trytotapeout/TapeBrowser/releases/latest';
// 自动检查最多一天一次
export const CHECK_EVERY = 24 * 60 * 60 * 1000;

/** 'v1.2.3' / '1.2.3' → [1, 2, 3]；带预发布后缀（-beta 等）或格式不对返回 null */
export function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** a 比 b 新返回正数，旧返回负数，相同返回 0 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * 检查一次。返回
 *   { status: 'new', version, url }   有新版本
 *   { status: 'latest' }              已是最新
 *   { status: 'error', message }      网络或接口出错
 * 下载链接只用 GitHub 上的发布页，不用接口返回的 html_url，免得被引到别处
 */
export async function checkLatest({ current, fetchImpl, timeout = 15000 }) {
  const cur = parseVersion(current);
  if (!cur) return { status: 'error', message: 'bad current version: ' + current };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchImpl(RELEASES_API, { headers: { accept: 'application/vnd.github+json' }, signal: ctrl.signal });
    if (!res.ok) return { status: 'error', message: 'HTTP ' + res.status };
    const body = await res.json();
    // releases/latest 本来就不含草稿和预发布，这里再挡一次
    const latest = body && !body.draft && !body.prerelease ? parseVersion(body.tag_name) : null;
    if (!latest) return { status: 'error', message: 'bad release tag: ' + body?.tag_name };
    if (compareVersions(latest, cur) <= 0) return { status: 'latest' };
    const version = latest.join('.');
    return { status: 'new', version, url: `https://github.com/trytotapeout/TapeBrowser/releases/tag/v${version}` };
  } catch (e) {
    return { status: 'error', message: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 自动检查：距上次不到一天就不查；查到的是用户跳过的版本就当没有。手动检查不走这里 */
export async function autoCheck({ current, fetchImpl, settings, now = Date.now() }) {
  const last = Number(settings.get('updateCheckedAt')) || 0;
  if (last && now - last < CHECK_EVERY && now >= last) return { status: 'skipped' };
  const r = await checkLatest({ current, fetchImpl });
  // 出错不记时间，下次启动再试
  if (r.status !== 'error') settings.set('updateCheckedAt', now);
  if (r.status === 'new' && settings.get('updateSkip') === r.version) return { status: 'latest' };
  return r;
}
