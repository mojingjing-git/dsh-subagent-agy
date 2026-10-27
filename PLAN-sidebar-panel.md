# AGY 侧边栏面板 —— 实施计划（v2）

> 目标：在 DSH 侧边栏底部加一个「AGY」入口按钮（运行数徽标 + 自家模型五小时额度），
> 点击打开右侧栏的「AGY」tab：顶部四张额度卡，列表列出**经插件跑过**的 agy 会话
> （标题 / 时间 / 状态 / 模型），行内输入框「接着跑」，**输出统一进面板底部的独立输出区**。

> v2 修订：按代码复核结果改了 6 处（路由形态、S3 前提、读取游标、usage 缓存、注册表清洗、
> client 注册时机），并把「接着跑」的输出区从"行内展开"改为"底部独立输出区"。

## 0. 已拍板的决策

| # | 决策 |
|---|---|
| 1 | 「接着跑」= 行内**只展开输入框**；提交后该行变「运行中」，**输出进面板底部独立输出区**（固定约 40% 高、可拖拽、带停止/复制），不做行内长文本 |
| 2 | 面板顶部显示**全部四个**额度；footer 徽标只显示**自家模型族 × 五小时窗口** |
| 3 | 会话列表**只显示经插件跑的那批**（`~/.dsh/agy-conversations.json`） |
| 4 | footer 按钮放**最下方** |
| 5 | 不加 `guide` 条目（会改变右栏默认页规则），只从 footer 按钮进入 |

## 1. 已验证的事实（本机实测，v2 复核）

### 1.1 agy CLI（v1.4.7）

```
$ agy --print "/usage"           # 实测 8.8–12.0 s，不产生新会话（110 → 110）
Gemini Models	Weekly Limit Remaining	80%	2026-10-29T10:17:27Z
Gemini Models	Five Hour Limit Remaining	95%	2026-10-27T06:12:16Z
Claude and GPT models	Weekly Limit Remaining	82%	2026-10-30T18:06:16Z
Claude and GPT models	Five Hour Limit Remaining	100%	2026-10-27T07:03:17Z
```

- TSV 四列：`模型族` / `窗口` / `剩余百分比` / `重置时间(ISO UTC)`；四额度 = 2 族 × 2 窗口。
- 徽标：`config.model = gemini-3.8-flash-high` → 族 **Gemini Models** → 取 `Five Hour Limit Remaining`。
- **必须缓存**：单次 9–12 秒、且百分比会随时间走（两次调用之间 96% → 95%）。TTL 5 分钟 +
  单飞 + 落盘上次结果，否则每次 DSH 启动都会拉一个 agy 进程、连点两下会堆进程。

### 1.2 会话数据

- **注册表路径 = `registryFilePath(config)`**（`src/index.ts:469`，受 `DSH_HOME` / `config.registryPath`
  影响，不要硬编码 `~/.dsh`）。记录形如：
  ```json
  "session-<id>::agy::<n>": { "conversationId": "73833e31-…", "cwd": "G:\\TOOL\\LiteMonitor-fork",
                              "label": "独立审核执行计划", "createdAt": 1793064713780 }
  ```
- **现状（本机）**：31 条，其中 **22 条是 `test-session::` + `fake-conversation-0001`**，真实只有 9 条；
  9/9 的 `<conversationId>.db` 都存在。→ 准入条件用 **`~/.gemini/antigravity-cli/conversations/<cid>.db` 存在**，
  再按 `conversationId` 去重（同一会话可能有多个键）。这比按 key 前缀过滤更干净。
- **模型**：9 个 .db 共 10.1 MB，正则扫一遍 21 ms。但**不能取最高频**：实测
  `gemini-3.8-flash-n` 247 次 vs `gemini-3.8-flash-high` 101 次，取高频会取错。
  → 新记录在写注册表时就带 `model`（插件自己的文件，加字段零风险）；老记录才回退到扫描，
  取**最后一次出现**（byte offset 最大）而不是最高频。
- 兜底标题：`~/.gemini/antigravity-cli/annotations/<cid>.pbtxt` 的 `title:"…"`。
- 不再依赖 `node:sqlite`：标题/时间/模型/目录四项都能从注册表 + annotations + 正则拿到，
  sqlite 只在"想显示 step_count/status"时才需要，v1 先不做。

### 1.3 「接着跑」

- agy 原生支持 `agy --conversation <id>`；插件已有该路径（`src/index.ts:1473`、
  `followup()` 在 `:1387`）。
- **`--output-format stream-json` 已经是默认**：`config.outputFormat` 默认 `'json'`（`:261`），
  `streamMode = jsonMode && (support.streamJson || !probed)`（`:1361`）。**不需要再加这个 flag**。
- 真实事件格式（取自 `~/.dsh/agy-transcripts/*.ndjson`，187 行样本）：
  ```
  prompt / init / step_update ×184 / result
  step_update.step_update: { step_index, state: ACTIVE|DONE, step_type: user_input|agent_response|tool|system_message,
                             text_delta?, tool_name?, tool_info?, duration_seconds?, usage? }
  result.result: { conversation_id, status, response }
  text_delta 出现在 148/184 条；tool_name/tool_info 出现在 22 条 → 面板可以显示"正在调用工具 X"
  ```
- 复用现成实现，不要另写解析器：`startBackground()`（`:1648`）里已有
  `consumeLine`（`:1699`）、`appendVisible`（`:1671`）、NDJSON 落盘、`trackActive`（`:1852`）。
- **两个坑（v2 必改）**：
  1. `runOnce → spawnPlan` 依赖 `request.parent.session.{id,header.cwd}`（`:1261`、`:1365`）和
     `request.signal`（`:1030`、`:1619`）；**web 路由里没有 Agent**。→ 新增 `startStreaming()`，
     在 provider 内部合成 `{ session: { id, header: { cwd } } }` 作为 parent（只读这两个字段）。
  2. `readOutput()` 是**破坏性游标**（`:1834`：`visible.slice(readOffset); readOffset = visible.length`），
     两个 pane / 刷新 / 重试都会丢字，也会抢走 `job_output` 的内容。→ 路由侧自持累积缓冲，
     客户端带 `since` 增量拉取。

### 1.4 DSH 客户端契约（已核对 app.asar 内实现与 chat-import 0.26.2）

- `sidebar.footer.action`：**kind=list，scope=root**，cell 只收到 `{ wide }`；shipped 占用者只有
  `client-ui-cordis` 的 `cordis-panel`（不是"order 0/1/2"）。注册菜单项形如
  `ctx.slots.register({ name:'sidebar.footer.action', id:'agy', order:100, label:'AGY' }, Button)`，
  `order` 升序 → 100 在最下。
- `sidebar.right.pane.tab`：body 用 `ctx.slots.register({ name:'sidebar.right.pane.tab', key: definition.id }, Body)`，
  Body 内用 `useTabInfo()` 取 `{ sidebar, panel, tab }`；打开用 `ctx.get('sidebarRight').openTab(kind)`。
- **tab 类型注册必须包在 `ctx.effect()` 里**：`id` 全局唯一，重复注册会抛错（热重载会炸）；
  `ctx.effect(() => tabs.register({...}), 'agy tab type')`。
- client 模块 `inject` 至少 `['slots','sidebarRightTabs']`（chat-import 是 `['slots','locale','sidebarRightTabs']`）。
- `ctx.get('sidebarRight')` 每次点击重新取 + `try/catch` + 返回 false（照抄 chat-import `lib/client.js:4203`）。
- client → host 用相对路径 `fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body})`
  （chat-import `postJson`，`lib/client.js:1510` 起）——同源、无 token；`application/json` 恰好挡住
  跨站表单 POST（CSRF 预检）。
- host 路由注册：`ctx.inject(['webServer'], (webCtx) => webCtx.webServer.register(route))`，
  **只支持 `exact` / `prefix`，没有 `:param`**；`jsonRoute` 必须是 `kind:'exact'`。

## 2. 架构

```
┌─ DSH 客户端 ──────────────────────────────────────────────┐
│ sidebar.footer.action  [AGY ●2 95%] ──点击──► sidebarRight.openTab('agy')
│                                                          │
│                        sidebar.right.pane.tab  key='agy' │
│                        ┌─────────────────────────────────┴──┐
│                        │ 四张额度卡（2 族 × 2 窗口）            │
│                        ├────────────────────────────────────┤
│                        │ 会话列表（可滚）                       │
│                        │  行 = 标题 · 相对时间 · 状态点 · 模型   │
│                        │  [接着跑] → 行内只出输入框             │
│                        ├────────────────────────────────────┤
│                        │ 输出区（~40% 高，可拖拽）              │
│                        │  标题 · 运行中 12s · 工具: read_file   │
│                        │  [停止] [复制] [打开 transcript]      │
│                        └────────────────────────────────────┘
└───────────────────────────────┬───────────────────────────┘
                                │ 全部 POST + JSON
┌─ 插件 host 半侧（cordis）──────▼───────────────────────────┐
│ /api-agy/usage        → { rows[4], badge, fetchedAt, stale }│
│ /api-agy/conversations→ { items[] }                         │
│ /api-agy/running      → { count, runs[] }                   │
│ /api-agy/continue     → { runId }                           │
│ /api-agy/run          → { status, text, cursor, tool }      │
│ /api-agy/cancel       → { ok }                              │
│ /api-agy/prefs        → 隐藏列表（可选，S5 末尾）              │
│                                                             │
│ 内部：provider.startStreaming()（复用 startBackground 核心）  │
│       → agy --conversation <id> --output-format stream-json  │
│       → 事件写入 RunStore（累积缓冲 + cursor + tool 名）        │
└─────────────────────────────────────────────────────────────┘
```

## 3. 逐文件改动清单

### 3.1 `package.json`

```jsonc
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "default": "./lib/client.js" }          // 新增
},
"files": ["lib", ...],                                  // lib 已覆盖 lib/client.js
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {                                           // 新增
    "inject": ["@deepseek-ai/dsh-client-locale"],
    "platform": "web"
  }
},
"peerDependencies": {
  "@deepseek-ai/dsh": ">=0.1.5-rc.1",                   // 新增（sidebarRightTabs 门槛）
  "@deepseek-ai/dsh-client-locale": ">=0.1.0-rc.6",     // 新增
  "react": ">=18.0.0",                                  // 新增
  ...其余不动
}
```

### 3.2 `src/index.ts`（host 半侧）

1. `TaskRecord`（`:344`）加 `model?: string`；`loadTaskRegistry` 的字段拷贝（`:544`）加一行；
   写记录处一起写 `model: config.model`。
2. 把 `startBackground()`（`:1648`）的正文抽成私有
   `startStreaming(request, conversationId, cwdOverride, dirs, ceiling)`，`startBackground` 改为调它并传
   `undefined, undefined`；新增公开入口：
   ```ts
   startPanelRun(input: { sessionId: string; baseCwd: string; label: string; prompt: string;
                          conversationId: string; cwd: string }): Promise<AntigravityBackgroundHandle>
   ```
   内部合成 `parent`（只被读 `session.id` / `session.header.cwd`）+ 自己的 `AbortController.signal`，
   再调 `startStreaming`。**不改 `spawnPlan` 的签名**，避免动到四个现有工具的路径。
3. `apply()` 末尾：`registerAgyPanel(ctx, { config, provider, loadRecords, registryPath, listActive, log })`。
4. `inject` 保持 `['subagents','subprocess','tools']`；webServer 用 `ctx.inject` 延迟挂载。

### 3.3 新增 `src/agy-usage.ts`

```ts
export interface UsageRow { family: string; window: string; percent: number; resetAt: string }
export function parseUsage(stdout: string): UsageRow[]            // 纯函数，可直接单测
export function familyOfModel(model: string): string             // gemini* → 'Gemini Models'，否则 'Claude and GPT models'
export function pickBadge(rows: UsageRow[], family: string): UsageRow | null
export class UsageReader {
  constructor(opts: { command: string; env: Record<string,string>; cwd: string;
                      cachePath: string; ttlMs: number; badgeFamily: string;
                      run?: () => Promise<string> })
  read(force?: boolean): Promise<UsageReport>   // TTL + 单飞 + 失败降级到磁盘缓存（stale:true）
}
```
- 默认 runner：`execFile(command, ['--print','/usage'], {env, cwd, timeout})`，10 分钟超时无意义，用 60s。
- 缓存文件 `~/.dsh/agy-usage-cache.json`：`{ rows, fetchedAt }`。

### 3.4 新增 `src/agy-conversations.ts`

```ts
export interface ConversationItem { key: string; conversationId: string; label: string;
                                    cwd: string; createdAt: number; model: string | null;
                                    cwdExists: boolean }
export function listConversations(opts: {
  records: Record<string, TaskRecord>
  conversationsDir: string
  annotationsDir: string
  hidden: readonly string[]
  limit?: number
}): ConversationItem[]
```
- 准入：`<cid>.db` 存在；按 `conversationId` 去重取 `createdAt` 最大的一条；跳过 `hidden`。
- 标题：`label` → annotations → `agy conversation <cid.slice(0,8)>`。
- 模型：`record.model` → 扫 `.db`（latin1 + `gemini-[0-9][\w.\-]*`，取**最后**一个匹配）。
- 按 `createdAt` 倒序，默认上限 100。

### 3.5 新增 `src/agy-panel.ts`

- `RunStore`：`Map<runId, { conversationId, label, status, text, cursor?, tool, startedAt, endedAt, error, handle }>`；
  最多保留 20 条 / 1 小时。
- `registerAgyPanel(ctx, deps)`：`ctx.inject(['webServer'], ws => { ... })` 注册 6 条路由：
  | 路由 | 方法 | 入参 | 出参 |
  |---|---|---|---|
  | `/api-agy/usage` | POST | `{force?}` | `{ok, rows, badge, fetchedAt, stale}` |
  | `/api-agy/conversations` | POST | `{}` | `{ok, items}` |
  | `/api-agy/running` | POST | `{}` | `{ok, count, runs}` |
  | `/api-agy/continue` | POST | `{conversationId, prompt}` | `{ok, runId}` |
  | `/api-agy/run` | POST | `{runId, since}` | `{ok, status, text, cursor, tool, elapsedMs, error}` |
  | `/api-agy/cancel` | POST | `{runId}` | `{ok}` |
- `continue` 校验：`conversationId` 必须出现在 `loadRecords()` 里（cwd 从记录取，**绝不接受客户端传 cwd**）；
  `prompt` 非空且 ≤ 30000 字符；同一 conversationId 正在跑时返回 409 `{ok:false,error:'already running'}`。
- `run`：从 `RunStore` 拿缓冲，返回 `buf.slice(since)` + 新 cursor；`since` 超过缓冲长度则回 `{reset:true, text:buf}`。
- 统一 `jsonRoute`：`kind:'exact'`；handler 抛错 → 500 `{ok:false,error}`；`byOk` 把 `ok:false` 映射 400。

### 3.6 `src/client/client.js`（手写单文件，不走 tsc）

- 包裹：`window.__ModuleLoader__.load({ id: '<pkg>', factory: (require) => {…} })`。
- `inject = ['slots','sidebarRightTabs']`（locale 可选，本次文案先中文硬编码）。
- `apply(ctx)`：
  - `ctx.effect(() => tabs.register({ id: AGY_TAB_ID, kind: 'agy', title: () => 'AGY' }), 'agy tab')`
  - `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key: AGY_TAB_ID }, AgyPanel))`
  - `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name:'sidebar.footer.action', id:'agy', order:100, label:'AGY' }, AgyButton))`
- `AgyButton({wide})`：图标 + （wide 时）「AGY」+ `●N` + `95%`；3s 轮询 `/running` 与 `/usage`
  （`document.hidden` 时暂停；usage 只在挂载时打一次，之后 5 分钟一次）；点击 `openTab`。
- `AgyPanel`：
  - 额度卡 ×4（窄了 2×2），每张 `族 · 窗口` / 百分比 / 重置倒计时；
  - 列表行：标题、相对时间、状态点（运行中/空闲）、模型、`cwdExists=false` 时灰色；
  - `[接着跑]` → 行内 textarea + 发送（Ctrl+Enter）；提交后该行显示"运行中"，输出进底部区；
  - 底部输出区：`status · elapsed · 工具名`，`pre` 滚动文本，`[停止]`、`[复制]`；
  - 轮询 `/api-agy/run {runId, since}`，1s；`done/failed/cancelled` 后停；
  - 空态/加载态/错误态；`agy 未就绪` 时给一句提示而不是空白。
- 状态放在组件外的模块级 store（`Map<conversationId, runId>`），切 tab 不丢。

### 3.7 `scripts/build.mjs` / `scripts/pack.mjs`

- `build.mjs` 末尾加一步：`copyFileSync('src/client/client.js', 'lib/client.js')`
  （`lib` 已存在；不做 tsc）。
- `pack.mjs` 的 `INCLUDE` 已含 `lib` → 无需改；产出 tgz 里应能看到 `package/lib/client.js`。

### 3.8 安装与联调

- `pwsh -File rebuild.ps1`（typecheck → build → pack）或手动三步。
- 改 `C:\Users\wrz20\.dsh\profiles\{desktop,agy}\package.json` 里该插件依赖 → 新 tgz → `pnpm install` → **重启 DSH**。
- 版本号 `0.2.0-patched.9`（不覆盖旧包，可回退）。

## 4. 实施步骤（每段可独立验证）

| 阶段 | 内容 | 验证 |
|---|---|---|
| S1 | `agy-usage.ts` + `agy-conversations.ts` + `TaskRecord.model` | `node test/panel-sources.mjs` 输出四行额度与 9 条真实会话，字段齐全；再跑 `node test/run.mjs` 确认原有用例不红 |
| S2 | `agy-panel.ts` 路由（含 `startStreaming` 桩） | 重启后 `curl -X POST 127.0.0.1:2774/api-agy/usage`、`/conversations`、`/running` 看 JSON |
| S3 | `provider.startPanelRun()` 真流式 | 对一条真实会话发 `continue`，`/api-agy/run` 的 `text` 逐秒变长、`tool` 会变 |
| S4 | 打包契约 | `lib/client.js` 存在；`node scripts/pack.mjs . out.tgz` 输出里含 `package/lib/client.js` |
| S5 | client UI（footer + tab + 底部输出区） | 重启后 footer 出现 `AGY ●N NN%`；点击开出 tab；四卡数字与 `/usage` 一致 |
| S6 | 端到端「接着跑」 | 面板里续一条会话，agy 侧上下文延续；`_tasks` 能看到、`_cancel` 能停 |
| S7 | 文档 README.zh.md / PATCH.md | — |

## 5. 验收标准

1. footer 出现「AGY」按钮，**无白屏**（console 无 fiber/注册错误）
2. 按钮旁显示运行数 `●N` 与自家模型五小时额度（如 `95%`）
3. **点按钮**后右栏出现 AGY tab（不是 CTRL+ALT+B 自动出现），四张卡数字与 `agy /usage` 一致
4. 列表只有经插件跑过、且 `<cid>.db` 存在的会话；标题/时间/状态/模型齐全；无 `test-session` 假行
5. 「接着跑」行内输入 → 提交 → **底部输出区**逐字增长，工具调用有状态提示
6. 续跑确实续上原会话（agy 侧上下文延续）
7. 原有四个工具（antigravity / _followup / _tasks / _cancel）行为不变；面板启的 run 也能被 `_tasks`/`_cancel` 看到
8. 停掉续跑：面板 `[停止]` 与 `_cancel` 都能终止进程

## 6. 风险与已知坑

| 风险 | 处置 |
|---|---|
| 裸 `slots.register` 导致白屏 | 一律 `slots.inject` 惰性注册；tab 类型注册包 `ctx.effect` |
| `agy /usage` 9–12 s / 并发堆进程 | TTL 5 min + 单飞 + 磁盘缓存 |
| `readOutput()` 破坏性游标 | 不用它做轮询源；`RunStore` 自持缓冲 + `since` |
| 续跑需要 Agent，web 路由没有 | `startPanelRun()` 内部合成只含 `session.id/header.cwd` 的 parent |
| 注册表测试污染（22/31） | 准入 = `<cid>.db` 存在 + `conversationId` 去重 |
| 模型取最高频会取错 | 新记录写 `model`；老记录扫 `.db` 取最后一次出现 |
| `agy` 未安装/未登录 | 所有路由 `ok:false` + 面板提示；usage 返回 stale 缓存 |
| 改完不重启 DSH 看不到变化 | 装包后必须重启 |
| tgz 影响现有 profile | 新版本号 patched.9，不覆盖旧包，可回退 |

## 7. 预估工时

| 项 | 估时 |
|---|---|
| S1 数据源层 | 0.5 天 |
| S2 host 路由 | 0.5 天 |
| S3 接着跑流式通道 | 1.5 天（要抽 `startStreaming` + RunStore） |
| S4 打包契约 | 0.25 天 |
| S5 client UI | 2 天（底部输出区 + 停止 + 增量轮询） |
| S6/S7 联调 + 文档 | 0.5 天 |
| **合计** | **约 5.25 天** |
