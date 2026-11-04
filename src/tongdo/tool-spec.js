/**
 * tongdo/tool-spec.js — 通办版的五个视频工具定义（不含 execute）。
 *
 * 输出结构、超时、并发标记沿用上游 `storyboard/tool-spec.js`；这里只重写两样：
 *  - **参数**：只留办公场景用得到的。链接下载、cookies、清晰度、OCR、档位微调等参数不声明，
 *    宿主会丢弃未声明的参数，上游 handler 取到 undefined 后走默认值。
 *  - **描述**：面向“用户把视频文件丢进对话”的场景，不出现安装、配置、链接相关的说法。
 *
 * 参数说明文案直接复用上游的（语义相同的文案只保留一份）。
 */

import {
  locateToolSpec, probeToolSpec, storyboardToolSpec, subtitlesToolSpec, zoomToolSpec,
} from '../storyboard/tool-spec.js';

const INPUT = {
  type: 'string',
  required: true,
  description: 'Absolute path of a local video file, e.g. the saved path of a video the user attached.',
};

/** 从上游参数表里挑出要保留的参数，`input` 换成通办的说明。 */
function keep(parameters, names) {
  const picked = { input: INPUT };
  for (const name of names) {
    if (!parameters[name]) throw new Error(`video-storyboard: upstream spec has no parameter "${name}"`);
    picked[name] = parameters[name];
  }
  return picked;
}

/** 用通办的描述和参数覆盖上游定义，其余字段（output、timeoutMs、isConcurrencySafe）原样保留。 */
function adapt(upstream, description, names) {
  return { ...upstream, description: description.join('\n'), parameters: keep(upstream.parameters, names) };
}

export function probeSpec() {
  return adapt(probeToolSpec(), [
    'Read a video file\'s metadata without decoding frames: duration, resolution, audio and subtitle tracks,',
    'plus a suggested reading plan. No image cost.',
    '',
    'Call this first when the user gives you a video (mp4, mov, mkv, webm, avi, m4v, flv, wmv, ts …) and you do',
    'not know how long it is. Long videos are read window by window with video_storyboard({ input, from, segment }).',
  ], []);
}

export function storyboardSpec() {
  return adapt(storyboardToolSpec(), [
    'Watch a video: turns it into storyboard images — one frame per shot, numbered cells with time ranges',
    '(cell 7 = 00:12.76-00:31.40) — plus a text index with cuts, loudness and any dialogue. Use it whenever',
    'the user attaches or refers to a video file and asks about its content.',
    '',
    'Cite cells by number in your answer. Need a closer look at one moment? video_zoom({ input, cellId }).',
    'Long video: read it in windows (`from` + `segment`) and follow the "next: from=…" hint; a whole-file',
    'overview only identifies what the video is.',
    '',
    'Cost: each image is ~200-1000 vision tokens and the text index is billed on top. Leave `strategy` unset',
    '(auto picks the cheapest readable layout); `dryRun: true` reports the image count without rendering.',
  ], ['from', 'to', 'segment', 'strategy', 'cutFloor', 'maxFrames', 'dryRun', 'detail', 'cellRange', 'textOnly', 'transcriptFile']);
}

export function zoomSpec() {
  return adapt(zoomToolSpec(), [
    'Re-watch a short stretch of a video at higher resolution: one image with a few large cells, so faces,',
    'small text and on-screen details become legible. Use after video_storyboard, with a cellId from it or an',
    'explicit from/to window (keep it short).',
  ], ['cellId', 'from', 'to', 'maxFrames', 'detail', 'transcriptFile']);
}

export function locateSpec() {
  return adapt(locateToolSpec(), [
    'Find when a phrase is spoken or shown in subtitles: matching transcript lines with timestamps, best first.',
    'Text only, no image cost. Then pass the from/to to video_zoom to see that moment.',
    '',
    'Needs dialogue text: an embedded subtitle track, a transcript file the user supplied (transcriptFile), or',
    'speech-to-text when it is enabled. Reuses what video_storyboard already read for this file.',
  ], ['query', 'from', 'to', 'max', 'transcriptFile']);
}

export function subtitlesSpec() {
  return adapt(subtitlesToolSpec(), [
    'Read burned-in (hard-coded) subtitles: cuts the subtitle band out of frames a few seconds apart and stacks',
    'the strips into ONE tall image in time order, with each strip\'s timestamp in the text.',
    '',
    'Use it when the video shows subtitles on screen but has no subtitle track and the storyboard has no',
    'dialogue — common for screen recordings, lectures and promotional clips. A blank strip means no subtitle',
    'at that moment.',
  ], ['from', 'to', 'maxStrips', 'stepSec', 'band']);
}
