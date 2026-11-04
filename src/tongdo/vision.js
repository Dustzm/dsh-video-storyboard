/**
 * tongdo/vision.js — 当前模型看不到图片时，请识图模型代为看图。
 *
 * 宿主会把发给纯文本模型的图片换成一行占位文字，模型只剩时间索引可读。这里在工具返回前判断
 * 当前路由的模型能不能收图；不能时，用同一 provider 下（或配置指定）的识图模型逐格描述分镜图，
 * 把描述追加到工具结果的文本里。图片块照常保留：界面照样展示，会话日志也完整。
 *
 * 判定规则与 llm 服务内部一致：`inputModalities` 未声明视为能收图（宿主不会替换图片）。
 */

/** 识图描述的输出上限：16 格的分镜逐格写一两句，留足余量。 */
const DESCRIBE_MAX_TOKENS = 4096;

const DESCRIBE_PROMPT = [
  'You are the eyes for a text-only assistant that cannot see images. The images are storyboard sheets cut from',
  'one video: every cell carries a burned-in number, and the index below gives each cell\'s time range. A thin',
  'strip at the bottom of a sheet, if present, is an audio loudness graph — ignore it.',
  '',
  'Describe each numbered cell in order, one line per cell, as "cell N: …". Say who/what is visible, the action,',
  'the setting, and copy any readable on-screen text (titles, subtitles, slides, UI) verbatim in quotes. Be',
  'factual and concise; write "unclear" rather than guess. Do not summarise the video as a whole.',
  '',
  'Index:',
].join('\n');

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
  const modalities = info?.inputModalities;
  return { canSee: modalities === undefined || modalities.includes('image'), route };
}

/**
 * 选一个识图模型：配置优先，否则取当前 provider 目录里第一个声明收图的模型。
 * @returns {Promise<{provider: string, model: string} | null>}
 */
async function pickVisionModel(llm, route, configured) {
  if (configured) return configured;
  const models = await llm.listModels(route.provider);
  const found = models.find((model) => model.inputModalities?.includes('image'));
  return found ? { provider: route.provider, model: found.id } : null;
}

/** 收集一次流式调用的全部文本；失败或中断时抛出宿主给的失败原因。 */
async function collectText(stream) {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(chunk.reason.failure?.message ?? chunk.reason.kind);
    }
  }
  return text.trim();
}

/**
 * 工具结果里有图、而当前模型看不到时，补上识图模型的逐格描述。
 * 当前模型能看图、或结果里没有图时原样返回。
 * @param {{llm: object | null, exec: object | undefined, visionModel: {provider: string, model: string} | null}} env
 * @param {{text: string, images: object[]}} value  工具的规范值
 * @returns {Promise<{text: string, images: object[]}>}
 */
export async function withDescriptionsForTextModel({ llm, exec, visionModel }, value) {
  if (!value.images?.length) return value;
  let vision;
  let route;
  try {
    const current = await currentModelVision(llm, exec);
    if (current.canSee) return value;
    route = current.route;
    vision = await pickVisionModel(llm, route, visionModel);
  } catch (error) {
    // 查不到模型信息时按“能看图”处理：宿主同样只在明确是纯文本模型时才替换图片。
    if (exec?.signal?.aborted) throw error;
    return value;
  }
  const note = (body) => ({ ...value, text: `${value.text}\n\n${body}` });
  if (!vision) {
    return note('<frames-unavailable>The current model cannot see images and no image-capable model is available, '
      + 'so the pictures above were NOT seen. Only the text index (time ranges, cuts, loudness, dialogue) is '
      + 'reliable. Tell the user you cannot see the video frames with the current model and apologise; suggest '
      + 'switching to a model that supports images.</frames-unavailable>');
  }
  try {
    const description = await collectText(llm.stream({
      provider: vision.provider,
      model: vision.model,
      maxTokens: DESCRIBE_MAX_TOKENS,
      signal: exec?.signal,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${DESCRIBE_PROMPT}\n${value.text}` },
          ...value.images.map((attachment) => ({ type: 'image', attachment })),
        ],
      }],
    }));
    return note(`<frames-described-by model="${vision.model}">The current model cannot see images, so an `
      + 'image-capable model looked at the frames and wrote what it saw. Treat this as a second-hand description: '
      + `cite cells by number, and say so if a detail matters and is marked unclear.\n${description}\n`
      + '</frames-described-by>');
  } catch (error) {
    if (exec?.signal?.aborted) throw error;
    return note(`<frames-unavailable>The current model cannot see images, and describing them with ${vision.model} `
      + `failed (${error?.message ?? error}). Only the text index is reliable. Tell the user the video frames could `
      + 'not be read this time and apologise.</frames-unavailable>');
  }
}
