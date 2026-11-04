/**
 * runtime.js — 宿主托管的运行时设置（通办衍生）。
 *
 * 上游插件的配置散在环境变量和 `$DSH_HOME/video.json`、`asr.json` 里，靠用户手改。
 * 产品宿主（通办）用插件 Config 统一下发这些值：插件入口在 apply 时调用
 * `configureHostRuntime()`，之后各模块读配置的入口（user-config / asr / format）
 * 先看这里，**宿主托管时不再读用户的配置文件和 DSH_ASR_* 环境变量**。
 *
 * 没有调用过 `configureHostRuntime()`（CLI、上游 DSH 入口）时 `hostRuntime()` 返回 null，
 * 所有模块的行为与上游完全一致。
 *
 * 每个进程只有一个插件实例持有它：apply 设置、dispose 时用返回的函数撤销。
 */

/**
 * @typedef {object} HostTranscription
 * @property {string} baseUrl  OpenAI 兼容 `/audio/transcriptions` 服务地址
 * @property {string} model
 * @property {string} language
 * @property {string} [apiKey]  已解析的密钥；本机服务可省略
 */

/**
 * @typedef {object} HostRuntime
 * @property {string} cacheDir  扫描、转写缓存与“看过”记录的目录
 * @property {string} mediaDir  下载媒体的目录（宿主关闭链接输入时也保留，供上游模块解析路径）
 * @property {HostTranscription | null} transcription  null = 宿主没有配置语音转写
 */

/** @type {Readonly<HostRuntime> | null} */
let current = null;

/**
 * 设置宿主托管的运行时。
 * @param {HostRuntime} settings
 * @returns {() => void} 撤销：只在当前值仍是本次设置的那份时清空
 */
export function configureHostRuntime(settings) {
  const frozen = Object.freeze({
    ...settings,
    transcription: settings.transcription ? Object.freeze({ ...settings.transcription }) : null,
  });
  current = frozen;
  return () => {
    if (current === frozen) current = null;
  };
}

/** 当前宿主托管的设置；未托管时为 null。 */
export function hostRuntime() {
  return current;
}
