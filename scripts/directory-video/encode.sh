#!/bin/zsh
# 用法：encode.sh 帧目录 输出.mp4 [每站秒数] [转场秒数]
set -e
dir=$1 out=$2 hold=${3:-0.6} fade=${4:-0.15}
frames=($dir/[0-9][0-9][0-9].png)
inputs=() filter="" prev="0"
for f in $frames; do inputs+=(-loop 1 -t $((hold + fade)) -framerate 30 -i $f); done
# 片尾停 2 秒
frames+=($dir/end.png); inputs+=(-loop 1 -t 2 -framerate 30 -i $dir/end.png)
for ((i = 1; i < ${#frames}; i++)); do
  filter+="[$prev][$i]xfade=transition=fade:duration=$fade:offset=$((i * hold))[v$i];"; prev="v$i"
done
ffmpeg -v error -y $inputs -filter_complex "${filter}[$prev]format=yuv420p[out]" -map "[out]" -c:v libx264 -crf 20 -preset slow -movflags +faststart $out
