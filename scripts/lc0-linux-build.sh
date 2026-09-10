#!/usr/bin/env bash
set -euo pipefail
trap 'chown -R "${LC0_OUTPUT_UID:-0}:${LC0_OUTPUT_GID:-0}" /work' EXIT

lc0_version="$1"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends build-essential git ca-certificates python3-pip ninja-build pkg-config libdnnl-dev zlib1g-dev patchelf
python3 -m pip install --no-cache-dir meson==1.4.2
git clone --recursive --depth 1 --branch "v${lc0_version}" https://github.com/LeelaChessZero/lc0.git /work/source
if [ "$lc0_version" = 0.32.1 ]; then
  test "$(git -C /work/source rev-parse HEAD)" = fd71a2d921b689c5f479d3227c3806c8e272d9c5
fi
meson setup /work/build /work/source --buildtype=release \
  -Db_lto=false -Dnative_arch=false -Dnative_cuda=false \
  -Dplain_cuda=false -Dcudnn=false -Dopencl=false -Dispc=false \
  -Dgtest=false -Dblas=true -Dopenblas=false -Ddnnl=true -Ddnnl_dir=/usr
meson compile -C /work/build -j 2
mkdir -p /work/artifact/notices
cp /work/build/lc0 /work/artifact/lc0
ldd /work/build/lc0 | while read -r soname arrow library rest; do
  if [ "$arrow" != '=>' ] || [ ! -f "$library" ]; then continue; fi
  case "$soname" in libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*) continue ;; esac
  cp -L "$library" "/work/artifact/$soname"
  patchelf --set-rpath '$ORIGIN' "/work/artifact/$soname"
done
patchelf --set-rpath '$ORIGIN' /work/artifact/lc0
cp /work/source/COPYING /work/artifact/notices/lc0-COPYING
for package in libdnnl2 libgomp1 libstdc++6 libgcc-s1 zlib1g ocl-icd-libopencl1; do
  if [ -f "/usr/share/doc/$package/copyright" ]; then
    cp -L "/usr/share/doc/$package/copyright" "/work/artifact/notices/$package-copyright"
  fi
done
cp /usr/share/common-licenses/Apache-2.0 /work/artifact/notices/Apache-2.0
tar --exclude=.git -czf "/work/artifact/notices/lc0-${lc0_version}-source.tar.gz" -C /work source
python3 - "$lc0_version" <<'PY'
import json, subprocess, sys
from pathlib import Path
Path('/work/artifact/notices/build.json').write_text(json.dumps({
    'engineVersion': sys.argv[1],
    'commit': subprocess.check_output(['git', '-C', '/work/source', 'rev-parse', 'HEAD'], text=True).strip(),
    'platform': 'linux-x64',
    'baseline': 'Ubuntu 22.04, glibc >= 2.35',
    'provider': 'DNNL',
    'packages': subprocess.check_output(['dpkg-query', '-W', 'libdnnl2', 'libgomp1', 'libstdc++6', 'libgcc-s1', 'zlib1g'], text=True).splitlines(),
}, indent=2) + '\n')
PY
