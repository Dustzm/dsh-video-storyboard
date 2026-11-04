#!/usr/bin/env node
/**
 * guard-publish.mjs — `npm publish` 前的一道闸门。
 *
 * 为什么需要它：`npm pack/publish` 打包的是**磁盘上的工作区**，跟 git 提交完全无关。
 * 0.5.11 就是在这个误解下发的 —— 工作区里留着别人未提交的改动，一起被打进了包里。
 * 现在反过来：**只要工作区不干净，就拒绝发布**。想发就先 commit（或 stash）到干净状态，
 * 这样"发出去的"和"仓库里的"永远是同一份东西。
 *
 * 第二道检查（通办衍生）：相对上游镜像 `master` 被修改过的 .js/.mjs 文件，文件头前
 * 30 行必须带 `Modified by Tongdo` 声明（Apache-2.0 第 4(b) 条：被修改的文件要带显著
 * 声明）。取不到 `master`（例如浅克隆）时只告警、不阻塞。
 *
 * 直接跑：`node scripts/guard-publish.mjs`（只看状态，不发包）。
 *
 * Modified by Tongdo; see TONGDO_CHANGES.md.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let dirty;
try {
  dirty = git(['status', '--porcelain']);
} catch (e) {
  console.error(`guard-publish: 读不到 git 状态（${e.message.split('\n')[0]}）—— 跳过检查`);
  process.exit(0);
}

if (dirty) {
  const lines = dirty.split('\n');
  const show = lines.slice(0, 12).map((l) => `  ${l}`).join('\n');
  console.error([
    '',
    '✗ 拒绝发布：工作区有未提交的改动。',
    '',
    '  npm publish 打包的是**磁盘文件**，不是 git 提交 —— 这些改动会被原样发出去。',
    `  当前 ${lines.length} 处：`,
    show,
    lines.length > 12 ? `  …（还有 ${lines.length - 12} 处）` : '',
    '',
    '  想发布：先 git add / git commit（或 git stash）到干净状态，再重跑。',
    '',
  ].filter(Boolean).join('\n'));
  process.exit(1);
}

/** 声明必须出现在文件头的这么多行之内，放进正文里不算“显著”。 */
const NOTICE_LINES = 30;
const NOTICE = /Modified by Tongdo/;

let base;
try {
  base = git(['merge-base', 'HEAD', 'master']);
} catch (e) {
  console.warn(`guard-publish: 找不到上游镜像 master（${e.message.split('\n')[0]}）—— 跳过修改声明检查`);
}

if (base) {
  const root = git(['rev-parse', '--show-toplevel']);
  const modified = git(['diff', '--name-only', '--diff-filter=M', base, 'HEAD', '--', '*.js', '*.mjs'])
    .split('\n').filter(Boolean);
  const missing = modified.filter((file) => {
    const head = readFileSync(join(root, file), 'utf8').split('\n').slice(0, NOTICE_LINES).join('\n');
    return !NOTICE.test(head);
  });
  if (missing.length) {
    console.error([
      '',
      '✗ 拒绝发布：这些上游文件改过，但文件头没有修改声明：',
      ...missing.map((file) => `  ${file}`),
      '',
      '  在文件头注释末尾加一行 `Modified by Tongdo; see TONGDO_CHANGES.md.`，并在 TONGDO_CHANGES.md 登记改动。',
      '',
    ].join('\n'));
    process.exit(1);
  }
}

console.log('guard-publish: 工作区干净，上游文件的修改声明齐全，可以发布。');
