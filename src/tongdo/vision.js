/**
 * tongdo/vision.js — 当前模型看不到图片时，请识图模型代为看图。
 *
 * 宿主会把发给纯文本模型的图片换成一行占位文字，模型只剩时间索引可读。这里在工具返回前判断
 * 当前路由的模型能不能收图；不能时，依次请候选识图模型（配置指定的、同一 provider 下自动挑选的）
 * 描述图片，第一个写出描述的为准，把描述追加到工具结果的文本里。图片块照常保留：界面照样展示，
 * 会话日志也完整。全部候选都失败时，把失败说明放在结果最前面，让模型直接如实告诉用户。
 *
 * 判定规则与 llm 服务内部一致：`inputModalities` 未声明视为能收图（宿主不会替换图片）。
 */

import { SHEET_IN_CONTEXT_LINE } from '../storyboard/format.js';

/**
 * 输出上限 = 基础 + 每个单位（格子或字幕条）一行的预算，再封顶到配置的上限。
 * 两个常量和提示词的“每格一行”绑定，是算法常量，不做成配置。
 */
const BASE_TOKENS = 512;
const TOKENS_PER_UNIT = 128;

/**
 * 一次代看描述的输出上限。
 * @param {number} units  要描述的格子或字幕条数
 * @param {number} ceiling  配置的上限（`visionMaxTokens`）
 */
export function describeBudget(units, ceiling) {
  return Math.min(ceiling, BASE_TOKENS + TOKENS_PER_UNIT * units);
}

/** 清单里的格子行：`cell 7 = …`，多张图时是 `cell 7 (image 2) = …`。 */
const CELL_LINE = /^cell \d+(?: \(image \d+\))? = /;
/** 识图模型数不出格子数时，按每张分镜图 16 格估算。 */
const CELLS_PER_SHEET = 16;
/** 字幕工具的条数行：`subtitle strip: 12 strips, …`；解析不到时按 24 条估算。 */
const STRIP_COUNT = /subtitle strip: (\d+) strips/;
const DEFAULT_STRIPS = 24;

/** 首行的 `grid="64 frames on 4 image(s)"`：图上实际的格数。 */
const GRID_FRAMES = /\bgrid="(\d+) frames on /;

const cellLines = (text) => text.split('\n').filter((line) => CELL_LINE.test(line));
const headerLine = (text) => text.split('\n').find((line) => line.startsWith('<storyboard'));

/**
 * 图上一共几格。清单按字符预算分页截断、或用 cellRange 只列一段时，格子行比图上的格子少，
 * 但图片照样整张提交，识图模型要描述的是图上全部格子，所以以首行的 grid 为准。
 * 首行解析不到时返回 0，由调用方退回去数格子行。
 */
const gridFrames = (text) => Number(GRID_FRAMES.exec(headerLine(text) ?? '')?.[1] ?? 0);

/**
 * 发给识图模型的索引：只留 `<storyboard …>` 首行与每格的时间行，去掉计划、费用、台词这些它用不到的行。
 * 清单只列了一部分格子时补一行说明，免得识图模型只描述列出来的那些。
 * 上游格式变了、一行都匹配不到时退回全文，宁可多花 token 也不让识图模型拿不到编号。
 */
function storyboardIndex(text) {
  const cells = cellLines(text);
  if (cells.length === 0) return text;
  const header = headerLine(text);
  const unlisted = gridFrames(text) - cells.length;
  const note = unlisted > 0
    ? [`(${unlisted} of the ${cells.length + unlisted} cells on the images have no time listed here; `
      + 'still describe every numbered cell you can see)']
    : [];
  return [...(header ? [header] : []), ...cells, ...note].join('\n');
}

/**
 * @typedef {object} DescribeProfile  一类图片的代看方式
 * @property {string} prompt  给识图模型的指令，末尾接索引
 * @property {'cells' | 'strips'} noun  描述的单位，用在交给当前模型的引导语里
 * @property {string} cite  当前模型引用描述时的方式
 * @property {string} closer  想看得更细时该调的工具，代替用 shell 或 ffmpeg 自己去读帧
 * @property {(text: string) => string} index  从工具结果文本里取出给识图模型的索引
 * @property {(value: {text: string, images: object[]}) => number} units  要描述的单位数，决定输出上限
 */

/** 分镜图（video_storyboard、video_zoom）：逐格描述。 */
export const STORYBOARD_PROFILE = {
  prompt: [
    'You are the eyes for a text-only assistant that cannot see images. The images are storyboard sheets cut from',
    'one video: every cell carries a burned-in number, and the index below gives each cell\'s time range. A thin',
    'strip at the bottom of a sheet, if present, is an audio loudness graph — ignore it.',
    '',
    'Describe each numbered cell in order, one line per cell, as "cell N: …". Say who/what is visible, the action,',
    'the setting, and copy any readable on-screen text (titles, subtitles, slides, UI) verbatim in quotes. Be',
    'factual and concise; write "unclear" rather than guess. Do not summarise the video as a whole.',
    '',
    'Index:',
  ].join('\n'),
  noun: 'cells',
  cite: 'cite cells by number',
  closer: 'call video_zoom on that moment',
  index: storyboardIndex,
  units: (value) => gridFrames(value.text) || cellLines(value.text).length || CELLS_PER_SHEET * value.images.length,
};

/** 字幕条拼图（video_subtitles）：逐条照抄屏幕字幕。 */
export const SUBTITLE_PROFILE = {
  prompt: [
    'You are the eyes for a text-only assistant that cannot see images. The image is ONE tall picture of horizontal',
    'subtitle strips cut from a video, stacked top to bottom in time order; the timeline below gives each strip\'s',
    'time. Transcribe every strip in order, one line per strip, as "strip i: <text>", copying the on-screen',
    'subtitle verbatim in its original language. Write "(blank)" when a strip has no subtitle and "unclear" when it',
    'cannot be read. Do not translate or summarise.',
    '',
    'Timeline:',
  ].join('\n'),
  noun: 'strips',
  cite: 'cite strips by time',
  closer: 'call video_subtitles again on a shorter window',
  // 字幕工具的文字部分只有三行，原样给出即可。
  index: (text) => text,
  units: (value) => Number(STRIP_COUNT.exec(value.text)?.[1] ?? DEFAULT_STRIPS),
};

const acceptsImages = (info) => info?.inputModalities === undefined || info.inputModalities.includes('image');

/**
 * 当前请求所用模型能不能收图。
 * @param {object} llm  宿主 `llm` 服务
 * @param {object | undefined} exec  工具运行上下文（ToolRunContext）
 * @returns {Promise<{canSee: boolean, route?: {provider: string, model: string}}>}
 */
export async function currentModelVision(llm, exec) {
  const route = exec?.agent?.session?.requestHeader?.()?.config;
  if (!llm || !route?.provider || !route?.model) return { canSee: true };
  const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal);
  return { canSee: acceptsImages(info), route };
}

/**
 * 依次给出代看候选：先是配置的识图模型（核对过能收图），再是当前 provider 目录里第一个收图的模型。
 * 惰性求值：前一个候选描述成功就不再列目录。每个来源各自出错时告警并跳过，不影响另一个。
 * @param {{llm: object, route: {provider: string}, configured: {provider: string, model: string} | null,
 *   logger?: object, signal?: AbortSignal}} options
 * @returns {AsyncGenerator<{provider: string, model: string, info?: object}>}
 */
async function* visionCandidates({ llm, route, configured, logger, signal }) {
  if (configured) {
    const { provider, model } = configured;
    let info;
    let reason = null;
    try {
      info = await llm.resolveModelInfo(provider, model, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      reason = error?.message ?? String(error);
    }
    if (reason === null && !acceptsImages(info)) reason = 'it does not accept image input';
    if (reason === null) yield { provider, model, info };
    else {
      logger?.warn?.(`[video-storyboard] visionModel ${provider}/${model} cannot take images (${reason}); `
        + 'falling back to an image model on the current route');
    }
  }
  let models;
  try {
    models = await llm.listModels(route.provider);
  } catch (error) {
    if (signal?.aborted) throw error;
    logger?.warn?.(`[video-storyboard] cannot list models of ${route.provider} (${error?.message ?? error}); `
      + 'no image model picked automatically');
    return;
  }
  const isConfigured = (id) => configured?.provider === route.provider && configured.model === id;
  const found = models.find((entry) => entry.inputModalities?.includes('image') && !isConfigured(entry.id));
  if (found) yield { provider: route.provider, model: found.id };
}

/**
 * 收集一次流式调用的全部文本；`truncated` 表示停在了输出上限。失败或中断时抛出宿主给的失败原因。
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function collectText(stream) {
  let text = '';
  let truncated = false;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') truncated = true;
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(chunk.reason.failure?.message ?? chunk.reason.kind);
    }
  }
  return { text: text.trim(), truncated };
}

/**
 * 请一个候选模型描述图片。推理强度取该模型最低的一档（代看是照着图写，不需要推理），
 * 模型没声明推理档位时不传，保持厂商默认。没写出任何正文时抛错，交给下一个候选。
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function describeWith(llm, candidate, profile, value, ceiling, signal) {
  const info = candidate.info ?? await llm.resolveModelInfo(candidate.provider, candidate.model, signal);
  const effort = info?.reasoning?.efforts?.[0]?.id;
  const described = await collectText(llm.stream({
    provider: candidate.provider,
    model: candidate.model,
    ...(effort ? { reasoningEffort: effort } : {}),
    maxTokens: describeBudget(profile.units(value), ceiling),
    signal,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${profile.prompt}\n${profile.index(value.text)}` },
        ...value.images.map((attachment) => ({ type: 'image', attachment })),
      ],
    }],
  }));
  if (described.text === '') {
    throw new Error(described.truncated
      ? 'the image model used up its output limit before writing any description'
      : 'the image model returned an empty description');
  }
  return described;
}

/**
 * 全部候选都失败时的结果：说明放在最前面、写成终止性措辞，并去掉“图已在上下文里”那一行，
 * 免得模型以为自己看过图、转而用 shell 抽帧或 OCR。结果仍是成功：图片与文字索引照常有效。
 */
function unavailable(value, reasons) {
  const text = value.text.replace(`\n${SHEET_IN_CONTEXT_LINE}`, '');
  return {
    ...value,
    text: `<frames-unavailable>The current model cannot see images and the frames could not be described (${reasons}). `
      + 'The pictures were NOT seen. Do not try to extract, OCR or inspect frames with shell or any other tool. '
      + 'Reply to the user now: say you could not see the video frames, give only what the text index below '
      + 'supports, apologise, and suggest switching to a model that supports images.</frames-unavailable>\n\n'
      + text,
  };
}

/**
 * 工具结果里有图、而当前模型看不到时，补上识图模型的描述。
 * 当前模型能看图、查不到当前模型的信息、或结果里没有图时原样返回。
 * @param {{llm: object | null, exec: object | undefined, visionModel: {provider: string, model: string} | null,
 *   maxTokens: number, logger?: object}} env  `maxTokens` 是配置的输出上限（`visionMaxTokens`）
 * @param {{text: string, images: object[]}} value  工具的规范值
 * @param {DescribeProfile} [profile]  图片的代看方式，默认按分镜图
 * @returns {Promise<{text: string, images: object[]}>}
 */
export async function withDescriptionsForTextModel(
  { llm, exec, visionModel, maxTokens, logger },
  value,
  profile = STORYBOARD_PROFILE,
) {
  if (!value.images?.length) return value;
  let current;
  try {
    current = await currentModelVision(llm, exec);
  } catch (error) {
    // 查不到当前模型的信息（provider 未注册、目录解析失败）时按能看图处理：
    // 宿主同样只在明确是纯文本模型时才替换图片，这时图片会原样送到模型。
    if (exec?.signal?.aborted) throw error;
    return value;
  }
  if (current.canSee) return value;

  const signal = exec?.signal;
  const reasons = [];
  for await (const candidate of visionCandidates({
    llm, route: current.route, configured: visionModel, logger, signal,
  })) {
    let described;
    try {
      described = await describeWith(llm, candidate, profile, value, maxTokens, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      reasons.push(`${candidate.model}: ${error?.message ?? error}`);
      continue;
    }
    const stopped = described.truncated
      ? `\n(description stopped at the output limit: ${profile.noun} after the last one listed above were not described)`
      : '';
    return {
      ...value,
      text: `${value.text}\n\n<frames-described-by model="${candidate.model}">The current model cannot see images, `
        + 'so an image-capable model looked at the frames and wrote what it saw. Treat this as a second-hand '
        + `description: ${profile.cite}, and say so if a detail matters and is marked unclear. Answer from this `
        + 'description and the text index; do not check it by sampling pixels, extracting or OCR-ing frames with '
        + `shell or ffmpeg. For a closer look, ${profile.closer}: it is described the same way.\n`
        + `${described.text}${stopped}\n</frames-described-by>`,
    };
  }
  return unavailable(value, reasons.length ? reasons.join('; ') : 'no image-capable model is available');
}
