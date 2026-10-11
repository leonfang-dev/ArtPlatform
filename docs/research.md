# Roblox 创作工具调研

调研日期：2026-10-11。以 Roblox 官方 Creator Hub 为主要来源。正式开发前再次核对接口与限制。

## 已有能力与机会

| 领域 | Roblox 已有能力 | 产品判断 |
| --- | --- | --- |
| AI 创作 | Studio Assistant 可修改对象和脚本、搜索 Creator Store、生成材质、网格和程序化模型。 | 避免重复通用聊天助手，重视可编辑的工作流。 |
| 图片 | Material Generator 可从文字生成材质，Studio 可导入图片资产。 | 优先做特效贴图、图标和关卡参考图，加入透明背景、尺寸及导入检查。 |
| 关卡 | Terrain Editor 支持地形生成、笔刷、heightmap/colormap 与脚本创建。 | 从灰盒布局、模块摆放和路径检查切入，保留 Studio 原生编辑。 |
| 特效 | ParticleEmitter、Beam、Trail、灯光和 Highlight 可组合；粒子支持序列、flipbook 和瞬时发射。 | 用结构化配方、时间轴与性能档位生成 Roblox 原生对象。 |

来源：[Assistant](https://create.roblox.com/docs/assistant/guide)、[Material Generator](https://create.roblox.com/docs/studio/material-generator)、[Terrain Editor](https://create.roblox.com/docs/building-and-visuals/studio-modeling/terrain)、[Effects](https://create.roblox.com/docs/effects)、[ParticleEmitter](https://create.roblox.com/docs/reference/engine/classes/ParticleEmitter)。

## 技术接口与限制

- Studio 插件可添加工具栏和界面、操作当前场景，适合作为选择挂点、预览、调参和写入的主要入口。[官方文档](https://create.roblox.com/docs/studio/plugins)
- Studio MCP 可让外部 AI 客户端连接开放的 Studio 会话，读取数据模型、执行 Luau 和测试；作为未来辅助集成，首版无需依赖。[官方文档](https://create.roblox.com/docs/ai/accelerated-workflows)
- Open Cloud Assets API 支持图片等素材上传，但创建/更新内容受格式、大小和类型限制，相关端点标记为 beta。上传任务须追踪状态。[官方文档](https://create.roblox.com/docs/cloud/guides/usage-assets)
- 导入资产会接受平台审核，审核未通过或尚未完成的素材可能无法在公开游戏中显示。产品需展示审核状态与替换入口。[官方文档](https://create.roblox.com/docs/projects/assets)
- Place Publishing API 可用于以后自动发布，但部分实例类型修改后仍需从 Studio 发布。首版不自动发布游戏。[官方文档](https://create.roblox.com/docs/cloud/guides/usage-place-publishing)
- 贴图、粒子和大量对象可能增加绘制开销，ParticleEmitter 属性变化尤其需要注意。应在移动设备上实际测量。[官方文档](https://create.roblox.com/docs/performance-optimization/improve)

## 待验证假设

以下是产品推断，并非官方结论：

1. 主要痛点是把素材、关卡和特效组合成风格一致、可继续编辑的场景。
2. 特效制作适合作为首个切口，因为可以在 Studio 插件中实现清晰的输入、预览和可见输出，也会带动贴图需求。
3. 关卡生成应先确认灰盒布局和玩法路径，再逐步生成细节；一次生成完整成品难以控制。

用创作者访谈和原型任务验证上述判断，再决定产品范围。

## 新方案专项调研

- **Lovart 式画布**：官方文档展示了无限画布、局部标记编辑、元素分层与多角度生成。产品借鉴这些交互能力，不假定可直接调用 Lovart 私有能力。[Lovart Canvas](https://www.lovart.art/docs/edit-your-design/customize-your-canvas)、[Advanced AI Editing](https://www.lovart.ai/docs/edit-your-design/advanced-ai-editing)、[Multi-Angles 入口](https://www.lovart.art/docs/getting-started/design-your-first-project)
- **Meshy 多图转 3D**：官方 API 接收同一物体 1–4 张不同角度图片；首张为正视图，任务异步执行，可取得 FBX/GLB 等格式。它适合模块级资产重建，不能据此声称可直接生成精确的完整关卡。[Meshy Multi-Image to 3D](https://docs.meshy.ai/en/api/multi-image-to-3d)
- **Roblox 模型导入**：Studio Importer 支持 FBX、glTF、OBJ，并提供预览、缩放、方向及警告检查。Meshy 粗模应先经过这一步确认。[Roblox Importer](https://create.roblox.com/docs/studio/importer)
- **Studio MCP**：官方文档说明外部 AI 客户端可以连接 Studio 会话，读取数据模型、执行 Luau 和测试。Codex 搭建场景必须以开放的 Studio 会话和明确蓝图为前提。[Roblox Studio MCP](https://create.roblox.com/docs/studio/mcp)
