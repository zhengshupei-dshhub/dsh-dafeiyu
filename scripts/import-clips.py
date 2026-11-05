#!/usr/bin/env python3
"""从上游 dsh-pet 仓库的 webm 片段生成透明 webp 帧，接入本地 pet-manifest。

来源：https://github.com/PC2005-cloud/dsh-pet （dsh-pet/assets/webm，VP9，黑底）
管线：ffmpeg 抽帧(crop 412:344:100:0 @24fps RGB) → 按亮度做 alpha(黑=透明) → Pillow 写 webp(q68)

用法：
  python scripts/import-clips.py 待机呼吸休闲:idle_breathe 开心小跑:walk ...
"""
from __future__ import annotations

import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets" / "pet"
BASE = "https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/webm"
CROP = "412:344:100:0"
FPS = 24
QUALITY = 68

from PIL import Image  # noqa: E402


def alpha_from_luma(r: int, g: int, b: int) -> int:
    lum = (r + g + b) // 3
    if lum <= 3:
        return 0
    if lum >= 15:
        return 255
    return int((lum - 3) / 12 * 255)


def convert(webm_name: str, key: str) -> int:
    out_dir = ASSETS / key
    out_dir.mkdir(parents=True, exist_ok=True)
    enc = urllib.parse.quote(webm_name)
    src = f"{BASE}/{enc}.webm"
    tmp = ROOT / ".tmp-clip.webm"
    print(f"下载 {webm_name} …")
    urllib.request.urlretrieve(src, tmp)

    png_dir = ROOT / ".tmp-png"
    png_dir.mkdir(exist_ok=True)
    for p in png_dir.glob("*.png"):
        p.unlink()

    print(f"抽帧 …")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(tmp),
         "-vf", f"crop={CROP},fps={FPS}", "-pix_fmt", "rgb24",
         str(png_dir / "f_%04d.png")],
        check=True,
    )
    frames = sorted(png_dir.glob("*.png"))
    for i, png in enumerate(frames, start=1):
        im = Image.open(png).convert("RGB")
        px = im.load()
        w, h = im.size
        out = Image.new("RGBA", (w, h))
        op = out.load()
        for y in range(h):
            for x in range(w):
                r, g, b = px[x, y]
                op[x, y] = (r, g, b, alpha_from_luma(r, g, b))
        out.save(out_dir / f"{key}_{i:03d}.webp", "WEBP", quality=QUALITY, method=6)

    tmp.unlink(missing_ok=True)
    for p in png_dir.glob("*.png"):
        p.unlink()
    print(f"{key}: {len(frames)} 帧 → {out_dir}")
    return len(frames)


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        name, key = arg.split(":")
        convert(name, key)
