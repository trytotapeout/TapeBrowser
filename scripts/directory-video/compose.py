# 把外壳截图和网页截图叠成一帧，缩到 1920×1080，左下角写「推测分类：xxx」
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
shots_dir, dir_json, out_dir = sys.argv[1:4]
CATS = {'game': '游戏', 'finance': '金融', 'tool': '工具', 'social': '社交与内容', 'infra': '生态', 'other': '其他'}
sites = json.load(open(dir_json))['sites']
font = ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc', 40, index=1)
W, H = 1920, 1080
for s in json.load(open(f'{shots_dir}/shots.json')):
    shell = Image.open(f"{shots_dir}/{s['file']}-shell.png").convert('RGB')
    shell.paste(Image.open(f"{shots_dir}/{s['file']}-page.png").convert('RGB'), (s['x'], s['y']))
    k = min(W / shell.width, H / shell.height)
    img = shell.resize((round(shell.width * k), round(shell.height * k)), Image.LANCZOS)
    frame = Image.new('RGB', (W, H), (30, 30, 30))
    frame.paste(img, ((W - img.width) // 2, (H - img.height) // 2))
    host = s['url'].split('//')[1].strip('/')
    v = sites.get(host, {})
    cat = v.get('declared') or (v.get('guess') or {}).get('category') or 'other'
    text = f"推测分类：{CATS.get(cat, '其他')}"
    d = ImageDraw.Draw(frame, 'RGBA')
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    x, y, pad = 60, H - 60 - (b - t), 18
    d.rounded_rectangle((x - pad, y - pad + t, x + r + pad, y + b + pad), radius=14, fill=(0, 0, 0, 170))
    d.text((x, y), text, font=font, fill=(255, 255, 255))
    frame.save(f"{out_dir}/{s['file']}.png")
    print(s['file'], host, text)
# 片尾：图标 + 名字 + 下载地址
end = Image.new('RGB', (W, H), (30, 30, 30))
icon = Image.open(Path(__file__).resolve().parents[2] / 'build/icon.png').convert('RGBA').resize((240, 240), Image.LANCZOS)
end.paste(icon, ((W - 240) // 2, 260), icon)
d = ImageDraw.Draw(end)
for text, size, y, color in [('TapeBrowser', 72, 560, (255, 255, 255)), (f'浏览全部 {len(sites)} 个 DeWEB 网站', 40, 670, (200, 200, 200)),
                             ('github.com/trytotapeout/TapeBrowser', 40, 750, (120, 180, 255))]:
    f = ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc', size, index=1)
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=color)
end.save(f'{out_dir}/end.png')
