// 分享链接落地页：…/open/?4454.0 → 尝试用 tape:// 唤起 TapeBrowser，没装的话显示下载按钮。
// 只解析链接里的电路地址，不读链，不发任何请求。
'use strict';
(function () {
  // 区号 → 链（和 TapeBrowser 一致：BNB Chain 不带区号，X Layer 2，Base 3）
  const CHAINS = { '': { name: 'BNB Chain', cls: 'bnb' }, 2: { name: 'X Layer', cls: 'xlayer' }, 3: { name: 'Base', cls: 'base' } };
  const EN = {
    eyebrow: 'DeWEB site',
    trying: 'Opening in TapeBrowser…',
    opened: 'Handed off to TapeBrowser. If nothing happened, use the buttons below to try again.',
    need: 'This site lives on-chain and opens in TapeBrowser, which reads and verifies the site files straight from the chain, with no gateway server in between.',
    download: 'Download TapeBrowser',
    retry: 'Installed? Try again',
    addr: 'Site address: ',
    badTitle: 'This link has no valid site address',
    badBody: 'Share links look like …/open/?4454.0. Circuit addresses such as 1.2.248 (X Layer) or 1.3.5 (Base) work too.',
    home: 'About TapeBrowser',
    source: 'Source code',
    mac: 'For macOS, download the Apple chip build (.dmg). Intel Macs can use 0.13.0.',
    win: 'For Windows, download the x64 installer (.exe).',
    linux: 'For Linux, download the AppImage.',
    other: 'TapeBrowser is a desktop app for macOS, Windows and Linux. Open this link on a computer.',
    title: 'Open {label} in TapeBrowser',
  };
  const ZH = {
    mac: 'macOS 请下载 Apple 芯片版本（.dmg）。Intel 芯片的 Mac 可以使用 0.13.0。',
    win: 'Windows 请下载 x64 安装包（.exe）。',
    linux: 'Linux 请下载 AppImage。',
    other: 'TapeBrowser 是 macOS、Windows、Linux 上的桌面应用，请在电脑上打开这个链接。',
    title: '在 TapeBrowser 中打开 {label}',
  };
  const en = !/^zh/i.test(navigator.language || '');
  const t = (k) => (en ? EN[k] : ZH[k]);
  const $ = (id) => document.getElementById(id);

  if (en) {
    document.documentElement.lang = 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) if (EN[el.dataset.i18n]) el.textContent = EN[el.dataset.i18n];
  }

  /**
   * ?4454.0、?4454-0、?1.2.248、?site=1.2.248，可带路径：?4454.0/docs/
   * 返回 {label, tape} 或 null。只接受数字和分隔符组成的电路地址，路径只允许常见的网址字符
   */
  function parse(search) {
    let q;
    try { q = decodeURIComponent(search.replace(/^\?/, '').replace(/^site=/, '')).trim(); } catch { return null; }
    q = q.replace(/^tape:\/\//i, '').replace(/^#/, '');
    const m = /^([1-9]\d*)[-.@](?:(\d+)[-.])?(0|[1-9]\d*)(?:\.tape)?(\/[\w\-./~%]*)?$/i.exec(q);
    if (!m) return null;
    const area = m[2] === undefined ? '' : m[2];
    if (!CHAINS[area]) return null;
    const host = [m[1], area, m[3]].filter((x) => x !== '').join('-');
    return {
      label: [m[1], area, m[3]].filter((x) => x !== '').join('.') + '.tape',
      chain: CHAINS[area],
      tape: `tape://${host}${m[4] || '/'}`,
    };
  }

  const site = parse(location.search);
  if (!site) { $('invalid').hidden = false; return; }

  $('site').hidden = false;
  $('label').textContent = site.label;
  $('chain').textContent = site.chain.name;
  $('chain').classList.add(site.chain.cls);
  $('tape').textContent = site.tape;
  document.title = t('title').replace('{label}', site.label);

  const ua = navigator.userAgent;
  const os = /Android|iPhone|iPad|iPod/i.test(ua) ? 'other' : /Mac/i.test(ua) ? 'mac' : /Win/i.test(ua) ? 'win' : /Linux/i.test(ua) ? 'linux' : 'other';
  $('platform').textContent = t(os);

  // 唤起后浏览器会失去焦点或页面被隐藏（弹出「要打开 TapeBrowser 吗」也会失焦），据此判断有没有接住
  let handled = false;
  const onLeave = () => {
    if (handled) return;
    handled = true;
    $('trying').hidden = true;
    $('opened').hidden = false;
    $('fallback').hidden = false;
  };
  function launch() {
    handled = false;
    window.addEventListener('blur', onLeave, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) onLeave(); }, { once: true });
    location.href = site.tape;
    setTimeout(() => {
      if (handled) return;
      handled = true;
      $('trying').hidden = true;
      $('fallback').hidden = false;
    }, 1500);
  }

  $('retry').addEventListener('click', (e) => { e.preventDefault(); launch(); });
  // 手机上没有 TapeBrowser，不尝试唤起
  if (os === 'other') { $('trying').hidden = true; $('fallback').hidden = false; $('retry').hidden = true; } else launch();
})();
