/**
 * tongdo/config.js — 通办入口的插件配置与解析。
 *
 * 上游靠环境变量和 `$DSH_HOME/video.json`、`asr.json` 配置；通办统一走插件 Config，
 * 在 bundle 的配置行里下发，用户不需要碰任何文件。默认值全部在 `resolveConfig()` 里显式解析。
 */

import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';
import { dshCachePath } from '@deepseek-ai/dsh-home-paths';

/**
 * @typedef {object} TranscriptionConfig
 * @property {string} baseUrl  OpenAI 兼容 `/audio/transcriptions` 服务地址（不含路径尾部）
 * @property {string} model
 * @property {string} [language]  语言提示，默认 zh
 * @property {string} [apiKeyEnv]  密钥的凭据引用名；本机服务可省略
 */

/**
 * @typedef {object} VisionModelConfig
 * @property {string} provider
 * @property {string} model
 */

/**
 * @typedef {object} Config
 * @property {string} [ffmpegPath]  显式 ffmpeg 路径；省略时依次找随包分发的二进制、PATH
 * @property {string} [ffprobePath]  显式 ffprobe 路径；规则同上
 * @property {string} [dataDir]  缓存目录；省略时为 `$DSH_HOME/cache/video-storyboard`
 * @property {TranscriptionConfig} [transcription]  语音转写服务；省略时不转写
 * @property {VisionModelConfig} [visionModel]  纯文本模型看图时代看的识图模型；省略时从当前路由自动挑选
 */

export const Config = z.object({
  ffmpegPath: z.string().description('ffmpeg 可执行文件路径；留空时使用随安装包分发的版本，再找系统 PATH。'),
  ffprobePath: z.string().description('ffprobe 可执行文件路径；留空规则同 ffmpegPath。'),
  dataDir: z.string().description('扫描与转写缓存目录；留空时放在数据目录的 cache/video-storyboard 下。'),
  transcription: z.object({
    baseUrl: z.string().description('OpenAI 兼容的语音转写服务地址，如 https://example.com/v1。'),
    model: z.string(),
    language: z.string(),
    apiKeyEnv: z.string().role('credential-ref').description('转写服务密钥的凭据引用名；本机服务可留空。'),
  }).description('语音转写服务；不配置时只看画面、读内嵌字幕，不转写台词。'),
  visionModel: z.object({
    provider: z.string(),
    model: z.string(),
  }).description('当前模型看不到图片时，代为看图的识图模型；不配置时从当前模型所在路由自动挑选。'),
});

/**
 * @typedef {object} ResolvedConfig
 * @property {string | undefined} ffmpegPath
 * @property {string | undefined} ffprobePath
 * @property {string} cacheDir
 * @property {string} mediaDir
 * @property {TranscriptionConfig | null} transcription
 * @property {VisionModelConfig | null} visionModel
 */

const blankToUndefined = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/**
 * 解析默认值，并在注册前拒绝自洽的配置错误。
 * @param {Partial<Config>} [config]
 * @returns {ResolvedConfig}
 */
export function resolveConfig(config = {}) {
  const cacheDir = blankToUndefined(config.dataDir) ?? dshCachePath('video-storyboard');
  return {
    ffmpegPath: blankToUndefined(config.ffmpegPath),
    ffprobePath: blankToUndefined(config.ffprobePath),
    cacheDir,
    mediaDir: join(cacheDir, 'media'),
    transcription: resolveTranscription(config.transcription),
    visionModel: resolveVisionModel(config.visionModel),
  };
}

/**
 * 配置未填的嵌套对象会被 schemastery 补成 `{}`：字段全空视为未配置，只填一部分视为配置错误。
 * @returns {TranscriptionConfig | null}
 */
function resolveTranscription(raw = {}) {
  const baseUrl = blankToUndefined(raw.baseUrl);
  const model = blankToUndefined(raw.model);
  const apiKeyEnv = blankToUndefined(raw.apiKeyEnv);
  if (!baseUrl && !model && !apiKeyEnv) return null;
  if (!baseUrl || !model) throw new Error('video-storyboard: transcription needs both baseUrl and model');
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password) throw new Error('credentials in URL');
  } catch {
    throw new Error('video-storyboard: transcription.baseUrl must be an absolute URL without credentials');
  }
  return { baseUrl, model, language: blankToUndefined(raw.language) ?? 'zh', ...(apiKeyEnv ? { apiKeyEnv } : {}) };
}

/** @returns {VisionModelConfig | null} */
function resolveVisionModel(raw = {}) {
  const provider = blankToUndefined(raw.provider);
  const model = blankToUndefined(raw.model);
  if (!provider && !model) return null;
  if (!provider || !model) throw new Error('video-storyboard: visionModel needs both provider and model');
  return { provider, model };
}
