#!/usr/bin/env bash
# 构建 macOS Helper。
#
# 架构：DSH_DAFEIYU_ARCH=host（默认，跟随本机）/ arm64 / x86_64 / universal
# 之前默认编 universal，但本机工具链缺 x86_64 的 Swift 兼容库会链接失败，
# 而脚本在那之前已经 rm -rf 掉了 app bundle——正在跑的桌宠就被删了。
# 现在全部在临时目录里编好、签好，最后一步才替换正式目录。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
APP="$ROOT/runtime/bin/darwin/dsh-dafeiyu-helper.app"
BIN_NAME="dsh-dafeiyu-helper"
WORK="$(mktemp -d)"
STAGE="$WORK/app"
OLD="$WORK/old-app"

restore_on_exit() {
  # 只有「旧目录已经挪走、新目录还没到位」时才有东西要还原。
  if [[ -d "$OLD" && ! -d "$APP" ]]; then
    mv "$OLD" "$APP"
    echo "构建中断，已还原原来的 Helper。" >&2
  fi
  rm -rf "$WORK"
}
trap restore_on_exit EXIT

ARCH="${DSH_DAFEIYU_ARCH:-host}"
case "$ARCH" in
  host) ARCH="$(uname -m)" ;;
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x86_64" ;;
  universal) ;;
  *)
    echo "DSH_DAFEIYU_ARCH 只能是 host / arm64 / x86_64 / universal，收到：$ARCH" >&2
    exit 2
    ;;
esac

SOURCES=(
  "$DIR/Sources/AnimationModel.swift" \
  "$DIR/Sources/LayoutStore.swift" \
  "$DIR/Sources/PetGeometry.swift" \
  "$DIR/Sources/Permissions.swift" \
  "$DIR/Sources/NotificationLink.swift" \
  "$DIR/Sources/PetController.swift" \
  "$DIR/Sources/PetView.swift" \
  "$DIR/Sources/main.swift" \
)
FRAMEWORKS=(
  -framework AppKit \
  -framework UserNotifications \
  -framework ApplicationServices \
  -framework QuartzCore \
)

build_slice() {
  local target="$1" out="$2"
  echo "building $target slice (macOS 12+)..."
  swiftc -O -swift-version 5 -target "$target-apple-macosx12.0" \
    "${SOURCES[@]}" "${FRAMEWORKS[@]}" -o "$out"
}

if [[ "$ARCH" == "universal" ]]; then
  build_slice arm64 "$WORK/helper-arm64"
  build_slice x86_64 "$WORK/helper-x86_64"
  lipo -create "$WORK/helper-arm64" "$WORK/helper-x86_64" -output "$WORK/helper"
else
  build_slice "$ARCH" "$WORK/helper"
fi

# 在临时目录里装出完整 bundle 并签名；此时正式目录里的旧 Helper 仍在正常跑。
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
cp "$DIR/Info.plist" "$STAGE/Contents/Info.plist"
cp -R "$ROOT/assets" "$STAGE/Contents/Resources/assets"
PACKAGE_VERSION="$(node -p "require('$ROOT/package.json').version")"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $PACKAGE_VERSION" "$STAGE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PACKAGE_VERSION" "$STAGE/Contents/Info.plist"
cp "$WORK/helper" "$STAGE/Contents/MacOS/$BIN_NAME"
chmod 0755 "$STAGE/Contents/MacOS/$BIN_NAME"
codesign --force --deep --sign - --timestamp=none "$STAGE" >/dev/null 2>&1
plutil -lint "$STAGE/Contents/Info.plist" >/dev/null
codesign --verify --deep --strict "$STAGE" >/dev/null 2>&1

# 最后一步才换：目标父目录先建好，旧目录再挪走，失败时由 trap 还原。
mkdir -p "$(dirname "$APP")"
if [[ -d "$APP" ]]; then mv "$APP" "$OLD"; fi
mv "$STAGE" "$APP"
rm -rf "$OLD"

echo "built $ARCH macOS helper (macOS 12+): $APP"
lipo -info "$APP/Contents/MacOS/$BIN_NAME"
