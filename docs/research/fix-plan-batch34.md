# 修复计划：批次 3（面板功能）+ 批次 4（健壮性）+ 面板可读性改造

> 依据：`scratch/agy-audit.md`（审计）+ 本会话结论 + 用户确认的三条设计要求
> 修改目标：`src/index.ts`、`src/agy-steps.ts`、`src/agy-panel.ts`、`src/client.js`，随后 `npm run build`
> 状态：**待复审，未执行**

---

## 0. 已确认的设计决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 连续工具调用 | **合并**成一个折叠块（`3 次工具调用 · read_file · write_to_file · …`） |
| Markdown 范围 | 只渲染「思考」与「回复」正文；工具参数保持等宽纯文本 |
| 默认状态 | 工具折叠、回复展开 |
| 目标观感 | `思考 → 工具调用（折叠）→ 回复` |
| 并发写（BUG-19/20） | 判定为**理论隐患**，只加注释固化约束，不改逻辑 |

---

## 批次 A：后端（4 项，风险低）

### A1【BUG-16】「0 files changed」——截断前先提取目标路径

**根因**（已核实）：`agy-steps.ts:56-72` 的 `normalizeStep` 在参数序列化 >2048 字符时，把 `parameters` **整体替换**为 `{truncated, preview}`；随后 `filesTouched` → `targetPath`（`agy-steps.ts:283`）先按 `TARGET_PATH_KEYS` 找（key 已不存在），再走 fallback 正则（`preview` 结尾是 `…(+N chars)`，匹配不上扩展名）→ 返回 null → 文件数为 0。

**改法**（`src/agy-steps.ts`）

1. `StepTool` 接口（约 L75-84）增加可选字段：
```ts
/** Target path captured before parameters were truncated, when known. */
targetPath?: string
```

2. `normalizeStep`（L56-72）在替换之前捕获：
```ts
function normalizeStep(step: StepEvent): StepEvent {
  const parameters = step.tool?.parameters ?? null
  let tool = step.tool
  if (tool !== null && parameters !== null) {
    // Capture the target before the parameters are replaced: a write tool's
    // `file_path` lives in exactly the object the truncation drops, and the
    // `[agy] N files changed` summary is built from it.
    const target = targetPath(parameters)
    const withTarget = target !== null ? { ...tool, targetPath: target } : tool
    const serialized = JSON.stringify(parameters)
    tool = serialized.length > MAX_TOOL_PARAM_TEXT
      ? { ...withTarget, parameters: { truncated: true, preview: truncate(serialized, MAX_TOOL_PARAM_TEXT) } }
      : withTarget
  }
  return { ...step, text: truncate(step.text, MAX_STEP_TEXT), tool }
}
```

3. `filesTouched`（L305-318）优先取已有字段：
```ts
const path = step.tool.targetPath ?? targetPath(step.tool.parameters)
```

**注意**：`targetPath` 定义在 L283，`normalizeStep` 在 L56 —— 函数声明提升，运行时没问题；但 TS 的 `noUnusedLocals`/顺序无影响（函数声明提升）。**需 reviewer 确认**：`targetPath` 与 `normalizeStep` 之间是否存在 `const` 依赖导致 TDZ（TARGET_PATH_KEYS 是 `const`，在 L280）。运行时 `normalizeStep` 只在收到 step 后调用，那时模块已初始化完毕 → 安全。

**验证**：新增测试——构造一个 `write_to_file` 且 content > 2KB 的 step，断言 `filesTouched` 返回该路径；同时断言摘要不再出现 `0 files changed`。

---

### A2【BUG-21】后台 stdout 多字节截断

**位置**：`src/index.ts` 后台 `spawnOnce()`（约 L2165-2177）

**改法**
```ts
import { StringDecoder } from 'node:string_decoder'
…
const decoder = new StringDecoder('utf8')
handle.stdout?.on('data', (chunk: Buffer) => {
  buffer += decoder.write(chunk)   // was: chunk.toString('utf8')
  …
})
handle.stdout?.on('end', () => {
  buffer += decoder.end()
  const tail = buffer.trim()
  …
})
```
`decoder.end()` 必须调用，否则最后一个不完整字符会留在解码器里。

**验证**：用 fake-agy 的 `split-chunk` 场景跑**后台**任务（现有测试是前台的），断言中文不出现 `\uFFFD`。

---

### A3【BUG-19/20】同步写约束注释（不改逻辑）

在四处写函数上方各加一行说明，防止将来改异步：
- `src/index.ts` `writeTranscript`（L811 附近）
- `src/agy-panel.ts` `writePrefs`（L360 附近）
- `src/agy-models.ts` 写入函数（L137 附近）
- `src/agy-usage.ts`（L226 附近）、`src/agy-usage-log.ts`（L173 附近）

注释模板：
```ts
// Keep this whole read→write→rename block synchronous: it is the only thing
// that keeps concurrent writers from losing each other's entries. Converting
// any part to `fs.promises` requires a write queue first.
```

---

## 批次 B：面板可读性（前端，`src/client.js`）

### B1 精简 Markdown 渲染器

**约束**：`client.js` 是经典脚本，**不能 import 任何库**；不得用 `dangerouslySetInnerHTML`（agy 输出属外部数据）。

**新增**（放在 `outputValueText` 之后、`STEP_LABEL` 之前）：
```js
/** Parse one line of inline markdown into React nodes. Never builds HTML strings. */
function renderInline(text, keyPrefix) // → ReactNode[]

/** Render markdown text (blocks) into React nodes. */
function renderMarkdown(text, keyPrefix) // → ReactNode[]
```

支持：`# ## ###` 标题、` ``` ` 代码块（保留语言标签）、`- ` / `* ` 无序列表、`1. ` 有序列表、`> ` 引用；行内 `**bold**`、`*italic*`、`` `code` ``、`[text](url)`、换行。
不支持（明确写进注释）：表格、脚注、HTML 透传、嵌套列表。

样式：字号 11、行高 1.6、段落间距 4px、代码块用等宽 + 背景 `C.field` + 圆角。

**安全**：所有文本作为 React 子节点（自动转义）；链接强制 `target="_blank" rel="noopener noreferrer"`，且只允许 `http/https/mailto` 协议，其余按纯文本渲染。

---

### B2 折叠组件 + 工具组合并

**新增**
```js
/** One collapsible block. `defaultOpen` false for tools, true for answers. */
function Disclosure({ summary, badge, children, defaultOpen })

/** A run of consecutive tool steps, collapsed into one line by default. */
function ToolGroup({ steps })

/** A single step rendered according to its type. */
function StepRow({ step, markdown })
```

**分组规则**（`groupSteps(steps)` 纯函数）：
- 连续的 `type === 'tool'` 步骤合并为一个 group
- 其它类型（`agent_response` 等）各自独立
- `round` 变化时断开分组（现有轮次分隔保留）

**摘要行**（折叠时可见）：
- 组：`▸ 3 次工具调用 · read_file · write_to_file · run_command`
- 单个工具：`▸ write_to_file · src/a.ts`（路径优先取 `tool.targetPath`，否则第一个字符串参数，截断 40 字符）
- 失败工具：摘要行标红 + `失败`

**展开后**：每个工具一段，显示工具名 + 参数（等宽 pre，复用现有 `ToolDetail`），失败显示 `tool.error`。

---

### B3 `HistoryTimeline` 接入新渲染

把 `steps.map(...)`（L563-593）替换为 `groupSteps(steps).map(...)`，渲染 `ToolGroup` / `StepRow`。轮次分隔（`第 N 轮`）保留。
`agent_response` 的正文与 `thinking` 用 `renderMarkdown` 渲染。

---

### B4 运行视图：实时步骤 + 耗时（批次 3 第一、二件）

**后端**：`/api-agy/run` 已返回 `steps` / `stepsVersion` / `elapsedMs`（`agy-panel.ts:486-489`），无需改动。

**前端**：
1. `run` state 增加 `steps`、`stepsVersion`、`elapsedMs`；轮询回调里接收（现在只取 text/status/tool/error）。
2. 运行面板的主体由「纯 `<pre>` 文本」改为：
   - `steps.length > 0` 时渲染步骤时间线（复用 B2 组件，实时更新）
   - 否则回退到现有文本 `<pre>`（保留，作为没有步骤流时的兜底）
3. 头部状态行显示 `已运行 2m 14s`（来自 `elapsedMs`，运行中每秒本地自增，避免只靠 400ms 轮询刷新）。

**注意**：`steps` 是「整体替换」语义（`stepsVersion` 变化才替换），不要做增量拼接。

---

### B5 隐藏会话按钮（批次 3 第三件）

**后端**（`src/agy-panel.ts`）：
- `/conversations` 接受 `{ includeHidden?: boolean }`；默认仍过滤，`true` 时返回全部并附带 `hidden: true` 标记。
- `/prefs` 已支持 `{hide, show}`，无需改动。

**前端**：
- `ConversationRow` 右侧增加一个 `⊘` 按钮（hover 时可见），点击 `POST /prefs {hide}` 后刷新列表。
- 列表头部增加一行开关：`显示已隐藏（n）`，打开时以 `includeHidden: true` 请求，已隐藏项显示为半透明 + 一个 `↺` 恢复按钮（`{show}`）。

---

## 执行顺序

| 步 | 内容 | 验证 |
|---|---|---|
| 0 | 固化基线：`git diff > scratch/baseline-b34.patch`；`npm test` 绿 | 145/145 |
| 1 | A1（targetPath）+ 新测试 | `npm test` |
| 2 | A2（StringDecoder）+ 后台 split-chunk 测试 | `npm test` |
| 3 | A3（注释） | `npm test`（应无变化） |
| 4 | B1（Markdown）+ B2（折叠/分组） | 面板契约测试 |
| 5 | B3（历史视图接入） | 面板契约测试 |
| 6 | B4（实时步骤 + 耗时） | 面板契约测试 |
| 7 | B5（隐藏会话，含后端 includeHidden） | 面板契约测试 |
| 8 | 全量回归 | `npm test` + `npm run test:panel` + `npm run build` |
| 9 | **浏览器实测** | Playwright 打开 `http://127.0.0.1:12217`，截图确认折叠/Markdown/实时步骤 |

---

## 风险与回退

| 风险 | 缓解 |
|---|---|
| `client.js` 无构建、无类型，改坏会白屏 | 每步后跑 `test:panel`（含 client bundle 契约）；第 9 步浏览器实测 |
| Markdown 渲染器有 XSS 面 | 全程 React 元素树，禁用 innerHTML；链接限协议 |
| 工具组合并改变既有视觉 | 只影响面板内部渲染；`test/panel-*.mjs` 不校验 DOM 结构 |
| B5 动了 `/conversations` 的返回形状 | 保持默认行为不变，新参数可选；补测试 |
| 工作量偏大（约 300 行前端） | 分 5 步落地，每步可独立回退 |

## 需 reviewer 重点裁定

1. **A1 的 TDZ/提升**：`normalizeStep`（L56）调用 `targetPath`（L283），后者依赖 `TARGET_PATH_KEYS`（L280 `const`）——是否存在初始化顺序问题？
2. **B1 的规模**：手写 Markdown 是否为必要复杂度，还是应该只做「代码块 + 行内代码 + 粗体」的最小集？
3. **B4 的文本流去留**：有 steps 时是否应该隐藏文本流（可能丢失 steps 不覆盖的内容，例如 `[agy: tool step done]` 进度标记）？
4. **B5 的后端改动**：`/conversations` 增加 `includeHidden` 是否会破坏现有调用方？
5. 整体：是否有更小的等效路径（例如只做折叠不做 Markdown）？

---

# 复审裁定与执行记录（v2）

## 复审结果
[plan-review-b34.md](plan-review-b34.md) — **有条件批准**，6 个必须修改点，全部采纳：

| 复审意见 | 采纳情况 |
|---|---|
| **A1 致命**：`mergeStep` 不保留 `targetPath`，第二次事件会把它抹掉 → 修复无效 | ✅ 已补合并逻辑；并加了「ACTIVE→DONE」回归测试 |
| A1 脆性：`normalizeStep`(L56) 跨 240 行引用 `TARGET_PATH_KEYS`(L280) | ✅ 常量与 `targetPath` 已物理上移 |
| 建议：二次归一化会把 preview 再包一层 | ✅ 已加 `alreadyTruncated` 短路 |
| **B1 符号错误**：`outputValueText` 在 `index.ts` 不在 `client.js` | ✅ 插入点改到 `STEP_LABEL` 之前 |
| B1 规模：手写全量 Markdown 是白屏风险 | ✅ 收缩为「```代码块 + `code` + **bold**」，其余靠 `pre-wrap` |
| **B2**：ACTIVE 的工具默认折叠会让面板"假死" | ✅ 运行中/失败强制展开（`<details open>`）；其余用非受控 details |
| **B4**：不能因为有 steps 就删掉原始文本流 | ✅ 时间线为主视图，原始输出保留为默认折叠的 `🔽 原始输出 · N 字符` |
| **B5**：漏了 `agy-conversations.ts` | ✅ 已在 `ConversationItem`/`ListConversationsOptions`/过滤逻辑中补齐 |

复审的其它建议也已落实：`clockOf` 对 `undefined` 安全（`clockOf` 已先判 `Number.isFinite`）、`test/agy-steps.mjs` 的幽灵断言 `tool.preview` → `tool.parameters.preview`。

## 实际执行

**批次 A（后端）**
| 项 | 位置 | 状态 |
|---|---|---|
| A1 截断前捕获 `targetPath` + 合并保留 | `src/agy-steps.ts` | ✅ |
| A2 `StringDecoder` 替换裸 `toString('utf8')` | `src/index.ts` 后台 `spawnOnce` | ✅ |
| A3 同步写约束注释（4 处） | `index.ts` / `agy-panel.ts` / `agy-models.ts` / `agy-usage.ts` | ✅ |

**批次 B（前端 + 面板接口）**
| 项 | 状态 |
|---|---|
| B1 极简 Markdown（代码块 / 行内 code / 粗体） | ✅ `markdownNodes` + `inlineNodes` |
| B2 折叠（原生 `<details>`）+ 连续工具组合并 | ✅ `Disclosure` / `groupSteps` / `ToolRow` / `ToolGroup` |
| B3 历史时间线接入分组与 Markdown | ✅ `HistoryTimeline` |
| B4 运行面板：实时步骤 + 瞬时耗时 + 原始输出折叠 | ✅ |
| B5 隐藏会话（后端 `includeHidden` + 前端 ⊘/↺ 按钮 + 计数开关） | ✅ |

## 验证

- `npm test`：**145/145**
- `npm run test:panel`：9 个子套件全绿（含 `agy-steps` 20 checks、`panel-client` 6、`panel-routes` 22）
- `npm run build`：通过（tsc + client bundle 经典脚本加载校验）
- `rebuild.ps1`：check → test → pack → verify 全通过
- 产物：`dsh-external-dsh-subagent-antigravity-0.2.0-patched.19.tgz`（124,613 bytes，sha256 校验与测试产物一致）

## 生效方式（重要）

面板是 **client bundle**，已加载进 DSH 页面，因此：

```powershell
dsh plugin --profile web add <tgz 路径>
# 然后重启 DSH
```

**注意**：重启会中断当前会话（本会话正运行在 DSH 内）。另外版本号仍是 `0.2.0-patched.19`，若安装器按版本去重，需要先升到 `-patched.20` 再打包。

## 遗留

1. **未做浏览器实测**：需安装 + 重启后才能观察折叠/Markdown 效果，届时用 Playwright 截图确认。
2. `agy-usage-log.ts` 的同步写注释未补（同类，低价值）。
3. 批次 3 的 `steps` 现在真正被消费了，但**运行中 `STEP_LABEL` 等中文标签**仍沿用旧映射，可再打磨文案。

