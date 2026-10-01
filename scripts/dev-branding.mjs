// 开发模式（npm start）下，菜单栏和「关于」里的应用名取自 node_modules 里 Electron.app 的 Info.plist，
// 运行时改不了。这里把开发用的 Electron.app 改名为 TapeBrowser 并换上图标。只影响本机 node_modules；
// 打包产物由 electron-builder 按 package.json 的 productName 和 build/icon.icns 生成，不需要这一步。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const root = fileURLToPath(new URL('..', import.meta.url));
const appDir = join(root, 'node_modules/electron/dist/Electron.app');
const plist = join(appDir, 'Contents/Info.plist');
if (!existsSync(plist)) process.exit(0);

const NAME = 'TapeBrowser';
const buddy = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { encoding: 'utf8' }).trim();
const read = (key) => { try { return buddy(`Print :${key}`); } catch { return null; } };
const write = (key, value) => (read(key) === null ? buddy(`Add :${key} string ${value}`) : buddy(`Set :${key} ${value}`));

let changed = false;
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (read(key) !== NAME) { write(key, NAME); changed = true; }
}
const icon = join(appDir, 'Contents/Resources', read('CFBundleIconFile') || 'electron.icns');
copyFileSync(join(root, 'build/icon.icns'), icon);

if (changed) {
  // 让访达和 Dock 重新读取应用信息
  const now = new Date();
  utimesSync(appDir, now, now);
  console.log('dev-branding: Electron.app 已改名为 TapeBrowser');
}
