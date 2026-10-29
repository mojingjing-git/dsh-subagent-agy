# PLAN — 把 token 用量接进面板（数据源切到 agy 的 transcript.jsonl）

状态：**已实施** · 落地版本 `0.2.0-patched.14`（本文保留为设计记录：数据源实测、
取舍与最终形态）

## 目标

1. 面板能看到**每个会话**和**每一步**的 token 消耗。
2. 顺带把历史时间线的数据源换成 agy 自己写的 JSONL 记录，顺带补上**时间戳**、
   **工具调用参数**、**模型思考**、**工具输出正文**——这些现在从 SQLite 的
   protobuf blob 里刨，既费劲又不全。

## 现状（已实测）

### 数据源 A：`~/.gemini/antigravity-cli/brain/<会话id>/.system_generated/logs/transcript.jsonl`

每行一步，明文 JSON：

| 字段 | 含义 | 出现情况 |
|---|---|---|
| `step_index` | 步序号，与 SQLite 的 `steps.idx` 一一对应 | 全部行 |
| `source` | `USER_EXPLICIT` / `MODEL` / `SYSTEM` | 全部行 |
| `type` | `USER_INPUT` / `PLANNER_RESPONSE` / `GENERIC` / `SYSTEM_MESSAGE` | 全部行 |
| `status` | `DONE` 等 | 全部行 |
| `created_at` | ISO 时间戳 | 全部行 |
| `input_tokens` / `output_tokens` / `cache_read_tokens` | token 计数 | 101/205 行（全是 MODEL 行） |
| `thinking` | 模型的思考文本 | 21/205 行 |
| `content` | 最终回复正文 | 2/205 行 |
| `tool_calls[]` | `{name, args}`，args 内含 `toolSummary` | 99/205 行 |
| `truncated_fields[]` | 哪些字段被截断 | 37/205 行 |

### 数据源 B：`~/.gemini/antigravity-cli/conversations/<会话id>.db`（现有实现）

protobuf blob 的 `steps` 表。能拿到工具名和一段回复正文，但**没有 token、没有时间戳**。

### 实测样本

| 会话 | transcript 行数 | sqlite 步数 | 输入 | 输出 | 缓存读 |
|---|---|---|---|---|---|
| 深度分析 LiteMonitor | 205 | 205 | 358,311 | 34,078 | 7,044,264 |
| Clean leftover plugin artifacts | 32 | 32 | 182,038 | 3,686 | 0 |

行数与步数一致 → **按 `step_index` 对齐可靠**。
114 个 brain 目录里 111 个有 transcript.jsonl（含插件自己跑的那些）。

## 方案

### 1. 新增 `src/agy-transcript.ts`

```ts
export interface TranscriptRow {
  stepIndex: number
  source: string
  type: string
  status: string
  createdAt: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  thinking: string | null
  content: string | null
  toolCalls: { name: string; args: Record<string, unknown> }[]
  truncated: string[]
}

export function parseTranscript(text: string): TranscriptRow[]
export async function readTranscript(conversationId: string, brainDir: string): Promise<TranscriptRow[] | null>
```

`readTranscript` 读 `<brainDir>/<conversationId>/.system_generated/logs/transcript.jsonl`；
文件不存在返回 `null`（不是空数组——要和"存在但为空"区分）。

### 2. 行 → 步骤的映射（**严格 1:1，不裂变**）

审核指出原计划「把 `PLANNER_RESPONSE.tool_calls[]` 裂变成多个工具步」是错的，
实测证据（`scratch/scripts/probe-align.mjs`）：

```
transcript rows: 205   sqlite steps: 205
idx | transcript.type        | sqlite.type        | tool_calls | has content | has thinking
  0 | USER_INPUT             | user_input         |          0 |        true |       false
  1 | PLANNER_RESPONSE       | agent_response     |          1 |       false |        true
  2 | GENERIC                | tool               |          0 |        true |       false
type mismatches: 0/205
tool_calls length distribution: 0:106, 1:99
```

- transcript 的每一行**就是** SQLite 的一个步（`step_index` ↔ `idx` 严格对齐）
- `GENERIC` **本身就是工具执行步**，工具名与参数在上一条 `PLANNER_RESPONSE` 的
  `tool_calls[0]` 里
- `tool_calls` 数组长度只可能是 0 或 1（全库 99 次调用全是 1）→ 没有并行多工具，
  **不需要也不应该裂变**

最终映射：

| transcript 行 | 生成的步骤 | text | tool |
|---|---|---|---|
| `USER_INPUT` | `user_input` | `content` | — |
| `PLANNER_RESPONSE` | `agent_response` | `content ?? thinking ?? ''` | — |
| `GENERIC` | `tool` | `content`（工具输出） | `name`/`parameters` 取自**上一条** `PLANNER_RESPONSE` 的 `tool_calls[0]` |
| `SYSTEM_MESSAGE` | `system_message` | `content` | — |

token 归在产生它的那一步（`agent_response` 步）上。

**正文优先级（审核阻塞项 1）**：原计划写 `thinking ?? content` 是反的。实测
第 193 步 `content` 是 2199 字符的最终报告、`thinking` 只有 428 字符的中间思考——
按原计划会把最终报告丢掉。正确顺序是 `content ?? thinking ?? ''`，且 `thinking`
另存为可选字段，**不冒充正文**。

**工具参数要解一层 JSON（审核阻塞项 3）**：agy 把 `args` 的每个值又序列化了一次：

```json
"args": {"CommandLine":"\"dir /a\"","WaitMsBeforeAsync":"5000","toolSummary":"\"List directory contents\""}
```

逐值 `JSON.parse` 后才是真值（`dir /a`、`5000`→数字、`List directory contents`）；
解析失败就保留原字符串。


### 3. 数据承载

`StepEvent` **不改已有字段**（审核建议项 1）——`usage: Record<string, number> | null`
与 `at?: number` 早就存在，只是历史路径没填：

- `usage` ← `{ input_tokens, output_tokens, cache_read_tokens }`
- `at` ← `Date.parse(created_at)`

**新增一个可选字段**（思考过程需要单独放，不能冒充正文）：

```ts
/** The model's reasoning, when agy kept it. Never the reply itself. */
thinking?: string
```

`ConversationHistory` 增加：

```ts
source: 'transcript' | 'database' | 'merged' | 'missing' | 'unreadable'
totals?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
```

`totals` 由各步 usage 累加。

### 4. 合并策略（`src/agy-history.ts`）

`readConversationHistory(conversationId, conversationsDir, brainDir?)`：

1. 读 transcript（`brainDir` 给了且文件存在）
2. 读 SQLite（现有逻辑）
3. 按 `index` 合并（两边索引严格对齐，逐 index 配对）：
   - token、时间戳、工具参数、工具输出、思考 → transcript
   - 回复正文 → transcript 的 `content` 优先；没有 `content` 但有 `thinking` → 用
     `thinking`；都没有 → 取 SQLite 解出的正文；**若 SQLite 解出的只是模型名
     （`Gemini 3.8 Flash (High)` 这类），则 `text` 留空**，交由前端显示
     「（agy 没有保存这条回复的正文）」（审核建议项 2）
4. transcript 整个缺失 → 纯 SQLite 路径（**现在的行为不变**）


### 5. API

- `POST /api-agy/history` → 返回值加上每步的 `usage` / `at`，以及会话级 `totals`。
- `POST /api-agy/conversations` **不**加 token 合计（列表一屏要读 9 个会话的
  transcript，收益小、代价大）；合计只在选中会话时算。

### 6. 客户端（`src/client.js`）

**约束（审核建议项 3）**：`src/client.js` 被 `scripts/build.mjs` 用
`copyFileSync` 原样复制到 `lib/client.js`，再用 `vm.runInNewContext` 以经典脚本
方式校验执行。改动必须保持现有的原生 JS + React `h()` 调用范式 —— 不能引入
TypeScript 注解、不能引入 ESM `import`/`export`，否则构建脚本的沙箱校验会直接
失败。

- 时间线顶部一行会话合计：**输入 / 输出 / 缓存读** 三个数**分开列**
  （用户已选口径：缓存读单列，不与输入相加，因为它是折扣计费的部分）。
- 每步右侧显示该步的 token（输入 → 输出）。
- 每步左侧显示时间戳（`HH:MM:SS`，来自 `created_at`）。
- 工具步显示 `args`（用解过 JSON 的完整参数）。
- `thinking` 单独一行（浅色、斜体），**不与正文混在一起**。


### 7. 测试

| 文件 | 覆盖 |
|---|---|
| `test/agy-transcript.mjs`（新） | 用临时 brain 目录造假 JSONL：行解析、1:1 类型映射、工具参数解一层 JSON、`GENERIC` 借上一条 `PLANNER_RESPONSE` 的工具信息、token 归位、`created_at` → `at`、文件缺失返回 `null` |
| `test/agy-history.mjs`（扩） | transcript + SQLite 合并：正文优先级 `content > thinking > SQLite`、SQLite 只有模型名时 `text` 留空、token/at 取自 transcript、transcript 缺失时 SQLite 仍可用、`totals` 累加、`source` 取值 |
| `test/panel-client.mjs`（扩） | 时间线渲染合计与每步 token、缓存读不计入总数 |
| `test/agy-usage.mjs`（新） | 额度刷新 bug：`peek()` 的 stale 随时间更新、TTL 过期后 `read(false)` 会触发探测 |
| `test/agy-steps.mjs` | 不动（实时流路径未改） |
| 全量 | `npm test` 93 项 + `npm run test:panel` 现有 60 项 + 新增用例 |


### 8. 交付

- 版本 → `0.2.0-patched.13`；`PATCH.md` / `README.md` / `README.zh.md` 补上 token 与
  transcript 数据源的说明
- `node scripts/pack.mjs` 打包 → 装进 `desktop` 与 `agy` 两个 profile → 同步
  `pnpm-lock.yaml` 的 integrity
- 分批 commit 并 push 到 `main`
- **需要重启 DSH 才生效**（插件在 host 启动时加载）

## 附录 A：额度卡刷新太懒（顺带修，与 token 改动同批发布）

### 根因（代码 + 实测证据）

1. `src/agy-usage.ts:135-141` —— `peek()` 第一行就是 `if (this.last !== null) return this.last`：
   内存快照一旦存在就**原样返回**，`stale` 标记停在首次 `buildReport()` 算出来的值，
   **永不随时间更新**。
2. `src/agy-panel.ts:366-375` —— `/api-agy/usage` 路由靠 `peeked.stale` 决定要不要在
   后台发起探测：`if (peeked === null || peeked.stale || force)`。因为 `stale` 永远
   是 `false`，**自动刷新分支永远不触发**。
3. 结果：只有手动点「刷新额度」（`force=true`）才会真正探测；自动轮询（侧边栏徽标
   60s、面板 120s）每次拿回来的都是同一份旧数据 —— 看起来就是"懒得刷新"。
4. 实测印证：磁盘缓存 `F:\Agent\dsh-home\agy-usage-cache.json` 的 `fetchedAt` 距当时
   8 分钟未更新，而 TTL 本应只有 5 分钟。
5. 探测本身很慢：实测 `agy --print "/usage"` 一次 **9.6 秒**，所以刷新必须是后台的，
   不能挡着 UI。

### 修法

| # | 改动 | 位置 |
|---|---|---|
| 1 | `peek()` 按 `Date.now() - this.last.fetchedAt > this.ttlMs` **重算 stale**（返回副本，不改内部状态） | `src/agy-usage.ts` |
| 2 | TTL 从 5 分钟降到 **60 秒** | `src/agy-usage.ts` `DEFAULT_TTL_MS` |
| 3 | 侧边栏徽标轮询 60s → **30s**；面板轮询 120s → **30s**（服务端 TTL + 单飞保护，不会每次都探测） | `src/client.js` |
| 4 | 手动刷新按钮在探测期间显示「刷新中…」；hover 里补上「数据更新于 HH:MM:SS」 | `src/client.js` |

预期效果：额度数字最多滞后约 1 分钟（探测 9.6 秒在后台跑，UI 期间显示旧值并标注
「缓存」/「刷新中」），而不是现在几十分钟不动。



## 不做（明确排除）

- 不改实时流的协议解析（`usage` 已经在解析，只加显示）。
- 不碰额度卡（那是 `agy --print "/usage"` 的百分比，与 token 不是一回事）。
- 不给会话列表加 token 合计（见 §5）。
- 不动 `agy --print` 的任何调用方式。

## 审核记录（2026-10-29，antigravity 评审 + 我逐条实测复核）

结论「需要修改」，三条阻塞项**全部经实测复核成立**：

| 阻塞项 | 实测证据 | 处置 |
|---|---|---|
| 1. 正文优先级写成 `thinking ?? content`，会把最终报告当思考丢掉 | 第 193 步：`content` 2199 字符（最终报告）vs `thinking` 428 字符 | 改为 `content ?? thinking ?? ''`，`thinking` 另存字段 |
| 2. `PLANNER_RESPONSE` 裂变出多个工具步，破坏与 SQLite 的 1:1 对齐 | `type mismatches: 0/205`；`tool_calls` 长度分布 `0:106, 1:99` | 严格 1:1 映射；`GENERIC` 借上一条的工具信息 |
| 3. `args` 的值是二次 JSON 序列化，直接用会带引号 | `"CommandLine":"\"dir /a\""` → 解码 `"dir /a"`；`"5000"` → 数字 | 逐值 `JSON.parse`，失败保留原串 |

建议项 1–3 已吸收：`StepEvent` 不改已有字段（只新增可选 `thinking`）；正文为空时
让前端统一显示「没有保存正文」；`src/client.js` 保持经典脚本范式（build.mjs 用
`vm.runInNewContext` 校验）。



| 风险 | 对策 |
|---|---|
| brain 目录被清理/不存在 | 回落到现有 SQLite 路径，行为不变 |
| transcript 行与 sqlite 步数不一致 | 按 `step_index` 合并而非按位置；缺失的步不补 |
| `thinking`/`content` 被 `truncated_fields` 截断 | 显示时标注"（已截断）" |
| 缓存读 token 与输入混算 | UI 分开列，不相加；README 写明口径 |
| 性能：单会话 transcript 最大约 450KB | 只在选中会话时读；解析为流式逐行 |

## 验收

1. 面板时间线顶部显示该会话的 输入 / 输出 / 缓存读。
2. 每步显示时间戳与该步 token。
3. 工具步显示完整参数与工具输出。
4. 拔掉 brain 目录（模拟）后面板仍能显示时间线（走 SQLite 回退）。
5. 全部测试通过；打包、安装、提交完成。
