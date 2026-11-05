/**
 * binaries.test.mjs — ffmpeg / ffprobe 的解析：候选顺序、"不存在"与"读不到"的区分、宿主托管。
 *
 * Modified by Tongdo; see TONGDO_CHANGES.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as binaries from '../src/storyboard/binaries.js';

const {
  describeMediaSearch, hostedMediaCandidates, mediaCandidates, resolveMediaBinary, unpackedPath, useMediaBinaries, vendoredMediaDir,
} = binaries;

function touch(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'not really an executable');
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('binaries: 显式环境变量优先，即使文件不存在', () => {
  const path = join(tmpdir(), 'configured-ffmpeg');
  assert.equal(resolveMediaBinary('ffmpeg', {
    env: { DSH_FFMPEG_PATH: path }, platform: 'linux',
  }), path);
});

test('binaries: 先找 $DSH_HOME/tools/ffmpeg/bin，再找 $DSH_HOME/bin', (t) => {
  const home = fixture(t);
  const tools = join(home, 'tools', 'ffmpeg', 'bin', 'ffmpeg');
  const bin = join(home, 'bin', 'ffmpeg');
  touch(bin);
  touch(tools);

  const found = resolveMediaBinary('ffmpeg', {
    env: { DSH_HOME: home }, platform: 'linux',
  });
  assert.equal(found, tools);
  assert.ok(mediaCandidates('ffmpeg', {
    env: { DSH_HOME: home }, platform: 'linux',
  }).some((c) => c.path === bin));
});

test('binaries: 支持 DSH 安装根目录（$DSH_HOME 的上一级）', (t) => {
  const root = fixture(t);
  const home = join(root, '.dsh-home');
  const installRoot = join(root, 'app');
  const path = join(installRoot, 'tools', 'ffmpeg', 'bin', 'ffmpeg');
  touch(path);

  const found = resolveMediaBinary('ffmpeg', {
    env: { DSH_HOME: join(installRoot, '.dsh-home') }, platform: 'linux',
  });
  assert.equal(found, path);
});

test('binaries: Windows 使用 .exe 后缀', (t) => {
  const home = fixture(t);
  const path = join(home, 'bin', 'ffmpeg.exe');
  touch(path);

  assert.equal(resolveMediaBinary('ffmpeg', {
    env: { DSH_HOME: home }, platform: 'win32',
  }), path);
});

test('binaries: 找不到时回退裸命令，并在描述里列出搜索路径', (t) => {
  const home = fixture(t);
  assert.equal(resolveMediaBinary('ffprobe', {
    env: { DSH_HOME: home }, platform: 'linux',
  }), null);
  const text = describeMediaSearch('ffprobe', {
    env: { DSH_HOME: home }, platform: 'linux',
  });
  assert.match(text, /ffprobe not found; tried:/);
  assert.match(text, /tools\/ffmpeg\/bin/);
});

// issue #76：沙箱里 existsSync 会把 EACCES 吞成 false，报"not found"。
// 这两种情况必须能分开说，否则用户会一直重装 ffmpeg。
test('binaries: 读不到（EACCES）和不存在要分开报', (t) => {
  const home = fixture(t);
  const opts = {
    env: { DSH_HOME: home },
    platform: 'linux',
    probe: () => ({ ok: false, code: 'EACCES' }),
  };
  const text = describeMediaSearch('ffprobe', opts);
  assert.match(text, /cannot read it: EACCES/);
  assert.match(text, /sandbox/);
  assert.match(text, /DSH_FFPROBE_PATH/);
});

test('binaries: 全部 ENOENT 时不出现"读不到"的提示', (t) => {
  const home = fixture(t);
  const text = describeMediaSearch('ffprobe', {
    env: { DSH_HOME: home },
    platform: 'linux',
    probe: () => ({ ok: false, code: 'ENOENT' }),
  });
  assert.doesNotMatch(text, /cannot read/);
});

test('binaries: 会话工作区里的 tools/ffmpeg/bin 也在候选里', (t) => {
  const home = fixture(t);
  const workspace = join(home, 'ws');
  const path = join(workspace, 'tools', 'ffmpeg', 'bin', 'ffmpeg');
  touch(path);
  assert.equal(resolveMediaBinary('ffmpeg', {
    env: { DSH_HOME: home }, platform: 'linux', cwd: workspace,
  }), path);
});

test('binaries: 装在 Electron 归档里时随包目录指向 .asar.unpacked，其余路径不变', () => {
  assert.equal(unpackedPath('/App.app/Contents/Resources/app.asar/dsh/node_modules/x/vendor/ffmpeg/darwin-arm64'),
    '/App.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/x/vendor/ffmpeg/darwin-arm64');
  assert.equal(unpackedPath('C:\\App\\resources\\app.asar\\dsh\\vendor'), 'C:\\App\\resources\\app.asar.unpacked\\dsh\\vendor');
  assert.equal(unpackedPath('/home/me/proj/vendor/ffmpeg/linux-x64'), '/home/me/proj/vendor/ffmpeg/linux-x64');
  assert.equal(unpackedPath('/data/my.asarish/vendor'), '/data/my.asarish/vendor');
  assert.ok(!vendoredMediaDir().includes('.asar.unpacked'));
});

test('binaries: 托管候选只有随包目录，不受环境变量影响', () => {
  const candidates = hostedMediaCandidates('ffmpeg', { platform: 'win32', arch: 'x64' });
  assert.deepEqual(candidates.map((c) => c.path), [join(vendoredMediaDir('win32', 'x64'), 'ffmpeg.exe')]);
  assert.ok(candidates.every((c) => !c.explicit));
});

test('binaries: 托管时没配置的程序按“随包目录 → PATH”重新解析，报错不提环境变量', () => {
  const undo = useMediaBinaries({ ffprobe: '/opt/ff/ffprobe' });
  try {
    const bundled = hostedMediaCandidates('ffmpeg')[0].path;
    assert.ok([bundled, 'ffmpeg'].includes(binaries.DEFAULT_FFMPEG), `实得 ${binaries.DEFAULT_FFMPEG}`);
    assert.equal(binaries.DEFAULT_FFPROBE, '/opt/ff/ffprobe');
    const text = describeMediaSearch('ffmpeg', { env: { DSH_FFMPEG_PATH: '/elsewhere/ffmpeg' } });
    assert.match(text, /then PATH/);
    assert.doesNotMatch(text, /DSH_FFMPEG_PATH|elsewhere/);
    assert.match(describeMediaSearch('ffprobe'), /\/opt\/ff\/ffprobe \[plugin config\]/);
  } finally {
    undo();
  }
  assert.match(describeMediaSearch('ffmpeg', { env: { DSH_FFMPEG_PATH: '/elsewhere/ffmpeg' } }), /DSH_FFMPEG_PATH/,
    '撤销后回到非托管的搜索说明');
});

test('binaries: 后一次托管设置不被前一次的撤销冲掉，最终恢复到托管之前', () => {
  const before = { ffmpeg: binaries.DEFAULT_FFMPEG, ffprobe: binaries.DEFAULT_FFPROBE };
  const undoA = useMediaBinaries({ ffmpeg: '/a/ffmpeg', ffprobe: '/a/ffprobe' });
  const undoB = useMediaBinaries({ ffmpeg: '/b/ffmpeg', ffprobe: '/b/ffprobe' });
  undoA();
  assert.equal(binaries.DEFAULT_FFMPEG, '/b/ffmpeg');
  assert.equal(binaries.DEFAULT_FFPROBE, '/b/ffprobe');
  undoB();
  assert.deepEqual({ ffmpeg: binaries.DEFAULT_FFMPEG, ffprobe: binaries.DEFAULT_FFPROBE }, before);
});

test('binaries: 模块加载时按 FFMPEG_PATH 解析，托管后不再沿用它', async () => {
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/nonexistent/ffmpeg';
  try {
    const fresh = await import(`../src/storyboard/binaries.js?env=${Date.now()}`);
    assert.equal(fresh.DEFAULT_FFMPEG, '/nonexistent/ffmpeg');
    const undo = fresh.useMediaBinaries({});
    assert.notEqual(fresh.DEFAULT_FFMPEG, '/nonexistent/ffmpeg');
    undo();
    assert.equal(fresh.DEFAULT_FFMPEG, '/nonexistent/ffmpeg');
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
  }
});
