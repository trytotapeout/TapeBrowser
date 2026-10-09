#!/bin/zsh
# 把网站目录里的所有 DeWEB 网站各打开一次，拼成一段视频（每站 0.6 秒，左下角写推测分类，最后 2 秒片尾）
# 用法：scripts/directory-video/run.sh [输出.mp4]，默认 dist/video/deweb-all.mp4
# 需要 ffmpeg、python3 + Pillow；网站列表取本机 TapeBrowser 的 directory.json，先在浏览器里刷新一次目录
set -e
here=${0:A:h}; repo=${here:h:h}; out=${1:-$repo/dist/video/deweb-all.mp4}
dir_json="$HOME/Library/Application Support/TapeBrowser/directory.json"
work=$(mktemp -d); mkdir -p $work/shots $work/frames ${out:h}
node -e 'const d=require(process.argv[1]);require("fs").writeFileSync(process.argv[2],JSON.stringify(Object.keys(d.sites).map(k=>({url:"tape://"+k+"/",title:d.sites[k].title||""}))))' "$dir_json" $work/sites.json
cd $repo
npx electron --inspect=9334 . > $work/tb.log 2>&1 &
trap 'pkill -f "electron --inspect=9334" || true' EXIT
for i in $(seq 1 30); do sleep 1; curl -s 127.0.0.1:9334/json >/dev/null && break; done; sleep 6
node $here/drive.mjs $work/sites.json $work/shots
pkill -f "electron --inspect=9334" || true
python3 -I $here/compose.py $work/shots "$dir_json" $work/frames
$here/encode.sh $work/frames $out
echo "$out（中间文件在 $work）"
