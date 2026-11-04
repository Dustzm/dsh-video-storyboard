#!/usr/bin/env node
/**
 * fetch-ffmpeg.mjs — 把目标平台的 ffmpeg / ffprobe 放进 `vendor/ffmpeg/<platform>-<arch>/`（通办衍生）。
 *
 * 安装包打包时由通办的 `scripts/desktop-package.ts` 调用（`npm run vendor -- <目标>`）：先放入目标平台的
 * 二进制，再 `npm pack`，打完 `--clean` 清掉。插件运行时由 `src/storyboard/binaries.js` 的随包目录找到它们。
 *
 * 二进制来自本仓库自建的 LGPL 构建（`scripts/build-ffmpeg.sh`，经 `.github/workflows/ffmpeg.yml` 发布到 Release）；
 * 版本、Release 地址与各目标的 sha256 记在 `scripts/ffmpeg-sources.json`。sha256 不符或为空时直接失败：
 * 安装包必须带上 ffmpeg，不能静默缺失。
 *
 * 用法：
 *   node scripts/fetch-ffmpeg.mjs mac-arm64|mac-x64|win-x64   放入该平台的二进制（先清空 vendor/ffmpeg）
 *   node scripts/fetch-ffmpeg.mjs --clean                     删除 vendor/ffmpeg
 *
 * 下载的归档缓存在 `vendor/.cache/`（不入库），重复打包不重复下载。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor', 'ffmpeg');
const CACHE = join(ROOT, 'vendor', '.cache');
const SOURCES = JSON.parse(readFileSync(join(ROOT, 'scripts', 'ffmpeg-sources.json'), 'utf8'));

/** 通办的打包目标 → Node 的 `<platform>-<arch>`（与 binaries.js 的 vendoredMediaDir、构建脚本的目标名一致）。 */
const TARGETS = { 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64', 'win-x64': 'win32-x64' };

const arg = process.argv[2];
if (arg === '--clean') {
  rmSync(VENDOR, { recursive: true, force: true });
  console.log('vendor/ffmpeg removed');
  process.exit(0);
}
const target = TARGETS[arg];
if (!target) {
  console.error(`usage: fetch-ffmpeg.mjs <${Object.keys(TARGETS).join('|')}> | --clean`);
  process.exit(2);
}
const expected = SOURCES.sha256?.[target];
if (!expected) {
  console.error(`no ffmpeg build recorded for ${target}: run the "ffmpeg" workflow (.github/workflows/ffmpeg.yml), `
    + 'then put the release URL and the sha256 from its SHA256SUMS into scripts/ffmpeg-sources.json');
  process.exit(1);
}

const name = `ffmpeg-${SOURCES.version}-${target}`;
const url = `${SOURCES.release}/${name}.tar.xz`;
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

mkdirSync(CACHE, { recursive: true });
const archive = join(CACHE, `${name}.tar.xz`);
if (!existsSync(archive) || sha256(archive) !== expected) {
  console.log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(archive);
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`sha256 mismatch for ${url}: expected ${expected}, got ${actual}`);
  }
}

const unpacked = mkdtempSync(join(tmpdir(), 'tongdo-ffmpeg-'));
try {
  // macOS 与 Windows 10+ 自带的 tar（bsdtar）都能解 .tar.xz
  execFileSync('tar', ['-xf', archive, '-C', unpacked], { stdio: 'inherit' });
  const from = join(unpacked, name);
  rmSync(VENDOR, { recursive: true, force: true });
  const out = join(VENDOR, target);
  mkdirSync(out, { recursive: true });
  const exe = target.startsWith('win32-') ? '.exe' : '';
  for (const program of ['ffmpeg', 'ffprobe']) {
    copyFileSync(join(from, 'bin', `${program}${exe}`), join(out, `${program}${exe}`));
    chmodSync(join(out, `${program}${exe}`), 0o755);
  }
  for (const file of ['LICENSE.LGPL-2.1.txt', 'LICENSE.dav1d.txt', 'BUILDCONF.txt']) {
    copyFileSync(join(from, file), join(VENDOR, file));
  }
  writeFileSync(join(VENDOR, 'README.md'), [
    '# Bundled FFmpeg',
    '',
    `ffmpeg and ffprobe ${SOURCES.version} for ${target}: FFmpeg (a trademark of Fabrice Bellard), licensed under the`,
    'GNU Lesser General Public License version 2.1 or later (LICENSE.LGPL-2.1.txt), statically built with dav1d',
    '(BSD-2-Clause, LICENSE.dav1d.txt). They are separate programs run as subprocesses, not linked into this package.',
    'Build configuration: BUILDCONF.txt.',
    '',
    `Binaries: ${url}`,
    `Corresponding source code: ${SOURCES.release}/ffmpeg-${SOURCES.version}-source.tar.xz`,
    '',
  ].join('\n'));
  console.log(`vendor/ffmpeg/${target} ready`);
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
