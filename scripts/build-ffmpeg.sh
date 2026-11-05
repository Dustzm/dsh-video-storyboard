#!/usr/bin/env bash
# build-ffmpeg.sh — 构建随安装包分发的 LGPL 版 ffmpeg / ffprobe（通办衍生）。
#
# 产物：<out>/ffmpeg-<版本>-<目标>.tar.xz（bin/ffmpeg[.exe]、bin/ffprobe[.exe]、许可证、BUILDCONF.txt）
#       <out>/ffmpeg-<版本>-source.tar.xz（FFmpeg 与 dav1d 的对应源码和本脚本，满足 LGPL 的源码提供义务）
#       <out>/SHA256SUMS
#
# 许可：不加 --enable-gpl / --enable-nonfree / --enable-version3，结果为 LGPL-2.1-or-later；
#       外部库只有 dav1d（BSD-2-Clause，AV1 软解）与 zlib。末尾核对构建配置，出现 gpl/nonfree 即失败。
# 组件：解码器、解封装器、parser 保持默认全开（兼容用户丢进来的各种视频）；编码器与封装器只留插件用到的
#       （png、mjpeg 出图，pcm_s16le/wav 给转写，srt 导出内嵌字幕，rawvideo/null 给分析）；不带网络与设备。
#
# 目标与构建机：
#   darwin-arm64、darwin-x64  在 macOS 上构建（本机架构不同时自动交叉编译）；依赖 Xcode CLT、pkg-config、meson、ninja，x64 另需 nasm
#   win32-x64                 在 Linux 上用 mingw-w64 交叉编译；依赖 gcc-mingw-w64-x86-64、libz-mingw-w64-dev、nasm、pkg-config、meson、ninja
# 由 .github/workflows/ffmpeg.yml 调用；本地也可直接跑。
#
# 用法：scripts/build-ffmpeg.sh <darwin-arm64|darwin-x64|win32-x64> <输出目录>
set -euo pipefail

FFMPEG_VERSION=8.0.1
DAV1D_VERSION=1.5.4
MACOS_MIN=11.0

target=${1:?usage: build-ffmpeg.sh <darwin-arm64|darwin-x64|win32-x64> <out-dir>}
out=$(mkdir -p "${2:?out dir}" && cd "$2" && pwd)
exe=''
case "$target" in
  darwin-arm64) arch=arm64; cpu_family=aarch64 ;;
  darwin-x64) arch=x86_64; cpu_family=x86_64 ;;
  win32-x64) arch=x86_64; cpu_family=x86_64; exe=.exe ;;
  *) echo "unsupported target: $target" >&2; exit 2 ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/tongdo-ffmpeg.XXXXXX")
trap 'rm -rf "$work"' EXIT
prefix="$work/prefix"
src="$work/src"
mkdir -p "$prefix" "$src"
jobs=$(sysctl -n hw.ncpu 2>/dev/null || nproc)

# FFmpeg 源码：官网发布包优先；官网连不上时用官方 GitHub 镜像的同版本标签（n<版本>），两者源码相同
if curl -fsSL --retry 3 --retry-all-errors "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
  -o "$src/ffmpeg-$FFMPEG_VERSION.tar.xz"; then
  tar -xf "$src/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$work"
else
  rm -f "$src/ffmpeg-$FFMPEG_VERSION.tar.xz"
  curl -fsSL --retry 3 "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n$FFMPEG_VERSION.tar.gz" \
    -o "$src/FFmpeg-n$FFMPEG_VERSION.tar.gz"
  tar -xf "$src/FFmpeg-n$FFMPEG_VERSION.tar.gz" -C "$work"
  mv "$work/FFmpeg-n$FFMPEG_VERSION" "$work/ffmpeg-$FFMPEG_VERSION"
fi
curl -fsSL --retry 3 "https://downloads.videolan.org/pub/videolan/dav1d/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.xz" \
  -o "$src/dav1d-$DAV1D_VERSION.tar.xz"
tar -xf "$src/dav1d-$DAV1D_VERSION.tar.xz" -C "$work"
cp "$0" "$src/build-ffmpeg.sh"

# ---- 平台差异：dav1d 的 meson 交叉文件、FFmpeg 的 configure 参数
meson_cross=()
ff_platform=()
case "$target" in
  darwin-*)
    flags="-arch $arch -mmacosx-version-min=$MACOS_MIN"
    export CFLAGS="$flags" LDFLAGS="$flags"
    if [ "$(uname -m)" != "$arch" ]; then
      cat > "$work/cross.ini" <<EOF
[binaries]
c = 'clang'
ar = 'ar'
strip = 'strip'
[built-in options]
c_args = ['-arch', '$arch', '-mmacosx-version-min=$MACOS_MIN']
c_link_args = ['-arch', '$arch', '-mmacosx-version-min=$MACOS_MIN']
[host_machine]
system = 'darwin'
cpu_family = '$cpu_family'
cpu = '$arch'
endian = 'little'
EOF
      meson_cross=(--cross-file "$work/cross.ini")
      ff_platform+=(--enable-cross-compile --arch="$arch" --target-os=darwin)
    fi
    ff_platform+=(--cc=clang --extra-cflags="$flags" --extra-ldflags="$flags"
      --enable-videotoolbox --enable-audiotoolbox)
    ;;
  win32-x64)
    host=x86_64-w64-mingw32
    cat > "$work/cross.ini" <<EOF
[binaries]
c = '$host-gcc'
ar = '$host-ar'
strip = '$host-strip'
windres = '$host-windres'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
    meson_cross=(--cross-file "$work/cross.ini")
    # 静态链接 mingw 运行时与 zlib（libz-mingw-w64-dev），exe 不依赖额外 DLL。
    # 带 --cross-prefix 时 configure 默认找 $host-pkg-config，Ubuntu 没有；dav1d 的 .pc 由 PKG_CONFIG_PATH 指向，用宿主的 pkg-config 即可。
    ff_platform+=(--enable-cross-compile --arch=x86_64 --target-os=mingw32 --cross-prefix="$host-" --pkg-config=pkg-config
      --extra-ldflags=-static --enable-d3d11va --enable-dxva2)
    ;;
esac

# ---- dav1d（静态库）
(
  cd "$work/dav1d-$DAV1D_VERSION"
  meson setup build ${meson_cross[@]+"${meson_cross[@]}"} --prefix="$prefix" --libdir=lib \
    --buildtype=release -Ddefault_library=static -Denable_tools=false -Denable_tests=false
  ninja -C build install
)

# ---- FFmpeg（静态）
(
  cd "$work/ffmpeg-$FFMPEG_VERSION"
  PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure ${ff_platform[@]+"${ff_platform[@]}"} \
    --prefix="$prefix" --pkg-config-flags=--static \
    --disable-shared --enable-static --disable-debug --disable-doc --disable-ffplay \
    --disable-autodetect --enable-zlib --enable-libdav1d \
    --disable-network --disable-avdevice \
    --disable-protocols --enable-protocol=file,pipe,fd \
    --disable-encoders --enable-encoder=png,mjpeg,pcm_s16le,rawvideo,srt,subrip,wrapped_avframe \
    --disable-muxers --enable-muxer=image2,image2pipe,wav,null,rawvideo,srt
  make -j"$jobs"
  make install
)

# ---- 许可核对：以 configure 记录为准（交叉构建跑不了目标二进制）
conf=$(grep -h 'define FFMPEG_CONFIGURATION' "$work/ffmpeg-$FFMPEG_VERSION/config.h")
if echo "$conf" | grep -Eq -- '--enable-(gpl|nonfree|version3)'; then
  echo "refusing: build is not LGPL-2.1-or-later" >&2
  exit 1
fi

name="ffmpeg-$FFMPEG_VERSION-$target"
pkg="$work/pkg/$name"
mkdir -p "$pkg/bin"
cp "$prefix/bin/ffmpeg$exe" "$prefix/bin/ffprobe$exe" "$pkg/bin/"
cp "$work/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$pkg/LICENSE.LGPL-2.1.txt"
cp "$work/dav1d-$DAV1D_VERSION/COPYING" "$pkg/LICENSE.dav1d.txt"
echo "$conf" > "$pkg/BUILDCONF.txt"
tar -C "$work/pkg" -cJf "$out/$name.tar.xz" "$name"

srcpkg="$out/ffmpeg-$FFMPEG_VERSION-source.tar.xz"
[ -f "$srcpkg" ] || tar -C "$src" -cJf "$srcpkg" .
(cd "$out" && shasum -a 256 ffmpeg-*.tar.xz > SHA256SUMS 2>/dev/null || sha256sum ffmpeg-*.tar.xz > SHA256SUMS)
ls -lh "$out"
