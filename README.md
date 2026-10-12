# ArtPlatform · Roblox 创作画布

一个可在本地运行的第一步原型：在无限画布中输入描述，通过 WaveSpeed 中可选的生图模型生成图片，并在画布上移动、比较和保存结果。

## 启动

需要 Node.js 20 或更新版本。项目不需要安装 npm 依赖。

1. 将 `.env.example` 复制为 `.env`。
2. 在 `.env` 中设置 `WAVESPEED_API_KEY`。API key 只由本地服务端读取，不会发送到浏览器。
3. 在仓库目录运行 `npm start`。
4. 打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。

想先体验交互，可在 `.env` 中设置 `WAVESPEED_MOCK=1`，此时生成示意图片，不消耗 API 额度。接口测试运行 `npm test`。

## 当前能力

- 无限画布：拖动空白处平移，滚轮缩放；图片卡片可拖动，支持缩放到内容。
- 顶栏可切换深色和浅色主题；首次打开默认深色，并记住用户选择。
- 从输入框提交文字描述，可选 Nano Banana 2.1（默认）、Nano Banana 2 或 Nano Banana Pro，以及比例与 1K/2K/4K 质量。提交后显示任务状态，完成后图片进入画布。
- 模型下拉框还提供 WaveSpeed 的 GPT Image 2.5 Flare、GPT Image 2.5 Sunburst、GPT Image 2 与 GPT Image 1.5，沿用 `WAVESPEED_API_KEY`，均支持生图和单张参考图编辑。GPT 2/2.5 支持 1K/2K/4K，质量可独立选择；GPT 2.5 提供 Low/Medium/High/XHigh/Max，GPT 2 与 1.5 提供 Low/Medium/High。GPT 1.5 使用 1024×1024、1536×1024、1024×1536 三种固定尺寸（1:1、3:2、2:3），编辑明确使用高输入保真度。前端按所选模型、比例、分辨率、质量和是否编辑显示参考价格，实际以 WaveSpeed 计费为准。
- 在输入框或页面上按 Ctrl+V，可粘贴飞书等应用复制出的图片文件，也支持剪贴板 HTML 中的内嵌图片；或者点击“上传图片”。常见剪贴板图片格式会转成 PNG，先保存在本机画布并自动成为编辑参考图。若飞书仅提供受权限保护的远程链接，页面会提示使用“复制图片”或下载后上传。
- 选中已生成图片，点击“以此图编辑”，用文字描述修改；新图片作为独立卡片出现在原图旁边，画布用连线表示参考关系，拖动卡片时连线同步更新。
- 选中已完成图片可调用 Meshy 7.1 生成 3D 模型；任务完成后 GLB 下载到本机，可在网页弹窗中旋转、缩放和下载。
- 图片和任务信息保存在本机 `data/`；画布位置保存在浏览器本地存储。刷新后可恢复画布，未完成任务继续查询。
- 服务端提交 WaveSpeed 异步任务并轮询结果，下载完成的图片到本机。编辑时先将本地参考图上传到 WaveSpeed 临时存储，再调用当前选择模型的 Edit 接口。API key 不进入前端代码。
- 页面按所选模型和分辨率显示参考价格。Nano Banana 2.1 的 1K/2K/4K 标价分别为 $0.04/$0.06/$0.135，单张参考图编辑另加约 $0.002；其他模型见 [Nano Banana 2](https://wavespeed.ai/docs/docs-api/google/google-nano-banana-2-text-to-image) 与 [Nano Banana Pro](https://wavespeed.ai/docs/docs-api/google/google-nano-banana-pro-text-to-image)。实际计费以服务商页面为准。

## 当前范围

此版本完成“文字 → 画布图片 → 基于单张图片的文字编辑”，也支持直接粘贴或上传外部图片作为参考。笔刷遮罩、多张参考图、三视图联合生成 3D 与 Roblox Studio MCP 搭建尚未实现；下一阶段以已生成图片为输入逐步扩展。[实施计划](docs/plan.md) · [调研记录](docs/research.md)

`data/`、`.env` 与生成资产默认不入 Git。仓库当前记录代码、设计文档和测试。

本地文件：`data/images/` 保存生成及导入的图片，`data/tasks.json` 保存图片任务和参考关系，`data/models/` 保存 GLB，`data/model-tasks.json` 保存 3D 任务。“从画布移除”只移除浏览器中的卡片，不删除本地文件；备份资产请复制整个 `data/` 目录。浏览器本地存储另存画布布局，清除浏览器存储不会删除磁盘图片。

GPT 接口参考：[GPT Image 2.5 Flare 生图](https://wavespeed.ai/docs/docs-api/openai/openai-gpt-image-2.5-flare-text-to-image)、[编辑](https://wavespeed.ai/docs/docs-api/openai/openai-gpt-image-2.5-flare-edit)、[GPT Image 2](https://wavespeed.ai/docs/docs-api/openai/openai-gpt-image-2-text-to-image)、[GPT Image 1.5](https://wavespeed.ai/docs/docs-api/openai/openai-gpt-image-1.5-text-to-image)。

参考图编辑接口：[WaveSpeed Nano Banana 2.1 Edit](https://wavespeed.ai/docs/docs-api/google/google-nano-banana-2.1-edit)。

## 本地服务更新

如果上传时出现“未找到资源”，通常是浏览器加载了新页面，但本机仍运行旧版 Node 服务。关闭旧的运行终端，重新执行 npm start 并刷新页面。新页面首次打开时会从本机任务记录恢复已有图片。

3D 生成通过 [WaveSpeed 的 Meshy V7.1 Image to 3D 接口](https://wavespeed.ai/docs/docs-api/meshy/meshy-v7.1-image-to-3d)，继续使用 WAVESPEED_API_KEY。默认生成带纹理、标准几何和约 3 万面目标的 GLB；本机图片先上传至 WaveSpeed 临时存储，再提交给 Meshy 模型。WaveSpeed 文档标价约 $1.44/次，实际以提交时费用为准。网页预览使用固定版本的 [Google model-viewer](https://github.com/google/model-viewer)，首次打开 3D 预览需要浏览器可访问其 CDN；若查看器加载失败，仍可下载本机保存的 GLB。
