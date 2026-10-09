// 通过主进程的 Node inspector（9334 端口）驱动 TapeBrowser：逐个打开网站，等加载完分别截外壳和网页
import WebSocket from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
const [sitesFile, outDir] = process.argv.slice(2);
const sites = JSON.parse(readFileSync(sitesFile, 'utf8'));
const list = await (await fetch('http://127.0.0.1:9334/json')).json();
const sock = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => sock.on("open", r));
let id = 0; const pend = {};
sock.on("message", (m) => { const d = JSON.parse(m); if (pend[d.id]) { pend[d.id](d); delete pend[d.id]; } });
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const d = await call('Runtime.evaluate', { expression: expr, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
  if (d.result?.exceptionDetails || d.error) throw new Error(JSON.stringify(d.result?.exceptionDetails || d.error));
  return d.result.result.value;
};
await ev(`globalThis.__E = require('electron'); globalThis.__fs = require('fs'); 1`);
const shots = [];
for (const [i, s] of sites.entries()) {
  const t0 = Date.now();
  const r = await ev(`(async () => {
    const { BrowserWindow } = __E; const win = BrowserWindow.getAllWindows()[0];
    await win.webContents.executeJavaScript(${JSON.stringify(`tb.invoke('submit', ${JSON.stringify(s.url)})`)});
    await new Promise((r) => setTimeout(r, 300));
    const views = win.contentView.children.filter((v) => v.webContents);
    const wc = views[views.length - 1].webContents;
    // 等加载结束（最多 15 秒），再多等 1 秒让页面渲染、动画落定
    const ok = await new Promise((r) => {
      const to = setTimeout(() => r(false), 15000);
      const done = () => { clearTimeout(to); r(true); };
      if (!wc.isLoading()) setTimeout(() => (wc.isLoading() ? wc.once('did-stop-loading', done) : done()), 500);
      else wc.once('did-stop-loading', done);
    });
    await new Promise((r) => setTimeout(r, 1000));
    const base = ${JSON.stringify(`${outDir}/${String(i).padStart(3, '0')}`)};
    const shell = await win.capturePage();
    const page = await wc.capturePage();
    __fs.writeFileSync(base + '-shell.png', shell.toPNG());
    __fs.writeFileSync(base + '-page.png', page.toPNG());
    const b = views[views.length - 1].getBounds();
    const scale = shell.getSize().width / win.getContentBounds().width;
    return { ok, url: wc.getURL(), x: Math.round(b.x * scale), y: Math.round(b.y * scale), w: page.getSize().width, h: page.getSize().height };
  })()`);
  console.log(i, s.title, r, (Date.now() - t0) + 'ms');
  shots.push({ ...s, ...r, file: `${String(i).padStart(3, '0')}` });
}
writeFileSync(`${outDir}/shots.json`, JSON.stringify(shots, null, 1));
sock.close();
