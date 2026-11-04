/**
 * tongdo.test.mjs — 通办入口（src/tongdo/）的行为：工具定义、配置、宿主托管、纯文本模型降级。
 *
 * 用宿主真实的 `defineTool`（devDependencies 里的 @deepseek-ai/dsh-tools）编译工具定义；
 * 端到端用 ffmpeg 现场合成的视频，不用任何第三方素材。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import * as plugin from '../src/tongdo/index.js';
import { resolveConfig } from '../src/tongdo/config.js';
import { locateSpec, probeSpec, storyboardSpec, subtitlesSpec, zoomSpec } from '../src/tongdo/tool-spec.js';
import { withDescriptionsForTextModel } from '../src/tongdo/vision.js';
import { hostRuntime } from '../src/storyboard/runtime.js';
import { resolveAsrConfig } from '../src/storyboard/asr.js';
import { DEFAULT_FFMPEG } from '../src/storyboard/binaries.js';

const SPECS = { probeSpec, storyboardSpec, zoomSpec, locateSpec, subtitlesSpec };

/** 只记录注册与图片提交的宿主上下文。 */
function fakeContext(services = {}) {
  const registered = new Map();
  const saved = [];
  const all = {
    attachments: {
      async saveImage(input) {
        saved.push(input);
        return { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType: input.mediaType, width: 1, height: 1 };
      },
    },
    ...services,
  };
  return {
    registered,
    saved,
    ctx: {
      tools: {
        register(tool) {
          registered.set(tool.name, tool);
          return () => registered.delete(tool.name);
        },
      },
      get: (name) => all[name],
      logger: { warn() {}, error() {} },
    },
  };
}

test('tongdo specs: 宿主 defineTool 接受全部五个工具，且不暴露链接与设置相关参数', () => {
  const names = [];
  for (const [key, make] of Object.entries(SPECS)) {
    const tool = defineTool({ ...make(), execute: async () => ({ text: '' }) });
    names.push(tool.name);
    const props = Object.keys(tool.parameters.properties);
    assert.ok(props.includes('input'), `${key} 必须有 input`);
    for (const banned of ['cookies', 'allowAnonymous', 'quality', 'scanHeight', 'zoomHeight', 'ocr', 'sourceHash']) {
      assert.ok(!props.includes(banned), `${key} 不应声明 ${banned}`);
    }
    assert.doesNotMatch(tool.description, /cookie|yt-dlp|docs\/|DSH_|install/i, `${key} 描述不应出现安装与链接说法`);
  }
  assert.deepEqual(names, ['video_probe', 'video_storyboard', 'video_zoom', 'video_locate', 'video_subtitles']);
});

test('tongdo specs: 链接会被拒收的说法写进 input 与 probe、storyboard 的描述；分镜不再说一镜一帧', () => {
  for (const make of Object.values(SPECS)) assert.match(make().parameters.input.description, /links are refused/);
  for (const make of [probeSpec, storyboardSpec]) assert.match(make().description, /do not download/);
  const storyboard = storyboardSpec().description;
  assert.doesNotMatch(storyboard, /one frame per shot/);
  assert.match(storyboard, /a cell can span a cut/);
  assert.match(storyboard, /text index is authoritative/);
});

test('tongdo config: 默认缓存在数据目录下，转写地址带凭据时拒绝', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/tongdo-home';
  try {
    const resolved = resolveConfig({});
    assert.equal(resolved.cacheDir, join('/tmp/tongdo-home', 'cache', 'video-storyboard'));
    assert.equal(resolved.mediaDir, join(resolved.cacheDir, 'media'));
    assert.equal(resolved.transcription, null);
    assert.equal(resolved.ffmpegPath, undefined);
    assert.equal(resolveConfig({ dataDir: '/data/v', ffmpegPath: '  ' }).cacheDir, '/data/v');
    // 经 schemastery 解析后，未填的嵌套对象是 {}，必须视为未配置
    const parsed = resolveConfig(plugin.Config({}));
    assert.equal(parsed.transcription, null);
    assert.equal(parsed.visionModel, null);
    assert.deepEqual(resolveConfig(plugin.Config({ transcription: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'm' } })).transcription,
      { baseUrl: 'http://127.0.0.1:8000/v1', model: 'm', language: 'zh' });
    assert.throws(() => resolveConfig({ transcription: { model: 'm' } }), /both baseUrl and model/);
    assert.throws(() => resolveConfig({ visionModel: { provider: 'p' } }), /both provider and model/);
    assert.throws(() => resolveConfig({ transcription: { baseUrl: 'https://u:p@asr.example/v1', model: 'm' } }), /without credentials/);
    assert.throws(() => resolveConfig({ transcription: { baseUrl: 'not a url', model: 'm' } }), /absolute URL/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('tongdo apply: 注册五个工具、托管运行时；dispose 全部撤销', async () => {
  const before = DEFAULT_FFMPEG;
  const { ctx, registered } = fakeContext();
  const dispose = await plugin.apply(ctx, { dataDir: '/tmp/tongdo-video-cache', ffmpegPath: '/opt/ff/ffmpeg' });
  try {
    assert.equal(registered.size, 5);
    assert.equal(hostRuntime()?.cacheDir, '/tmp/tongdo-video-cache');
    assert.equal(DEFAULT_FFMPEG, '/opt/ff/ffmpeg');
    const asr = resolveAsrConfig();
    assert.equal(asr.enabled, false, '没配转写时宿主托管的 ASR 必须是关闭的');
    for (const name of ['video_storyboard', 'video_probe']) {
      await assert.rejects(
        registered.get(name).execute({ input: 'https://example.com/v.mp4' }, {}),
        /only local video files[\s\S]*Do not download it with other tools/,
      );
    }
  } finally {
    dispose();
  }
  assert.equal(registered.size, 0);
  assert.equal(hostRuntime(), null);
  assert.equal(DEFAULT_FFMPEG, before);
});

/** 纯文本降级用的假 llm：记录 stream 调用。 */
function fakeLlm({ modalities, catalog = [], reply = 'cell 1: a test card', fail = null }) {
  const calls = [];
  return {
    calls,
    async resolveModelInfo() { return modalities === undefined ? {} : { inputModalities: modalities }; },
    async listModels() { return catalog; },
    async* stream(options) {
      calls.push(options);
      if (fail) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: fail } } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const EXEC = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'text-model' } }) } } };
const VALUE = { text: 'cell 1 = 00:00-00:05', images: [{ attachmentId: 'sha256:abc' }] };

test('vision: 当前模型能看图或模态未知时原样返回', async () => {
  for (const modalities of [['text', 'image'], undefined]) {
    const llm = fakeLlm({ modalities });
    assert.deepEqual(await withDescriptionsForTextModel({ llm, exec: EXEC, visionModel: null }, VALUE), VALUE);
    assert.equal(llm.calls.length, 0);
  }
  assert.deepEqual(await withDescriptionsForTextModel({ llm: null, exec: EXEC, visionModel: null }, VALUE), VALUE);
});

test('vision: 纯文本模型时由同路由的识图模型逐格描述，图片块保留', async () => {
  const llm = fakeLlm({ modalities: ['text'], catalog: [{ id: 'text-model' }, { id: 'eyes', inputModalities: ['text', 'image'] }] });
  const out = await withDescriptionsForTextModel({ llm, exec: EXEC, visionModel: null }, VALUE);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].model, 'eyes');
  assert.equal(llm.calls[0].provider, 'p');
  assert.deepEqual(llm.calls[0].messages[0].content.filter((b) => b.type === 'image').map((b) => b.attachment), VALUE.images);
  assert.deepEqual(out.images, VALUE.images);
  assert.match(out.text, /<frames-described-by model="eyes">[\s\S]*cell 1: a test card/);
});

test('vision: 配置的识图模型优先；没有可用识图模型或调用失败时让模型如实说明', async () => {
  const configured = fakeLlm({ modalities: ['text'], catalog: [{ id: 'eyes', inputModalities: ['image'] }] });
  await withDescriptionsForTextModel({ llm: configured, exec: EXEC, visionModel: { provider: 'q', model: 'pinned' } }, VALUE);
  assert.deepEqual([configured.calls[0].provider, configured.calls[0].model], ['q', 'pinned']);

  const none = await withDescriptionsForTextModel({ llm: fakeLlm({ modalities: ['text'], catalog: [{ id: 'x' }] }), exec: EXEC, visionModel: null }, VALUE);
  assert.match(none.text, /<frames-unavailable>[\s\S]*apologise/);

  const failed = await withDescriptionsForTextModel({
    llm: fakeLlm({ modalities: ['text'], catalog: [{ id: 'eyes', inputModalities: ['image'] }], fail: 'quota' }),
    exec: EXEC, visionModel: null,
  }, VALUE);
  assert.match(failed.text, /<frames-unavailable>[\s\S]*quota/);
});

/** 造测试视频要 lavfi 输入与视频编码器，随包的精简 LGPL 构建没有，所以用 PATH 上的完整 ffmpeg。 */
const FIXTURE_FFMPEG = process.env.FIXTURE_FFMPEG || 'ffmpeg';

test('tongdo e2e: 本地视频出分镜图，台词说明不含安装指引', async (t) => {
  try {
    execFileSync(FIXTURE_FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(DEFAULT_FFMPEG, ['-version'], { stdio: 'ignore' });
  } catch {
    return t.skip('ffmpeg not available');
  }
  t.diagnostic(`plugin ffmpeg: ${DEFAULT_FFMPEG}`);
  const dir = mkdtempSync(join(tmpdir(), 'tongdo-video-'));
  try {
    const clip = join(dir, 'clip.mp4');
    execFileSync(FIXTURE_FFMPEG, [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=d=4:s=320x180:r=25',
      '-f', 'lavfi', '-i', 'smptebars=d=4:s=320x180:r=25',
      '-f', 'lavfi', '-i', 'sine=f=440:d=8',
      '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2', '-shortest', clip,
    ]);
    const { ctx, registered, saved } = fakeContext();
    const dispose = await plugin.apply(ctx, { dataDir: join(dir, 'cache') });
    try {
      const value = await registered.get('video_storyboard').execute({ input: clip }, {});
      assert.ok(value.images.length >= 1);
      assert.equal(saved[0].mediaType, 'image/png');
      assert.match(value.text, /speech-to-text is not enabled/);
      assert.doesNotMatch(value.text, /sherpa|cookie|docs\/|asr\.json|告诉用户/i);
      assert.doesNotMatch(value.text, /evidence\.json/, '插件不写证据文件，清单里不该提它');
      assert.doesNotMatch(value.text, /Work from the frames/);

      const probed = await registered.get('video_probe').execute({ input: clip }, {});
      assert.match(probed.text, /duration="8/);
      assert.doesNotMatch(probed.text, /docs\/|SETUP/);
    } finally {
      dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch-ffmpeg: 目标没登记构建时打包失败，不静默缺 ffmpeg', () => {
  const sources = JSON.parse(readFileSync(new URL('../scripts/ffmpeg-sources.json', import.meta.url), 'utf8'));
  const script = fileURLToPath(new URL('../scripts/fetch-ffmpeg.mjs', import.meta.url));
  const missing = Object.entries({ 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64', 'win-x64': 'win32-x64' })
    .find(([, dir]) => !sources.sha256[dir]);
  const usage = spawnSync(process.execPath, [script, 'linux-x64'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  if (!missing) return;
  const result = spawnSync(process.execPath, [script, missing[0]], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no ffmpeg build recorded/);
});
