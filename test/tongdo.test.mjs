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
import {
  STORYBOARD_PROFILE, SUBTITLE_PROFILE, describeBudget, withDescriptionsForTextModel,
} from '../src/tongdo/vision.js';
import { SHEET_IN_CONTEXT_LINE, formatForDetail } from '../src/storyboard/format.js';
import { hostRuntime } from '../src/storyboard/runtime.js';
import { resolveAsrConfig } from '../src/storyboard/asr.js';
import { DEFAULT_FFMPEG, DEFAULT_FFPROBE, vendoredMediaDir } from '../src/storyboard/binaries.js';

const SPECS = { probeSpec, storyboardSpec, zoomSpec, locateSpec, subtitlesSpec };

/**
 * 一个作用域：`effect(fn)` 执行 fn 并收下它返回的 disposer，`dispose()` 倒序撤销，模拟插件卸载。
 * 已撤销的作用域里再登记 effect 时抛错，与 cordis 一致。
 */
function fakeScope() {
  const disposers = [];
  let disposed = false;
  return {
    effect(fn) {
      if (disposed) throw new Error('cannot create effect on inactive context');
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    dispose() {
      disposed = true;
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

/**
 * 只记录注册、图片提交与渐进加载声明的宿主上下文。`services` 里给了的服务经 `ctx.get()` 取到；
 * `ctx.inject(deps, fn)` 在依赖都在时开一个子作用域执行 fn，随父作用域一起撤销。
 * 带 `forCaller(inner)` 的服务在子作用域里按调用方绑定，对应 cordis 经调用方上下文访问服务。
 */
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
  const scope = fakeScope();
  const ctx = {
    tools: {
      register(tool) {
        if (registered.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
    get: (name) => all[name],
    effect: (fn) => scope.effect(fn),
    inject(deps, fn) {
      if (!deps.every((dep) => all[dep])) return;
      scope.effect(() => {
        const child = fakeScope();
        const inner = { ...ctx, effect: (body) => child.effect(body) };
        for (const dep of deps) inner[dep] = all[dep].forCaller ? all[dep].forCaller(inner) : all[dep];
        fn(inner);
        return () => child.dispose();
      });
    },
    logger: { warn() {}, error() {} },
  };
  return { registered, saved, ctx, dispose: () => scope.dispose() };
}

/** 假的 toolDisclosure 服务：声明随调用方作用域撤销，与宿主的 `declare()` 一致。 */
function fakeDisclosure() {
  const declared = new Set();
  const calls = [];
  return {
    declared,
    calls,
    forCaller: (caller) => ({
      declare(declaration) {
        calls.push(declaration);
        return caller.effect(() => {
          declared.add(declaration);
          return () => declared.delete(declaration);
        });
      },
    }),
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
    assert.equal(resolved.visionMaxTokens, 8192);
    assert.equal(parsed.visionMaxTokens, 8192);
    assert.equal(resolveConfig({ visionMaxTokens: 2048 }).visionMaxTokens, 2048);
    assert.throws(() => plugin.Config({ visionMaxTokens: 100 }));
    assert.throws(() => resolveConfig({ visionMaxTokens: 1500.5 }), /visionMaxTokens must be an integer in \[1024, 65536\]/);
    assert.throws(() => resolveConfig({ visionMaxTokens: 70000 }), /visionMaxTokens/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('tongdo apply: 注册五个工具、托管运行时；卸载时全部撤销', async () => {
  const before = DEFAULT_FFMPEG;
  const { ctx, registered, dispose } = fakeContext();
  assert.equal(await plugin.apply(ctx, { dataDir: '/tmp/tongdo-video-cache', ffmpegPath: '/opt/ff/ffmpeg' }), undefined,
    'apply 不再自己返回 disposer，撤销交给作用域');
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

test('tongdo apply: 没配 ffmpegPath 时按“随包目录 → PATH”解析，不沿用环境变量解析出的值', async () => {
  const { ctx, dispose } = fakeContext();
  await plugin.apply(ctx, { dataDir: '/tmp/tongdo-video-cache' });
  try {
    const bundled = join(vendoredMediaDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    assert.ok([bundled, 'ffmpeg'].includes(DEFAULT_FFMPEG), `实得 ${DEFAULT_FFMPEG}`);
  } finally {
    dispose();
  }
});

test('tongdo apply: 转写密钥解析失败时整体拒绝，不留下全局状态和工具', async () => {
  const before = DEFAULT_FFMPEG;
  const { ctx, registered, dispose } = fakeContext();
  await assert.rejects(
    plugin.apply(ctx, {
      ffmpegPath: '/opt/ff/ffmpeg',
      transcription: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'm', apiKeyEnv: 'ASR_KEY' },
    }),
    /needs the credentials service/,
  );
  assert.equal(DEFAULT_FFMPEG, before);
  assert.equal(hostRuntime(), null);
  assert.equal(registered.size, 0);
  dispose();
});

test('tongdo apply: 装了渐进加载时把视频工具登记为常驻的视频组，卸载时撤销；没装时不登记', async () => {
  const disclosure = fakeDisclosure();
  const host = fakeContext({ toolDisclosure: disclosure });
  await plugin.apply(host.ctx, { dataDir: '/tmp/tongdo-video-cache' });
  assert.equal(disclosure.calls.length, 1);
  const [declaration] = disclosure.calls;
  assert.equal(declaration.prefix, 'video_');
  assert.equal(declaration.loading, 'resident');
  assert.equal(declaration.group, 'video');
  assert.ok(declaration.label && declaration.summary && declaration.keywords.includes('视频'));
  assert.equal(disclosure.declared.size, 1);
  host.dispose();
  assert.equal(disclosure.declared.size, 0, '插件卸载后声明随之撤销');

  const bare = fakeContext();
  await plugin.apply(bare.ctx, { dataDir: '/tmp/tongdo-video-cache' });
  assert.equal(bare.registered.size, 5, '没装渐进加载时照常注册');
  bare.dispose();
});

/** 识图模型的默认信息：收图，推理档位从低到高。 */
const EYES_INFO = { inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } };

/**
 * 纯文本降级用的假 llm：记录 stream 调用。
 * - `modalities`：当前模型（p/text-model）的输入模态；`currentError` 让查当前模型抛错
 * - `info`：按 `provider/model` 给其他模型的信息，值为 Error 时抛出；没给的按 EYES_INFO
 * - `catalog`、`listError`：listModels 的返回或抛出
 * - `reply`、`finishKind`、`fail`：stream 的默认行为；`replies` 按模型名覆盖
 */
function fakeLlm({
  modalities, currentError = null, info = {}, catalog = [], listError = null,
  reply = 'cell 1: a test card', finishKind = 'stop', fail = null, replies = {},
}) {
  const calls = [];
  return {
    calls,
    async resolveModelInfo(provider, model) {
      if (provider === 'p' && model === 'text-model') {
        if (currentError) throw currentError;
        return modalities === undefined ? {} : { inputModalities: modalities };
      }
      const found = info[`${provider}/${model}`] ?? EYES_INFO;
      if (found instanceof Error) throw found;
      return found;
    },
    async listModels() {
      if (listError) throw listError;
      return catalog;
    },
    async* stream(options) {
      calls.push(options);
      const behaviour = { reply, finishKind, fail, ...replies[options.model] };
      if (behaviour.fail) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: behaviour.fail } } };
        return;
      }
      if (behaviour.reply) yield { type: 'text-delta', index: 0, text: behaviour.reply };
      yield { type: 'finish', reason: { kind: behaviour.finishKind } };
    },
  };
}

/** 记录告警的 logger。 */
function fakeLogger() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message), error() {} };
}

const EXEC = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'text-model' } }) } } };
const VALUE = { text: 'cell 1 = 00:00-00:05', images: [{ attachmentId: 'sha256:abc' }] };
const ENV = { exec: EXEC, visionModel: null, maxTokens: 8192 };
const EYES_CATALOG = [{ id: 'text-model' }, { id: 'eyes', inputModalities: ['text', 'image'] }];
/** 带首行、计划行与三格的清单，末尾是“图已在上下文里”那一行。 */
const MANIFEST = [
  '<storyboard input="clip.mp4" duration="00:12.00">',
  'plan: 3 cells, k=2',
  'cost: ~600 vision tokens',
  'cell 1 = 00:00.00-00:04.00',
  '    "hello"',
  'cell 2 (image 2) = 00:04.00-00:08.00  cuts 1',
  'cell 3 = 00:08.00-00:12.00',
  '</storyboard>',
  SHEET_IN_CONTEXT_LINE,
].join('\n');
const MANIFEST_VALUE = { text: MANIFEST, images: VALUE.images };

test('vision: 当前模型能看图、模态未知或查不到当前模型时原样返回', async () => {
  for (const modalities of [['text', 'image'], undefined]) {
    const llm = fakeLlm({ modalities });
    assert.deepEqual(await withDescriptionsForTextModel({ ...ENV, llm }, VALUE), VALUE);
    assert.equal(llm.calls.length, 0);
  }
  assert.deepEqual(await withDescriptionsForTextModel({ ...ENV, llm: null }, VALUE), VALUE);
  const unknown = fakeLlm({ currentError: new Error('provider "p" is not registered'), catalog: EYES_CATALOG });
  assert.deepEqual(await withDescriptionsForTextModel({ ...ENV, llm: unknown }, VALUE), VALUE);
  assert.equal(unknown.calls.length, 0);
});

test('vision: 纯文本模型时由同路由的识图模型逐格描述，图片块保留', async () => {
  const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG });
  const out = await withDescriptionsForTextModel({ ...ENV, llm }, VALUE);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].model, 'eyes');
  assert.equal(llm.calls[0].provider, 'p');
  assert.deepEqual(llm.calls[0].messages[0].content.filter((b) => b.type === 'image').map((b) => b.attachment), VALUE.images);
  assert.deepEqual(out.images, VALUE.images);
  assert.match(out.text, /<frames-described-by model="eyes">[\s\S]*cell 1: a test card/);
  assert.match(out.text, /cite cells by number/);
});

test('vision: 代看用识图模型最低的推理档位，输出上限按格数计算', async () => {
  const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG });
  await withDescriptionsForTextModel({ ...ENV, llm }, MANIFEST_VALUE);
  assert.equal(llm.calls[0].reasoningEffort, 'off');
  assert.equal(llm.calls[0].maxTokens, 512 + 128 * 3);
  assert.equal(describeBudget(100, 8192), 8192, '格子多时封顶到配置的上限');

  const plain = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, info: { 'p/eyes': { inputModalities: ['image'] } } });
  await withDescriptionsForTextModel({ ...ENV, llm: plain }, VALUE);
  assert.ok(!('reasoningEffort' in plain.calls[0]), '模型没声明推理档位时不传，保持厂商默认');
});

test('vision: 发给识图模型的索引只有首行与格子行；匹配不到格子行时退回全文', async () => {
  const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG });
  await withDescriptionsForTextModel({ ...ENV, llm }, MANIFEST_VALUE);
  const sent = llm.calls[0].messages[0].content[0].text;
  assert.ok(sent.startsWith(STORYBOARD_PROFILE.prompt));
  const index = sent.slice(STORYBOARD_PROFILE.prompt.length + 1).split('\n');
  assert.deepEqual(index, [
    '<storyboard input="clip.mp4" duration="00:12.00">',
    'cell 1 = 00:00.00-00:04.00',
    'cell 2 (image 2) = 00:04.00-00:08.00  cuts 1',
    'cell 3 = 00:08.00-00:12.00',
  ]);

  const odd = { text: 'frames: 00:00 00:05', images: VALUE.images };
  const fallback = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG });
  await withDescriptionsForTextModel({ ...ENV, llm: fallback }, odd);
  assert.ok(fallback.calls[0].messages[0].content[0].text.endsWith(`\n${odd.text}`));
  assert.equal(fallback.calls[0].maxTokens, 512 + 128 * 16, '数不出格子时按每张图 16 格估算');
});

/** 4 张图、64 格、每格长台词的分镜结果：detail high 时清单按字符预算在中途截断。 */
function pagedStoryboard() {
  const sheets = [1, 2, 3, 4].map((sheet) => ({
    sheet, cols: 4, rows: 4, width: 1064, height: 600,
    cells: Array.from({ length: 16 }, (_, k) => {
      const i = (sheet - 1) * 16 + k + 1;
      return { i, sheet, t_start: (i - 1) * 145, t_end: i * 145, text: `#${i} ${'一句很长的台词'.repeat(45)}` };
    }),
  }));
  return {
    info: { path: 'film.mkv', duration: 9280 },
    window: { from: 0, to: 9280, duration: 9280 },
    plan: { sheets: 4, burn: 'index' },
    sheets,
  };
}

test('vision: 清单分页截断或只列一段时，输出上限与索引按图上实际格数', async () => {
  const images = [1, 2, 3, 4].map((n) => ({ attachmentId: `sha256:${n}` }));
  for (const options of [{ detail: 'high' }, { detail: 'med', cellRange: [14, 42] }]) {
    const text = formatForDetail(pagedStoryboard(), options);
    const listed = text.split('\n').filter((line) => /^cell \d+ \(image \d\) = /.test(line)).length;
    assert.ok(listed > 0 && listed < 64, `清单只列了部分格子（${listed}）`);

    const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG });
    await withDescriptionsForTextModel({ ...ENV, llm }, { text, images });
    assert.equal(llm.calls[0].maxTokens, Math.min(8192, 512 + 128 * 64), '按图上的 64 格算，不按列出的格子行');
    const index = llm.calls[0].messages[0].content[0].text.split('\n');
    assert.equal(index.at(-1), `(${64 - listed} of the 64 cells on the images have no time listed here; `
      + 'still describe every numbered cell you can see)');
  }
});

test('vision: 空描述（含只写到上限、只有空白）判失败，部分描述被截断时保留并注明', async () => {
  for (const [reply, finishKind] of [['', 'max-tokens'], ['   ', 'stop']]) {
    const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, reply, finishKind });
    const out = await withDescriptionsForTextModel({ ...ENV, llm }, VALUE);
    assert.doesNotMatch(out.text, /<frames-described-by/);
    assert.match(out.text, /^<frames-unavailable>/);
  }
  const partial = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, reply: 'cell 1: x', finishKind: 'max-tokens' });
  const out = await withDescriptionsForTextModel({ ...ENV, llm: partial }, VALUE);
  assert.match(out.text, /<frames-described-by[\s\S]*cell 1: x[\s\S]*stopped at the output limit: cells after/);
});

test('vision: 配置的识图模型不收图时告警，退到自动挑选的模型', async () => {
  const logger = fakeLogger();
  const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, info: { 'q/pinned': { inputModalities: ['text'] } } });
  const out = await withDescriptionsForTextModel({ ...ENV, llm, logger, visionModel: { provider: 'q', model: 'pinned' } }, VALUE);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /visionModel q\/pinned cannot take images/);
  assert.deepEqual(llm.calls.map((call) => call.model), ['eyes']);
  assert.match(out.text, /<frames-described-by model="eyes">/);
});

test('vision: 配置的识图模型优先；调用失败时用自动挑选的模型重试', async () => {
  const pinned = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG });
  await withDescriptionsForTextModel({ ...ENV, llm: pinned, visionModel: { provider: 'q', model: 'pinned' } }, VALUE);
  assert.deepEqual(pinned.calls.map((call) => [call.provider, call.model]), [['q', 'pinned']]);

  const retry = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, replies: { pinned: { fail: 'quota' } } });
  const out = await withDescriptionsForTextModel({ ...ENV, llm: retry, visionModel: { provider: 'q', model: 'pinned' } }, VALUE);
  assert.deepEqual(retry.calls.map((call) => call.model), ['pinned', 'eyes']);
  assert.match(out.text, /<frames-described-by model="eyes">/);
});

test('vision: 配置的模型就是自动挑选的那个时只请求一次', async () => {
  const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, fail: 'overloaded' });
  const out = await withDescriptionsForTextModel({ ...ENV, llm, visionModel: { provider: 'p', model: 'eyes' } }, VALUE);
  assert.equal(llm.calls.length, 1);
  assert.match(out.text, /^<frames-unavailable>/);
});

test('vision: 全部候选失败时说明放最前、写成终止性措辞，去掉“图已在上下文里”', async () => {
  const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, replies: { pinned: { fail: 'quota' }, eyes: { fail: 'overloaded' } } });
  const out = await withDescriptionsForTextModel({ ...ENV, llm, visionModel: { provider: 'q', model: 'pinned' } }, MANIFEST_VALUE);
  assert.match(out.text, /^<frames-unavailable>/);
  assert.match(out.text, /Do not try to extract/);
  assert.match(out.text, /pinned: quota/);
  assert.match(out.text, /eyes: overloaded/);
  assert.ok(!out.text.includes(SHEET_IN_CONTEXT_LINE));
  assert.doesNotMatch(out.text, /this time/);
  assert.ok(out.text.includes('cell 3 = 00:08.00-00:12.00'), '文字索引照常保留');
  assert.deepEqual(out.images, VALUE.images);
});

test('vision: 列目录失败且没配识图模型时给出失败说明；配了能收图的模型时照常代看', async () => {
  const listError = Object.assign(new Error('catalog is invalid'), { code: 'INVALID_CATALOG' });
  const none = fakeLlm({ modalities: ['text'], listError });
  const out = await withDescriptionsForTextModel({ ...ENV, llm: none }, MANIFEST_VALUE);
  assert.match(out.text, /^<frames-unavailable>[^<]*no image-capable model is available/);
  assert.ok(!out.text.includes(SHEET_IN_CONTEXT_LINE));
  assert.equal(none.calls.length, 0);

  const pinned = fakeLlm({ modalities: ['text'], listError });
  const described = await withDescriptionsForTextModel({ ...ENV, llm: pinned, visionModel: { provider: 'q', model: 'pinned' } }, VALUE);
  assert.match(described.text, /<frames-described-by model="pinned">/);
});

test('vision: 字幕条用逐条抄写的提示词，输出上限按条数计算', async () => {
  const llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, reply: 'strip 1: 你好' });
  const value = {
    text: 'subtitle strip: 5 strips, top to bottom, ~2.0s apart · 00:00.00–00:10.00 · band = bottom\ntimeline: 00:00.00 00:02.00',
    images: VALUE.images,
  };
  const out = await withDescriptionsForTextModel({ ...ENV, llm }, value, SUBTITLE_PROFILE);
  const sent = llm.calls[0].messages[0].content[0].text;
  assert.match(sent, /strip i/);
  assert.doesNotMatch(sent, /every cell carries a burned-in number/);
  assert.ok(sent.endsWith(value.text));
  assert.equal(llm.calls[0].maxTokens, 512 + 128 * 5);
  assert.match(out.text, /cite strips by time[\s\S]*strip 1: 你好/);
});

/** 造测试视频要 lavfi 输入与视频编码器，随包的精简 LGPL 构建没有，所以用 PATH 上的完整 ffmpeg。 */
const FIXTURE_FFMPEG = process.env.FIXTURE_FFMPEG || 'ffmpeg';
/**
 * 打包前核对随包构建：`TONGDO_REQUIRE_BUNDLED_FFMPEG=1` 时 e2e 不再跳过，插件必须用的是随包目录里的
 * ffmpeg / ffprobe，且构建配置是 LGPL（不开 gpl、nonfree、version3）。
 */
const REQUIRE_BUNDLED = process.env.TONGDO_REQUIRE_BUNDLED_FFMPEG === '1';

const runnable = (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;

/** 插件当前用的是随包的 LGPL 构建。 */
function assertBundledLgpl() {
  for (const bin of [DEFAULT_FFMPEG, DEFAULT_FFPROBE]) {
    assert.ok(bin.startsWith(vendoredMediaDir()), `插件应使用随包二进制，实得 ${bin}`);
  }
  const buildconf = execFileSync(DEFAULT_FFMPEG, ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
  assert.doesNotMatch(buildconf, /--enable-(gpl|nonfree|version3)\b/);
  const license = execFileSync(DEFAULT_FFMPEG, ['-hide_banner', '-L'], { encoding: 'utf8' });
  assert.match(license, /Lesser General Public License/);
  assert.match(license, /version 2\.1/);
}

test('tongdo e2e: 本地视频出分镜图，台词说明不含安装指引', async (t) => {
  if (!runnable(FIXTURE_FFMPEG)) {
    if (REQUIRE_BUNDLED) assert.fail(`合成测试素材需要完整的 ffmpeg（FIXTURE_FFMPEG=${FIXTURE_FFMPEG}）`);
    return t.skip('ffmpeg not available');
  }
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
    // 代看用的 llm 可在用例中途替换：先让识图模型全部失败，再让它正常描述。
    let llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, fail: 'overloaded' });
    const { ctx, registered, saved, dispose } = fakeContext({
      llm: {
        resolveModelInfo: (...args) => llm.resolveModelInfo(...args),
        listModels: (...args) => llm.listModels(...args),
        stream: (options) => llm.stream(options),
      },
    });
    await plugin.apply(ctx, { dataDir: join(dir, 'cache') });
    try {
      if (REQUIRE_BUNDLED) assertBundledLgpl();
      else if (!runnable(DEFAULT_FFMPEG)) return t.skip('plugin ffmpeg not available');
      t.diagnostic(`plugin ffmpeg: ${DEFAULT_FFMPEG}`);
      const value = await registered.get('video_storyboard').execute({ input: clip }, {});
      assert.ok(value.images.length >= 1);
      assert.equal(saved[0].mediaType, 'image/png');
      assert.match(value.text, /speech-to-text is not enabled/);
      assert.doesNotMatch(value.text, /sherpa|cookie|docs\/|asr\.json|告诉用户/i);
      assert.doesNotMatch(value.text, /evidence\.json/, '插件不写证据文件，清单里不该提它');
      assert.doesNotMatch(value.text, /Work from the frames/);
      assert.ok(value.text.includes(SHEET_IN_CONTEXT_LINE));

      const probed = await registered.get('video_probe').execute({ input: clip }, {});
      assert.match(probed.text, /duration="8/);
      assert.doesNotMatch(probed.text, /docs\/|SETUP/);

      // 纯文本模型 + 识图模型失败：经 apply 之后的结果同样满足失败说明的约定
      const unseen = await registered.get('video_storyboard').execute({ input: clip }, EXEC);
      assert.match(unseen.text, /^<frames-unavailable>[\s\S]*Do not try to extract/);
      assert.ok(!unseen.text.includes(SHEET_IN_CONTEXT_LINE));
      assert.doesNotMatch(unseen.text, /this time/);
      assert.ok(unseen.images.length >= 1);

      // 字幕条用字幕提示词代看
      llm = fakeLlm({ modalities: ['text'], catalog: EYES_CATALOG, reply: 'strip 1: (blank)' });
      const strips = await registered.get('video_subtitles').execute({ input: clip }, EXEC);
      assert.equal(llm.calls.length, 1);
      assert.ok(llm.calls[0].messages[0].content[0].text.startsWith(SUBTITLE_PROFILE.prompt));
      assert.match(strips.text, /<frames-described-by model="eyes">[\s\S]*strip 1: \(blank\)/);
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
