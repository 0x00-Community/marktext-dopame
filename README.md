# MarkText for Dopame OS

把最经典的所见即所得 Markdown 编辑器 **MarkText** 原生搬上了 **Dopame OS**！✨

在彻底移除 Electron 厚重依赖、实现原生丝滑启动的同时，本项目完整保留并适配了上游 **Muya** 富文本渲染内核（基准版本 `v0.23.0`，提交 `18fdc1eddc7d36d9b205180d058982f71f4f6373`），并将单机写作体验与“人类作者主导”的智能协作打磨到了每一个细节：

- 📝 **纯粹顺手的原生写作体验**
  - **三模式秒切**：所见即所得富文本、CodeMirror 源码、专注阅读模式无缝切换，配合实时大纲跳转与全文查找替换；
  - **贴心外围工具**：本地图片挑选后自动归档至 `assets/` 并插入语法、自定义字号/行高/行号/符号配对偏好、侧边栏最近文件快捷重开、深浅色主题切换；
  - **数据零损安全**：严格保留 UTF-8 BOM 与换行格式，具备外部修改防冲突保护、定时感知刷新与“导出副本”能力。
- 🤝 **不喧宾夺主的智能协同写作**
  - **独立草稿收件箱**：外部智能助手搜集撰写的初稿统一投递至收件箱（附带来源引用），由你决定作为协作文档打开或提取副本；
  - **段落级 Diff 审阅与智能撤销**：所有修改只能以“段落级建议”提交，原文/建议左右清晰对比；哪怕采纳后你又接着写了新段落，点击撤销也能精准还原该处修改，绝不冲掉你后来的输入；
  - **内置 AI 写作面板**：支持选区润色、光标续写与全文总结，发送前可精确预览即将上传的字数与片段范围，流式生成随时可停；
  - **“只审不改”安全门禁与心流保护**：内置专职审查角色与恶意提示词隔离机制，且在你打字和拼音组字期间自动静默挂起后台问询，停笔后再集中合并呈现。

> **真正的智能写作，是让创作者始终掌握每一个字的主导权。** 🚀

---

## 仓库结构（精简移植版）

为聚焦 Dopame OS 移植与协同改造，本仓库已剔除未使用的原版 Electron 桌面壳与官网目录，仅保留运行、构建与许可证合规所需的核心模块：

| 路径 | 模块说明 |
| :--- | :--- |
| [`packages/dopame/`](packages/dopame/README.md) | **Dopame 原生 Markdown 编辑器外壳**（Vue 3 + Vite）：移除全部 Electron API，原生对接 `acde:fs`、`acde:window` 与系统文件选择器，提供单机编辑与作者侧协作审阅模块。 |
| [`packages/dopame-system/`](packages/dopame-system/README.md) | **多 Agent 文档协作服务与状态协调器**（Bun + SQLite）：实现 `marktext-documents/1` 协议、配对与最小授权、块级 Proposal 事务、专职审查门禁、内置 AI 写作端口与外部 LLM 工具客户端。 |
| [`packages/muya/`](packages/muya/README.md) | **共用富文本编辑内核**：源自上游 MarkText 的所见即所得 Markdown 引擎，针对 Dopame OS 授权根目录与本地图片资源加载进行了适配改造。 |
| [`LICENSE`](LICENSE) / [`THIRD-PARTY-LICENSES.txt`](packages/desktop/build/THIRD-PARTY-LICENSES.txt) | **开源许可证与第三方声明**：完整保留上游 MIT 许可证及既有第三方依赖声明，随全部构建产物一同分发。 |

---

## 核心移植与改造亮点

### 1. 纯粹流畅的 Dopame 原生单机编辑（[`packages/dopame`](packages/dopame/README.md)）
- **三模式实时切换**：支持 Muya 所见即所得（WYSIWYG）富文本、CodeMirror 源码模式与只读阅读模式无缝切换，提供实时文档大纲跳转、全文查找替换与多标签位置无障碍区分。
- **严谨的数据与编码安全**：完整保留文件的 **UTF-8 BOM** 与 **LF / CRLF** 换行格式；对非 UTF-8 文本明确拒绝并给出解释，杜绝乱码毁坏原文件；基于版本与修改时间实施乐观锁防冲突保存，支持**“导出副本”**（写出快照而不改变当前文档的保存目标）及两阶段保存核对。
- **完备的编辑外围体验**：
  - **编辑器偏好设置**：自定义字号（`12–28 px`）、行高（`1.2–2.4`）、Markdown 符号自动配对、源码行号显示及外部文件定时轮询自动刷新（`0 / 5 / 15 / 30 秒`）；
  - **最近文件历史**：侧边栏自动记录最近打开或保存的受管文档，支持一键重开与清空；
  - **本地图片一键导入**：通过系统选择器挑选图片，自动归档至文档同级 `assets/` 目录并在光标处插入标准 Markdown 图片语法；
  - **原生输入与光标适配**：针对 `acdert` 渲染器定制指针选区、字素移动与 IME 中文组字完成态等待（`EditorPort`），防止输入过程中切模式或审阅操作吞字。

### 2. 以人类作者为权威的提案式 Agent 协作（[`packages/dopame-system`](packages/dopame-system/README.md)）
- **配对与最小权限授权**：外部调用方须先发起配对请求，由作者在编辑器侧栏选择预设角色范围（审阅、研究、专职审查、Harness 调度、交付、下游接收）、有效期（30 分钟～12 小时）及块级/重试边界约束后，方可获取受限凭据；作者可随时一键撤销调用方或单条授权。
- **独立草稿收件箱**：研究型 Agent 通过 `documents.createDraft` 投递独立草稿（固定记录创建者、时间、工作流与参考来源引用），作者可选择**“作为协作文档打开”**或**“打开独立副本”**。
- **块级不可变建议（Proposal）与安全撤销**：
  - 针对现有文档的所有修改必须绑定基础版本（`revision`）与块标识（`blockId`）提交为 Proposal，绝不静默改写作者正文；
  - 作者可在侧栏查看原文/建议成对差异（Diff）并执行**接受、拒绝或撤销本次接受**；若接受后作者又在文档其他位置补充了新内容，点击撤销会自动计算**反向建议（Reverse Proposal）**，在还原目标块的同时完整保留作者后续输入。

### 3. 专职只审不改 Agent 门禁与提示词注入隔离
- **静态注入扫描全量防护**：内置 `ContentSanitizer` 对所有入库草稿、建议及模型输出执行静态扫描，一旦识别出间接提示词注入、隐藏 HTML/脚本或越权模块调用特征，立即标记为隔离态（`quarantined_injection`）并在服务端与界面双端锁死打开和接受入口。
- **专职审查角色（只审不改）**：支持配对持有 `audit:review` 权限的专职审查 Agent（其权限与任何写操作或导出操作物理互斥）。当授权开启强制审查或工作区存在有效专职审查 Agent 时，草稿与建议须经审查员调用 `proposals.verify` 核验通过（`verified`）后方可被接受、转正或物化落盘；同时支持限制允许修改的 `allowedBlockIds` 及最大纠偏重试次数熔断（`maxAuditRetries`）。

### 4. 四维进度汇报、冷却合并问询与多窗口单写者租约
- **低打扰进度与合并问询**：Agent 通过 `tasks.updateProgress` 汇报当前动作、完成度百分比与阻塞问询选项；同一工作流在 180 秒冷却窗口内的多条阻塞问询自动合并为单张交互卡片，且在作者打字或拼音组字期间自动静默挂起，不抢占输入焦点。
- **多窗口单写者租约与只读跟随**：同一协作文档通过 `writerFence` 保证单写者独占；非持有写租约的窗口自动进入**只读跟随模式**并在远端版本推进时实时刷新快照，支持显式点击**“接管写入权”**（原窗口组字未完成时拒绝抢占，冲突未同步内容自动保留为恢复草稿 `recovery_drafts`）。

### 5. 内置 AI 写作面板、外部 LLM 工具接入与受管沙箱落盘
- **内置 AI 写作面板**：支持**选区润色（`polish`）**、**光标/选区续写（`continue`）**与**选区/文档总结（`summarize`）**；提供精确的 UTF-16 发送范围与正文片段预览、流式进度展示与随时停止生成；润色与续写统一生成待审 Proposal，总结输出只读摘要卡片。
- **OpenAI 兼容网关与 Function Calling 客户端**：
  - [`modelPort.ts`](packages/dopame-system/src/modelPort.ts) 原生支持 OpenAI `/v1/chat/completions` 的 JSON 与 `text/event-stream` SSE 流式响应；
  - [`agentClient.ts`](packages/dopame-system/src/agentClient.ts) 将凭据封存在受信任闭包内，提供 `openAITools()` 动态工具发现与 `callTool()` 分发，可直接对接外部大模型 Function Calling。
- **受管沙箱无窗原子落盘**：后台 Harness 可调用 `artifacts.materializeToManagedDir` 将已通过审查的固定版本产物以“临时文件 + `fsync` + 原子 `rename`”（含符号链接逃逸校验）写入服务私有目录 `managed_workspace/`，全程不触碰用户源文档。

---

## 快速开始与开发验证

### 1. 安装依赖与构建五包成品
```sh
pnpm install --frozen-lockfile
pnpm --filter marktext-dopame-system build
pnpm --filter marktext-dopame-system test:package
```

`build` 会生成并校验 5 个标准 Dopame 输入包（位于 `packages/dopame-system/.acde/inputs/`）：
- `standalone`：纯单机版 MarkText 编辑器（零服务依赖）
- `collab-editor`：带作者协作与内置 AI 写作侧栏的编辑器
- `collaboration`：调用方调试面板（`marktext-agent-preview`）
- `desktop`：承载 `marktextdocs` 服务的标准桌面
- `approval-desktop`：本地开发用批准宿主桌面（`notForProduction`）

### 2. 启动日常预览（协作版编辑器 + 开发批准宿主）
```sh
pnpm --filter marktext-dopame-system dev:collab
```
如需同时体验内置 AI 写作面板（使用内置本地适配器或 OpenAI 兼容端点）：
```sh
MARKTEXT_MODEL_ID=local-adapter MARKTEXT_MODEL_ENDPOINT=local-adapter \
  pnpm --filter marktext-dopame-system dev:collab
```

### 3. 运行类型检查与自动化测试
```sh
pnpm -C packages/dopame typecheck
pnpm -C packages/dopame test
pnpm --filter marktext-dopame-system typecheck
pnpm --filter marktext-dopame-system test
pnpm --filter marktext-dopame-system test:preview
pnpm --filter marktext-dopame-system test:preview-data
pnpm --filter marktext-dopame-system test:approval-host
pnpm --filter marktext-dopame-system test:e2e
```

---

## 上游致谢与许可证（Upstream & License）

- **上游项目**：[marktext/marktext](https://github.com/marktext/marktext)（Pinned commit: `18fdc1eddc7d36d9b205180d058982f71f4f6373`, v0.23.0）
- **开源协议**：[MIT License](LICENSE)；第三方依赖许可证声明见 [`packages/desktop/build/THIRD-PARTY-LICENSES.txt`](packages/desktop/build/THIRD-PARTY-LICENSES.txt)。
