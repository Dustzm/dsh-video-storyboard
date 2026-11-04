# TONGDO_CHANGES

通办在本衍生仓库里相对上游 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) 的全部改动。上游许可证 Apache-2.0，原 `LICENSE`、`NOTICE` 保留；本文件即对修改的说明。

## 分支

| 分支 | 用途 |
|---|---|
| `master` | 上游镜像（上游主分支名为 `main`），只在 GitHub 上用 Sync fork 同步，不提交 |
| `develop` | 通办主开发分支：`feat/…`、`fix/…` 从这里拉、`--no-ff` 合回；核心仓库用的包以它为准 |
| `sync/<上游版本>` | 吸收上游时开：整版 merge `master`，复核本表后合回 `develop` |

提交范围固定写 `tongdo`（如 `feat(tongdo): …`），与上游提交区分。

## 原则

- **改动集中**：通办的入口、配置、工具定义、纯文本模型降级都在新增目录 `src/tongdo/`；对上游文件只做少量挂钩，便于整版合并。
- **改上游文件要带修改声明**：被改过的上游源码文件在文件头注释末尾加一行 `Modified by Tongdo; see TONGDO_CHANGES.md.`，并在下表登记；`npm run guard`（`prepublishOnly` 也会跑）会检查相对 `master` 改过的 `.js`、`.mjs` 是否都带声明。`package.json` 等不能写注释的文件由本文件覆盖。
- **上游入口不变**：`./upstream` 子路径仍导出上游的 `src/index.js`，命令行（`bin/`）行为与上游一致；只有调用了 `configureHostRuntime()` 的宿主才走通办的行为。

## 改动

| 改动 | 位置 | 原因 | 能否去掉 |
|---|---|---|---|
| 通办入口：插件 `Config`（ffmpeg 路径、缓存目录、语音转写、识图模型），只注册五个工具，不挂设置页 | `src/tongdo/index.js`、`config.js` | 上游靠环境变量和 `$DSH_HOME/video.json`、`asr.json` 配置，并自带本机设置网页；通办统一用插件配置下发，用户不配任何东西 | 不能，通办专用 |
| 精简的工具定义：去掉链接、cookies、清晰度、OCR、档位微调等参数，描述改为“用户丢进来的视频文件”；分镜描述说明格子按时间采样、可能跨切点，文字索引是时间与切点的权威结果，不要自己用 shell 重新抽帧或 OCR | `src/tongdo/tool-spec.js` | 参数说明每轮都发给模型；产品不开放链接下载，也不让模型去调底层旋钮；“一镜一帧”的旧说法会让模型怀疑索引、自己去抽帧核对 | 不能，通办专用 |
| 只接受本地文件：链接输入直接拒绝并提示用户下载后附上，拒收说明里叮嘱不要用别的工具下载；`input` 说明与 probe、storyboard 的描述写明链接会被拒收，引导模型把链接交给工具、转告拒收说明，而不是自己用 shell 或网页工具下载 | `src/tongdo/index.js` 的 `localOnly`、`src/tongdo/tool-spec.js` | 链接下载依赖用户自装 yt-dlp 与 cookies，且有合规风险；不写进描述时模型拿不到拒收说明，会自己去下载 | 产品开放链接时去掉 |
| 纯文本模型降级：当前模型看不到图片时，请同一路由（或配置指定）的识图模型逐格描述分镜图，追加到工具结果 | `src/tongdo/vision.js` | 宿主会把发给纯文本模型的图片换成占位文字，模型只剩时间索引 | 宿主提供通用的“代看图”机制后可去掉 |
| 宿主托管的运行时设置 `configureHostRuntime()`：缓存目录、语音转写配置；托管时不读用户配置文件与 `DSH_ASR_*` 环境变量 | 新增 `src/storyboard/runtime.js`；挂钩 `user-config.js` 的 `readVideoFile`、`asr.js` 的 `resolveAsrConfig` | 缓存默认在 `~/.cache`、`/tmp`，不符合通办“数据目录隔离”；转写配置要由宿主下发 | 不能，通办专用 |
| 宿主托管时的台词说明：没有转写服务时给模型中性说明，不再出现“装 sherpa-onnx、导 B 站 cookie、看 docs/SETUP”这类安装指引；也不写“Work from the frames”，免得和代看失败时“画面没看到”的说明互相矛盾 | `src/storyboard/format.js`（`HOST_NO_TRANSCRIPTION*` 与三处 `hostRuntime()` 分支） | 产品用户不配置也不该被要求配置；只在托管时生效 | 不能，通办专用 |
| 清单的证据文件一行改为只在真写过证据文件（`result.evidencePath`，CLI 的 `saveStoryboards` 会设置）时输出，并写出真实路径 | `src/storyboard/format.js` 的 `formatManifest` | 插件路径不写证据文件，原来那行固定的 `<name>.evidence.json` 会让模型满盘去找 | 上游修正后可去掉（可反馈给上游） |
| 修复：切点类型判定。白闪要求窗口内部有比两端都亮的峰（`rise`），亮画面切到暗画面不再判 white；V 指纹不变但变化集中在单帧（饱和色之间硬切）时判 hardcut，不再判 motion；集中度阈值提为 `CONC_HARD` | `src/storyboard/flash.js` 的 `flashEvidence`、`tagCuts` | 上游缺陷：指纹是 V=max(R,G,B)，饱和色之间切换时 V 不变；误标的 white、motion 会让模型怀疑切点、自己去抽帧核对 | 上游修复后可去掉（可反馈给上游） |
| ffmpeg 解析：新增随包分发目录 `vendor/ffmpeg/<platform>-<arch>/`，以及宿主指定路径 `useMediaBinaries()`；`DEFAULT_FFMPEG`、`DEFAULT_FFPROBE` 改为 `let` 活绑定 | `src/storyboard/binaries.js` | 安装包自带 ffmpeg，用户不装任何东西 | 不能，通办专用 |
| 自建 LGPL 版 ffmpeg / ffprobe：构建脚本（macOS 两个架构本机或交叉编译，Windows 在 Linux 上用 mingw 交叉编译；不带 gpl/nonfree/version3，外部库只有 dav1d 与 zlib；编码器、封装器只留插件用到的），手动触发的工作流发布到本仓库 Release（附对应源码与 SHA256SUMS）；`npm run vendor -- <目标>` 按 `ffmpeg-sources.json` 的 sha256 下载并放进 `vendor/` | `scripts/build-ffmpeg.sh`、`.github/workflows/ffmpeg.yml`、`scripts/fetch-ffmpeg.mjs`、`scripts/ffmpeg-sources.json`、`vendor/`（不入库） | 主流 macOS 预编译版全是 GPL 构建，通办不允许 GPL 进入产品；自建才能固定版本、滤镜集合与源码归档 | 不能，通办专用 |
| 包清单：包名 `@tongdo/video-storyboard`，版本 `<上游版本>-tongdo.<N>`；默认导出通办入口；不声明上游 bundle 与设置页客户端；宿主包改为 peer + dev 依赖 | `package.json`、`package-lock.json`、`dsh.plugin.json`（只同步版本号） | 由通办的多模态 bundle 插入配置行 | 不能，通办专用 |
| 修复：ffmpeg 提前退出时写 stdin 的 EPIPE 未处理，会成为未捕获异常拖垮整个宿主进程；改为由退出码报错 | `src/storyboard/sheet.js` 的 `exec` | 上游缺陷（用精简 ffmpeg 构建时暴露） | 上游修复后可去掉（可反馈给上游） |
| 发布闸门：除工作区干净外，再检查相对 `master` 改过的上游 `.js`、`.mjs` 文件头带修改声明 | `scripts/guard-publish.mjs` | Apache-2.0 第 4(b) 条要求被修改的文件本身带显著声明 | 不能，通办专用 |
| 测试：新增通办入口测试；上游设置页客户端测试在包不挂设置页时跳过；切点判定、证据行与托管台词说明补测试 | `test/tongdo.test.mjs`、`test/settings.test.mjs`、`test/flash.test.mjs`、`test/manifest.test.mjs` | 同上 | 不能 |

## 已知缺陷

- **不转写台词**：通办暂未接入语音转写服务。视频有内嵌字幕轨、或用户另附 `.srt` / `.json` 字幕文件时能读到台词；否则只看画面、屏幕文字和音量，模型会如实告诉用户台词没有覆盖到。接入后在配置行加 `transcription` 即可，无需改代码。
- **不读链接**：只处理用户附上的本地视频文件。
