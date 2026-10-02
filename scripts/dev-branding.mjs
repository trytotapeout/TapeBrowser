// 开发模式（npm start）下，菜单栏和「关于」里的应用名取自 node_modules 里 Electron.app 的 Info.plist，
// Dock 上的名字取自 .app 文件夹名，运行时都改不了。这里把开发用的 Electron.app 改名为 TapeBrowser.app、
// 改 Info.plist 并换上图标，再改 electron 包的 path.txt 让 `electron .` 启动改名后的应用。只影响本机 node_modules；
// 重新安装 electron 会还原，下次 npm start 时这里会再改一次。
// 打包产物由 electron-builder 按 package.json 的 productName 和 build/icon.icns 生成，不需要这一步。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, utimesSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const root = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'TapeBrowser';
const dist = join(root, 'node_modules/electron/dist');
const appDir = join(dist, `${NAME}.app`);
const pathFile = join(root, 'node_modules/electron/path.txt');
let changed = false;

// Electron.app → TapeBrowser.app（Dock 显示文件夹名）
if (existsSync(join(dist, 'Electron.app'))) {
  rmSync(appDir, { recursive: true, force: true });
  renameSync(join(dist, 'Electron.app'), appDir);
  changed = true;
}
const exe = `${NAME}.app/Contents/MacOS/Electron`;
if (existsSync(pathFile) && readFileSync(pathFile, 'utf8').trim() !== exe) { writeFileSync(pathFile, exe); changed = true; }

const plist = join(appDir, 'Contents/Info.plist');
if (!existsSync(plist)) process.exit(0);

const buddy = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { encoding: 'utf8' }).trim();
const read = (key) => { try { return buddy(`Print :${key}`); } catch { return null; } };
const write = (key, value) => (read(key) === null ? buddy(`Add :${key} string ${value}`) : buddy(`Set :${key} ${value}`));

for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (read(key) !== NAME) { write(key, NAME); changed = true; }
}
const icon = join(appDir, 'Contents/Resources', read('CFBundleIconFile') || 'electron.icns');
copyFileSync(join(root, 'build/icon.icns'), icon);

if (changed) {
  // 让访达和 Dock 重新读取应用信息
  const now = new Date();
  utimesSync(appDir, now, now);
  console.log(`dev-branding: 开发用的 Electron.app 已改名为 ${NAME}.app`);
}
