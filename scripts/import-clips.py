#!/usr/bin/env python3
"""从上游 dsh-pet 仓库的 webm 片段生成透明 webp 帧。

来源：https://github.com/PC2005-cloud/dsh-pet （dsh-pet/assets/webm，VP9 黑底，无 alpha）

管线（2026-11-05 v2，修掉暗边/锯齿）：
  ffmpeg 抽帧(crop 412:344:100:0 @24fps RGB)
  → 亮度软阈值得到 alpha（0-5 全透明，46+ 全不透明）
  → 去预乘（源像素 = color*alpha，除以 alpha 还原真实颜色）
  → 边缘颜色去污染（半透明像素用邻近实体像素的颜色填，消除暗环）
  → Pillow 写 webp（alpha_quality=100 防 alpha 抖动）

用法：
  python scripts/import-clips.py 待机呼吸休闲:idle_breathe 开心小跑:walk ...
  python scripts/import-clips.py --local /tmp/dsh-pet-clips 待机呼吸休闲:idle_breathe
"""
from __future__ import annotations

import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets" / "pet"
BASE = "https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/webm"
CROP = "412:344:100:0"
FPS = 24
QUALITY = 85

ALPHA_LOW = 5.0    # 亮度低于此值 → 全透明
ALPHA_HIGH = 46.0  # 亮度高于此值 → 全不透明
EDGE_BLUR = 6      # 边缘颜色去污染的邻域半径
ALPHA_ERODE = 0.30 # 腐蚀外圈半透明环的幅度


def matte(png: Path) -> Image.Image:
    arr = np.asarray(Image.open(png).convert("RGB")).astype(np.float32)
    lum = arr.mean(axis=2)

    alpha = np.clip((lum - ALPHA_LOW) / (ALPHA_HIGH - ALPHA_LOW), 0, 1)
    alpha[lum <= ALPHA_LOW] = 0

    # 腐蚀外圈半透明环，去掉黑底抗锯齿留下的亮/暗边
    alpha = np.clip((alpha - ALPHA_ERODE) / (1.0 - ALPHA_ERODE), 0, 1)

    # 边缘颜色 = 邻近实心像素的平均色（只作用于边缘带，不碰内部）
    rgb = arr.copy()
    foreground = alpha >= 0.90
    weighted = np.clip(rgb, 0, 255) * foreground[..., None]
    color_blur = np.asarray(
        Image.fromarray(weighted.astype(np.uint8)).filter(ImageFilter.BoxBlur(EDGE_BLUR))
    ).astype(np.float32)
    weight_blur = (
        np.asarray(
            Image.fromarray((foreground * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(EDGE_BLUR))
        ).astype(np.float32)
        / 255.0
    )
    fill = color_blur / np.clip(weight_blur, 1e-3, 1)[..., None]
    edge = (alpha > 0.001) & (alpha < 0.95)
    rgb[edge] = np.clip(fill[edge], 0, 255)

    return Image.fromarray(np.dstack([rgb.astype(np.uint8), (alpha * 255).astype(np.uint8)]), "RGBA")


def convert(webm: Path, key: str) -> int:
    out_dir = ASSETS / key
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.webp"):
        old.unlink()

    png_dir = ROOT / ".tmp-png"
    png_dir.mkdir(exist_ok=True)
    for p in png_dir.glob("*.png"):
        p.unlink()

    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(webm),
         "-vf", f"crop={CROP},fps={FPS}", "-pix_fmt", "rgb24",
         str(png_dir / "f_%04d.png")],
        check=True,
    )
    frames = sorted(png_dir.glob("*.png"))
    for i, png in enumerate(frames, start=1):
        matte(png).save(out_dir / f"{key}_{i:03d}.webp", "WEBP",
                        quality=QUALITY, method=4, alpha_quality=100)

    for p in png_dir.glob("*.png"):
        p.unlink()
    print(f"{key}: {len(frames)} 帧 → {out_dir}")
    return len(frames)


if __name__ == "__main__":
    args = sys.argv[1:]
    local_dir = None
    if args and args[0] == "--local":
        local_dir = Path(args[1])
        args = args[2:]
    for arg in args:
        name, key = arg.split(":")
        src = (local_dir / f"{name}.webm") if local_dir else None
        if src and src.exists():
            convert(src, key)
        else:
            enc = urllib.parse.quote(name)
            tmp = ROOT / ".tmp-clip.webm"
            print(f"下载 {name} …")
            urllib.request.urlretrieve(f"{BASE}/{enc}.webm", tmp)
            convert(tmp, key)
            tmp.unlink(missing_ok=True)
