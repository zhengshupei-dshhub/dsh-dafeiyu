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

BLACK_THRESH = 4.0   # 最大通道低于此值视为背景（纯黑）
FEATHER = 0.7        # 边缘羽化半径（px）
HALO_BLUR = 2.2      # 外围光晕模糊半径
HALO_WEIGHT = 0.00   # 外围光晕强度（0=不加，接近原版）
EDGE_BLUR = 6        # 边缘色去污染的邻域半径


def matte(png: Path) -> Image.Image:
    """黑底 webm → 透明 RGBA。

    v6（2026-11-05）：以「是否黑」而不是亮度做 alpha，避免深色部位（头发/裙子）被算成半透明；
    再做 0.7px 羽化 + 外围柔和光晕还原原画的边缘观感；边缘色用邻近实心像素填充。
    """
    arr = np.asarray(Image.open(png).convert("RGB")).astype(np.float32)
    lum = arr.max(axis=2)

    alpha = (lum > BLACK_THRESH).astype(np.float32)
    alpha = np.asarray(
        Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(FEATHER))
    ).astype(np.float32) / 255.0
    if HALO_WEIGHT > 0:
        halo = np.asarray(
            Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(HALO_BLUR))
        ).astype(np.float32) / 255.0
        alpha = np.clip(alpha + halo * HALO_WEIGHT, 0, 1)

    foreground = alpha >= 0.99
    weighted = np.clip(arr, 0, 255) * foreground[..., None]
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
    rgb = arr.copy()
    band = (alpha > 0.02) & (alpha < 0.99)
    rgb[band] = np.clip(fill[band], 0, 255)

    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), (alpha * 255).astype(np.uint8)]), "RGBA")


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
