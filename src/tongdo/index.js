/**
 * tongdo/index.js — 通办版插件入口（包的默认导出）。
 *
 * 与上游入口 `src/index.js` 的区别：
 *  - **配置走 Config**：ffmpeg 路径、缓存目录、语音转写由 bundle 配置行下发，
 *    `configureHostRuntime()` 之后上游模块不再读用户的配置文件和 DSH_ASR_* 环境变量。
 *  - **只看本地文件**：链接下载（yt-dlp、cookies）不开放，工具只接受本地路径。
 *  - **不注册设置页**：上游的本机设置网页、设置工具和客户端表单都不挂。
 *  - **纯文本模型降级**：当前模型看不到图片时，请识图模型逐格描述后再交给它（见 vision.js）。
 *
 * 处理逻辑（切点、排布、取帧、清单）全部复用上游 `src/storyboard/` 与 `src/tools/` 的实现。
 */

import { useMediaBinaries } from '../storyboard/binaries.js';
import { configureHostRuntime } from '../storyboard/runtime.js';
import { isHttpUrl } from '../storyboard/url.js';
import * as locate from '../tools/locate.js';
import * as probe from '../tools/probe.js';
import { serviceOf } from '../tools/shared.js';
import * as storyboard from '../tools/storyboard.js';
import * as subtitles from '../tools/subtitles.js';
import * as zoom from '../tools/zoom.js';
import { Config, resolveConfig } from './config.js';
import { locateSpec, probeSpec, storyboardSpec, subtitlesSpec, zoomSpec } from './tool-spec.js';
import { withDescriptionsForTextModel } from './vision.js';

export { Config };

export const name = 'tongdo-video-storyboard';

/**
 * 只硬依赖 `tools`。`attachments`（提交分镜图）、`llm`（判断模型能否看图）、`credentials`
 * （转写密钥）都按可选服务在运行期用 `ctx.get()` 取：宿主缺哪一个，对应能力降级，插件照常加载。
 */
export const inject = ['tools'];

const LINK_REFUSAL = 'video links are not supported: only local video files can be read. Ask the user to '
  + 'download the video and attach the file, then call again with its saved path. Do not download it with other tools.';

/** 拒绝链接输入：上游会对链接调用 yt-dlp，通办不开放这条路。 */
function localOnly(args) {
  if (isHttpUrl(args?.input)) throw new Error(LINK_REFUSAL);
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./config.js').Config} config
 * @returns {Promise<() => void>}
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const { defineTool } = await import('@deepseek-ai/dsh-tools');

  const disposers = [
    useMediaBinaries({ ffmpeg: resolved.ffmpegPath, ffprobe: resolved.ffprobePath }),
    configureHostRuntime({
      cacheDir: resolved.cacheDir,
      mediaDir: resolved.mediaDir,
      transcription: await resolveTranscription(ctx, resolved.transcription),
    }),
  ];

  /** 出图的工具：结果交给纯文本降级处理。 */
  const visual = (spec, run) => defineTool({
    ...spec,
    async execute(args, exec) {
      localOnly(args);
      const value = await run(ctx, args);
      return withDescriptionsForTextModel(
        { llm: serviceOf(ctx, 'llm'), exec, visionModel: resolved.visionModel },
        value,
      );
    },
  });
  /** 只出文字的工具。 */
  const textual = (spec, run) => defineTool({
    ...spec,
    execute(args) {
      localOnly(args);
      return run(ctx, args);
    },
  });

  const tools = [
    textual(probeSpec(), probe.execute),
    visual(storyboardSpec(), storyboard.execute),
    visual(zoomSpec(), zoom.execute),
    textual(locateSpec(), locate.execute),
    visual(subtitlesSpec(), subtitles.execute),
  ];
  for (const tool of tools) disposers.push(ctx.tools.register(tool));

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

/**
 * 解析转写配置里的密钥。密钥经宿主的凭据服务解析，只在插件加载时取一次；
 * 改了密钥需要重新加载插件（修改配置行会自动触发）。
 * @returns {Promise<import('../storyboard/runtime.js').HostTranscription | null>}
 */
async function resolveTranscription(ctx, transcription) {
  if (!transcription) return null;
  const { baseUrl, model, language = 'zh', apiKeyEnv } = transcription;
  let apiKey;
  if (apiKeyEnv) {
    const credentials = serviceOf(ctx, 'credentials');
    if (!credentials) throw new Error('video-storyboard: transcription.apiKeyEnv needs the credentials service');
    apiKey = (await credentials.resolve(apiKeyEnv))?.value;
  }
  return { baseUrl, model, language, ...(apiKey ? { apiKey } : {}) };
}
