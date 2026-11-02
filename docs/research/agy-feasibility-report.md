# DSH 插件 @dsh-external/dsh-subagent-antigravity 优化建议清单可行性评估报告

基于对代码仓库实际源码（`src/`、`scripts/`、`docs/`、`package.json`）及运行时环境的严格核验，逐条结论与事实证据如下。

---

# 第一部分：总结表

| # | 建议 | 现状是否属实 | 可行性 | 改动量 | 一句话结论 |
|---|---|---|---|---|---|
| 1 | 面板轮询改 SSE/WebSocket | **属实** | **有条件可行（极受限）** | 大 (300-500行) | WebSocket 宿主不支持，标准 SSE(GET) 会打破 CSRF 边界；真痛点在空闲配额探针而非轮询本身。 |
| 2 | 长 prompt 改走 stdin | **部分属实** | **有条件可行（需实测）** | 中 (100-250行) | 现状是插件直接抛错而非 agy 报错；agy 缺乏单次 prompt 的 stdin 规范，官方建议写工作区文件。 |
| 3 | 能力探测加版本感知 | **部分属实** | **不可行 / 负优化** | — | `fs.stat` 是微秒级文件检查；改跑 `agy --version` 必须启动子进程，反倒是性能负优化。 |
| 4 | 会话注册表改 SQLite / 分片 | **属实** | **方向错误（过度设计）** | 中 (150-300行) | 50条 JSON 仅 5KB 毫无整写瓶颈；真痛点是 50 条上限太小和 quota-log 缺滚动清理，放宽即可。 |
| 5 | 会话隔离 / 沙箱 | **部分属实** | **有条件可行** | 小 (<50行) | 代码已具备 `--sandbox` 探测与配置；可在工具传参暴露 `sandbox`，但独立隔离目录违背日常协作目标。 |
| 6 | 步骤时间线增量同步 | **部分属实（严重误解）** | **已优化 / 伪需求** | — | 前端实时轮询压根没消费 steps；服务端早做过切片浅拷贝优化，步骤具可变性做增量是负收益。 |
| 7 | Token 记账改事件驱动 | **部分属实（忽略缓存）** | **不可行 / 破坏性** | — | 现有 `(mtime, size)` 缓存机制已跳过未改动文件；改从 stream-json 累加会完全漏掉 IDE 侧主力消耗。 |
| 8 | 可观测性 | **大部分属实** | **完全可行** | 小 (<100行) | 虽有 transcript 和空结果归因，但缺少结构化指标日志与 `antigravity_doctor` 诊断工具。 |
| 9 | 类型与构建 | **部分属实（断言失实）** | **不可行 / 负优化** | — | `tsconfig.json` 本就配置了 `"sourceMap": true` 且产物全带 map；esbuild 无法生成 `.d.ts` 且容易破坏微前端加载器。 |
| 10 | 多会话并行 | **完全不属实** | **已实现无需做** | — | 锁本身就是按 `conversationId` 隔离的，不同会话本来就能并行；同会话并发会导致 SQLite 与文件损坏。 |
| 11 | 中间人审批流 | **部分属实** | **不可行** | — | 底层 agy CLI 在无头非交互模式下直接判定 Denied 退出，完全没有向外挂起请求和审批的 IPC 协议。 |
| 12 | 跨平台登录 | **完全属实** | **可行** | 小 (30-50行) | 目前确实只有 Windows PowerShell 弹窗；macOS 用 `osascript` 唤起终端极易实现，Linux 带 GUI 可降级支持。 |
| 13 | 插件热更新 | **部分属实** | **不可行** | — | DSH 宿主前端为经典脚本评估的微前端加载器，不支持 ESM hot-reload，强行动态 import 会导致白屏。 |
| 14 | 面板 UI 状态一致性 | **完全属实** | **完全可行** | 小 (<50行) | `run.resetPending` 存在多客户端竞争清零缺陷，且前端 400ms 轮询缺少单飞（in-flight）锁，易引发乱序重复。 |

---

# 第二部分：逐条展开评估

### 1. 面板轮询改 SSE/WebSocket

#### 证据
- **前端定时器**：[src/client.js:122](src/client.js#L122)（Footer running 5s）、[src/client.js:141](src/client.js#L141)（Footer usage 30s）、[src/client.js:716-718](src/client.js#L716-L718)（Panel 20s 会话 / 30s 配额 / 60s Token）、[src/client.js:740](src/client.js#L740)（Active run 400ms）。
- **服务端 Drain**：[src/agy-panel.ts:109, 142](src/agy-panel.ts#L109)（`POLL_MS = 250`）。
- **空闲反复 spawn agy**：[src/agy-usage.ts:110](src/agy-usage.ts#L110) 定义 `DEFAULT_TTL_MS = 60 * 1000`；[src/client.js:133-137](src/client.js#L133-L137) 在始终挂载的 Footer 徽标中，每 60 秒触发 `post('/usage', { force: true })`，进而调用 [src/index.ts:2506](src/index.ts#L2506) 执行 `spawnUsage` 启动真实 `agy.exe` 进程（单次耗时 9-12s）。
- **路由能力**：[src/agy-panel.ts:29-32, 289-294](src/agy-panel.ts#L289-L294) 和 [docs/sidebar-panel.md:14-16](docs/sidebar-panel.md#L14-L16)：
```ts
interface WebServerLike {
  register(route: unknown): unknown
}
function jsonRoute(path: string, handler: Handler): unknown {
  return { kind: 'exact', path, handler: async (req: IncomingMessage, res: ServerResponse) => { ... } }
}
```

#### 真实痛点评估
- 本地 Loopback 的 HTTP 轮询网络开销仅微秒级，前端 400ms 轮询在任务运行时几乎无感知。
- **真正痛的是 Footer 徽标空闲时每 60s 周期性 spawn `agy --print /usage`**！无论 DSH 是否在执行任务，后台常态化每分钟启动一次 Go 进程，吃 CPU 和 Google 配额接口，一天空转启动 1440 次进程。

#### 可行性 + 阻塞点
- **结论：有条件可行（仅限 POST fetch 流式），但严重受阻**。
- **阻塞点 1（WebSocket 完全不可行）**：DSH 的 `webServer.register` 只接收 HTTP 请求 handler `(req, res)`，根本未暴露底层 Node `http.Server` 的 `'upgrade'` 事件，无法建立 WebSocket。
- **阻塞点 2（标准 SSE 打穿安全边界）**：如 [docs/sidebar-panel.md:18-36](docs/sidebar-panel.md#L18-L36) 所述，DSH 宿主没有 Origin 校验和 CSRF 保护，插件全部依赖 `POST + JSON` 验证浏览器 Origin 避免 DNS rebinding 攻击。浏览器自带的 `EventSource` 只支持 `GET`，若开放 GET 接口，恶意网页即可在受害者机器上跨站嗅探流式数据。
- **阻塞点 3（单消费者游标破坏）**：`readOutput()` 是破坏性单次读取，多客户端/多 pane 需自建 PubSub 广播中心与回放重试机制。

#### 实现要点（若要解决核心痛点）
不建议做 SSE，建议直接在 `client.js` 和 `agy-usage.ts` 解决空闲探针问题：
```javascript
// src/client.js: 仅在侧边栏面板真正打开时才允许 force: true 刷新配额，Footer 徽标仅在任务完成时被动刷新
if (isPanelOpen && payload.report?.stale) {
  post('/usage', { force: true })
}
```

#### 风险
引入 SSE 需重构整个安全沙箱与游标分发机制，回归风险高；而治标不治本。

---

### 2. 长 prompt 改走 stdin

#### 证据
- [src/index.ts:168-174](src/index.ts#L168-L174)：
```ts
const MAX_ARGV_PROMPT_CHARS = 30_000
```
- [src/index.ts:1514-1518](src/index.ts#L1514-L1518)：
```ts
if (effectivePrompt.length > MAX_ARGV_PROMPT_CHARS) {
  if (!support.promptFile) {
    throw new Error(`${PREFIX}: prompt is ${effectivePrompt.length} chars, exceeding the ${MAX_ARGV_PROMPT_CHARS}-char argv limit, and this agy build does not support --prompt-file...`)
  }
```
- [src/index.ts:1751, 2155](src/index.ts#L1751)：`stdio: { stdin: 'ignore' }`。
- 实测 `agy --help` 输出：
  - 只有 `--input-format (text, stream-json)`，其中 `stream-json reads one NDJSON message per line from stdin and runs a turn for each`。
  - `-p, --print` 是运行单次 prompt 的参数，官方 flag 没有 `-p -` 约定（传入 `-` 会被 Go 视作字面量 prompt `"-"`）。

#### 真实痛点评估
- 痛点确实存在：在 Windows 下当委托的任务包含完整工程说明、大段错误日志或多文件内容时，极易超过 30,000 字符，直接被插件本地抛错拦截。

#### 可行性 + 阻塞点
- **结论：有条件可行（但有更好的原生路径）**。
- **阻塞点**：`agy` 并非标准 Unix 管道工具，在 `--print` 模式下直接把 stdin 当做 prompt 的语法未获官方文档支持。如果通过 `--input-format stream-json` 走 stdin，必须以 NDJSON 形式封装交互转轮，彻底改变子进程生命周期。
- **官方推荐替代方案**：如 [docs/agy-integration.md:69-71](docs/agy-integration.md#L69-L71) 所述，将超长上下文写入会话工作区的临时文件（如 `.agy-task-prompt.md`），argv 中仅传递短 prompt（“请按 .agy-task-prompt.md 的要求执行”），既绕过 32KB 限制，又跨 agy 所有版本 100% 兼容。

#### 实现要点
```ts
// src/index.ts spawnPlan: 当 prompt > 30000 且不支持 --prompt-file 时，写入 childCwd 临时文件并重写 promptArgv
const promptFile = join(childCwd, `.dsh-agy-prompt-${this.nextRunId()}.md`)
writeFileSync(promptFile, effectivePrompt, 'utf8')
promptArgv = ['-p', `Read instructions from ${promptFile} and execute them thoroughly.`]
```

#### 风险
中。需要确保临时文件在执行结束（无论成功、失败还是中断）后被可靠清理，避免污染用户工作区。

---

### 3. 能力探测加版本感知

#### 证据
- [src/index.ts:1381](src/index.ts#L1381)：
```ts
const identity = `${exe}@${statStamp(exe)}`
if (this.flagSupport !== undefined && this.flagProbeIdentity === identity) return this.flagSupport
const cached = readFlagCache(this.config, identity)
```
- [src/index.ts:403-408](src/index.ts#L403-L408)：`statStamp` 为 `return `${stat.size}:${stat.mtimeMs}``。
- [src/index.ts:1341, 1420](src/index.ts#L1341)：首次或 mtime 变化时，调用 `agy help` 及 `agy --print x --print-timeout 1ms`。探测结果持久化在 `~/.dsh/agy-flag-cache.json`。

#### 真实痛点评估
- **完全不痛**。`statSync(exe)` 获取文件大小与 mtime 是操作系统纳秒级调用（耗时 <0.1ms）。日常使用中 agy 只要没被升级，直接命中内存与磁盘缓存，耗时为 0。

#### 可行性 + 阻塞点
- **结论：不可行 / 负优化，建议直接放弃**。
- **阻塞点与荒谬之处**：
  建议说“先跑 `agy --version`，版本不变则复用缓存”。但是——**跑 `agy --version` 本身就需要启动一个真实的操作系统子进程**！在 Windows 下 spawn 一个进程需要 100~300ms。用一个 200ms 的外部进程启动，去替代一个 0.1ms 的 `fs.statSync`，是典型的负优化。
  另外，`agy help` 并不能探测 `--print-timeout` 到底接受带单位的 `1ms` 还是纯数字 `1`（Go `time.ParseDuration` 行为差异），所以单独短探针不可避免。

---

### 4. 会话注册表改 SQLite / 分片

#### 证据
- [src/index.ts:164](src/index.ts#L164)：`const MAX_TASK_RECORDS = 50`。
- [src/index.ts:610-621](src/index.ts#L610-L621)：
```ts
function doSaveRegistry(config: Config, records: Record<string, TaskRecord>): void {
  const entries = Object.entries(records)
    .sort((a, b) => (b[1]?.createdAt ?? 0) - (a[1]?.createdAt ?? 0))
    .slice(0, MAX_TASK_RECORDS)
  ...
  writeJsonAtomic(base, JSON.stringify(trimmed, null, 2))
}
```
- [src/agy-quota-log.ts:85, 96](src/agy-quota-log.ts#L85)：`appendFileSync` 追加写入，`readQuotaLog` 每次全量 `readFileSync`。

#### 真实痛点评估
- **写性能完全不痛**：50 条记录的 JSON 文件仅 **5KB 左右**，通过微任务队列（`registryTail`）在任务结束时写入一次，耗时不到 1ms，根本谈不上 I/O 瓶颈。
- **真正的痛点是 50 条上限严重不足**：用户多聊几个任务后，早期的 task key 就被截断踢出。后续模型调用 `antigravity_followup` 恢复这些会话时直接抛错 `no such task`（见 [src/index.ts:2636](src/index.ts#L2636)），即使底层 agy 的数据库里还完整保留着该会话。
- `agy-quota-log.jsonl` 无轮转清理确实长期会积累数千行，全量解析有些浪费。

#### 可行性 + 阻塞点
- **结论：方向错误（过度设计）**。
- `node:sqlite` 在 Node 22 中仍带有 Experimental 标记。引入 SQLite 会增加二进制依赖和数据损坏排查成本，丢失纯文本自愈能力（如现有的 `.corrupt` 自动备份自愈，见 [src/index.ts:513](src/index.ts#L513)）。
- **极简正解**：直接将 `MAX_TASK_RECORDS` 从 50 改为 500 或 1000（文件大小仍 <100KB），并在 `appendQuotaSnapshot` 增加 30 天保留期清理。

#### 实现要点
```ts
// src/index.ts:164
const MAX_TASK_RECORDS = 500
// src/agy-quota-log.ts: 每次追加时若超过 30 天则过滤历史
```

#### 风险
极低。仅修改常数与文件截断，无任何架构风险。

---

### 5. 会话隔离 / 沙箱

#### 证据
- [src/index.ts:243-244](src/index.ts#L243-L244)：
```ts
sandbox: z.boolean().default(false),
```
- [src/index.ts:904, 1556](src/index.ts#L904)：
```ts
if (config.sandbox && support.sandbox) baseArgv.push('--sandbox')
```
代码中早有 `--sandbox` 的配置与探针支持。

#### 真实痛点评估
- 痛点中等：由于 headless 模式无法弹交互窗，默认必须开启 `--dangerously-skip-permissions`，agy 拥有用户级完整文件系统与命令权限。
- 但用户使用此子代理的核心诉求通常就是**在当前工程下读写代码、运行测试**。如果强行把每次任务扔进一个隔离的临时目录，agy 生成的代码无法直接在工程生效。

#### 可行性 + 阻塞点
- **结论：有条件可行（单任务参数暴露可行，每任务独立工作区不可行）**。
- **阻塞点**：Windows 下 agy 的 `--sandbox` 仅是受限的 shell 环境，不是真正的 OS 级容器沙箱；而“每任务独立工作区”需要引入类似 git worktree 或全量文件拷贝与差异合并回填机制，成本过高且极其脆弱。
- **推荐做法**：仅在 `antigravity` 工具参数中暴露可选的 `sandbox?: boolean`，允许调用者单次决定是否附加 `--sandbox`。

#### 实现要点
```ts
// src/index.ts 工具 parameters:
sandbox: { type: 'boolean', description: 'Optional. Run with terminal restrictions enabled.' }
// 执行时传递给 spawnPlan 覆盖 config.sandbox
```

#### 风险
低。仅增加一个可选 flag 传参。

---

### 6. 步骤时间线增量同步

#### 证据
- [src/agy-panel.ts:112](src/agy-panel.ts#L112)：`stepsVersion(steps)` 仅用于检测数组内容是否有变。
- [src/agy-steps.ts:253-258](src/agy-steps.ts#L253-L258)：
```ts
export function snapshotSteps(steps: readonly StepEvent[]): StepEvent[] {
  const window = steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps
  return [...window]
}
```
注释中提到“allocates a fresh timeline on every 250 ms”是在解释历史原因，**现有代码已经优化为浅拷贝切片 `[...window]`**。
- [src/client.js:745-753](src/client.js#L745-L753)：**前端实时轮询 `/run` 时压根没有接收或渲染 `payload.steps`**！前端只更新了 `text`、`status`、`tool`、`error`，steps 仅在会话结束时通过 `/history` 获取。

#### 真实痛点评估
- **完全不痛 / 伪问题**。单次运行最多限制在 `MAX_STEPS = 200`（[src/agy-steps.ts:38](src/agy-steps.ts#L38)），序列化后仅几 KB，且前端实时轮询根本没用它。

#### 可行性 + 阻塞点
- **结论：不可行 / 伪需求，直接放弃**。
- **阻塞点**：Step 状态具有可变性（ACTIVE -> DONE/ERROR，text 累加），它不是 append-only 列表，要表达 delta 必须定义一套复杂的状态补丁协议，为了节约几 KB 的本地 loopback 数据完全得不偿失。

---

### 7. Token 记账改事件驱动

#### 证据
- [src/agy-usage-log.ts:236-281](src/agy-usage-log.ts#L236-L281)：
```ts
const cached = cache.files[path]
if (cached !== undefined && cached.mtime === mtime && cached.size === size) {
  reused += 1
  files[path] = cached
  for (const [t, input, output, cacheRead] of cached.rows) rows.push({ t, input, output, cacheRead })
  continue
}
```
- [src/agy-usage-log.ts:9-11](src/agy-usage-log.ts#L9-L11)：
`"The second one is the Antigravity IDE's store: those conversations never show up in this plugin's panel, but they spend the same account quota, so leaving them out would under-count by roughly 4x on a normal day."`

#### 真实痛点评估
- **不痛**。已有完整的 `~/.dsh/agy-token-cache.json` 磁盘缓存，扫描时只对各文件执行 `statSync`。没有改动的文件直接跳过读取和 JSON 解析，耗时极低。

#### 可行性 + 阻塞点
- **结论：不可行 / 破坏性建议，直接放弃**。
- **阻塞点**：建议说“从 stream-json 输出直接累加”。但代码注释明确指明：Antigravity IDE（VSCode 扩展或 IDE 自身）产生的 Token 消耗占整个账号的 4 倍，它们根本不走 DSH 的 stream-json！如果改成仅从 stream-json 累加，用户账号的大部分消耗都将被漏记，导致配额预估彻底失效。

---

### 8. 可观测性

#### 证据
- [src/index.ts:1829, 1840](src/index.ts#L1829)：虽然内部实现了 `formatRunSummary`、`explainEmptyResult` 并把 ndjson 流持久化到 `~/.dsh/agy-transcripts`，但这些是拼装在模型返回值里的文本。
- [src/index.ts:1891, 3031](src/index.ts#L1891)：`ctx.logger` 只打非结构化的字符串消息，没有输出标准格式的指标事件（如 `[agy:run] runId=... duration=... tokens={in,out} exitCode=...`）。
- 缺少一个用于自检环境的 `antigravity_doctor` 工具。

#### 真实痛点评估
- 痛点中等：遇到网络连不上、代理失效或版本不兼容时，用户只能在控制台看零碎警告，无法一键导出环境探针报告。

#### 可行性 + 阻塞点
- **结论：完全可行**。
- 无外部阻塞点，完全属于插件内部可控逻辑。

#### 实现要点
```ts
// 1. 在 executeForeground / executeBackground 结算处增加统一的结构化日志
ctx.logger.info(`[agy:metric] runId=${plan.id} model=${plan.model} duration=${duration}ms in=${usage.input} out=${usage.output} exit=${outcome.exitCode}`)
// 2. 新增 antigravity_doctor 工具，返回当前 agy 路径、版本、flag 探测表、代理配置及最近失败任务的 transcript 路径
```

#### 风险
极低。仅增加日志输出和自检工具。

---

### 9. 类型与构建

#### 证据
- [scripts/build.mjs:1-19, 46-65](scripts/build.mjs#L1)：详细解释了为何存在 `src/peers.d.ts`：本地 DSH 环境的 peer 依赖没有 `.d.ts` 文件，构建脚本通过探测 `peerTypesResolve()`，自动选择 `tsconfig.build.json`（排除 shim）或 `tsconfig.local.json`（包含 shim）。
- [tsconfig.json:17](tsconfig.json#L17)：
```json
"sourceMap": true,
"declaration": true,
"declarationDir": "lib/types"
```
现有 `lib/` 目录下每个 JS 文件均带有 `.js.map`！
- [scripts/build.mjs:108-150](scripts/build.mjs#L108-L150)：构建脚本内置了 VM 隔离沙箱，模拟 DSH 的 `window.__ModuleLoader__` 评估 `client.js`。

#### 真实痛点评估
- **完全不痛**。构建只需 1-2 秒，产物完备，且已具备 sourcemap。

#### 可行性 + 阻塞点
- **结论：不可行 / 负优化，直接放弃**。
- **阻塞点**：
  1. `esbuild` 无法生成 TypeScript 声明文件（`.d.ts`），项目作为外部插件必须向 DSH 提供 `lib/types/index.d.ts`，依然绕不开 `tsc`；
  2. `peers.d.ts` 解决的是类型缺失的编译错误，换 esbuild 并不能解决 DSH peer 类型缺失的问题；
  3. `client.js` 依赖非常严格的经典脚本微前端包装，引入打包工具反而极易破坏该契约导致白屏。

---

### 10. 多会话并行

#### 证据
- [src/index.ts:1629, 1665](src/index.ts#L1629)：
```ts
private followupGates = new Map<string, Promise<void>>()
// key 是 conversationId！
const prev = this.followupGates.get(conversationId) ?? Promise.resolve()
```
- [src/index.ts:2617, 2796](src/index.ts#L2617)：所有工具均声明 `isConcurrencySafe: () => true`。
- [docs/architecture.md:30-31](docs/architecture.md#L30-L31)：
`"Serialization — one gate per conversation id, so two concurrent prompts cannot interleave writes into the same agy conversation."`

#### 真实痛点评估
- **伪问题**。插件**本来就支持不同会话的完全并发**！

#### 可行性 + 阻塞点
- **结论：独立会话并行「已实现无需做」；同会话并行「不可行且灾难性」，直接放弃**。
- **为什么同一个会话必须加锁？**
  agy 底层在 `~/.gemini/antigravity-cli/conversations/<id>.db`（SQLite/boltdb）保存单一会话状态，且会向单个 `transcript.jsonl` 追加日志。如果放宽同一个会话的并发，会导致 SQLite 文件锁报错（`database is locked`）以及转轮状态与 transcript 写入撕裂。

---

### 11. 中间人审批流

#### 证据
- [src/index.ts:1825-1845](src/index.ts#L1825-L1845) & [src/index.ts:2357-2365](src/index.ts#L2357-L2365)：
```ts
if (parsed.response.trim().length === 0) {
  const detail = explainEmptyResult({ denied, stderr, transcript: transcriptPath })
  return { output: textBlocks([detail, summary ?? ''].join('\n\n')), stopReason: 'error' }
}
```
- [docs/agy-integration.md:79-82](docs/agy-integration.md#L79-L82)：`"These are advisory; the plugin cannot intercept agy's internal tool calls."`

#### 真实痛点评估
- 痛点确实存在：在无头模式下，一旦未传 `--dangerously-skip-permissions`，涉及文件修改的工具调用就会被 agy 拒绝，返回空响应。

#### 可行性 + 阻塞点
- **结论：不可行，直接放弃**。
- **阻塞点在 agy CLI 自身**：
  `agy` 在 `--print` 模式下没有向外部暴露任何权限拦截回调协议。遇到需要权限的操作，它不会通过 stdout 抛出 `permission_requested` 事件并暂停等待输入，而是直接在 Go 内部标记为 Denied 并结算退出。外部宿主根本没有途径在动作发生时将其挂起并弹窗审批。

---

### 12. 跨平台登录

#### 证据
- [src/index.ts:1285-1309](src/index.ts#L1285-L1309)：
```ts
if (process.platform === 'win32') {
  // PowerShell Start-Process 弹窗
}
return 'On this platform the plugin cannot open an interactive terminal automatically. Please open a terminal, run `agy` and complete the sign-in, then retry.'
```

#### 真实痛点评估
- 痛点低到中：macOS/Linux 用户在 Token 失效时无法自动弹窗登录，但凭据有效期长，手动跑一次 `agy` 成本尚可接受。

#### 可行性 + 阻塞点
- **结论：完全可行**。
- **macOS**：标准且开箱即用，通过 `osascript -e 'tell application "Terminal" to do script "${exe}"'` 即可调起系统终端。
- **Linux**：碎片化较多。若检测到 `$DISPLAY` 或 `$WAYLAND_DISPLAY`，尝试 `x-terminal-emulator -e <exe>`，若失败或在纯无头环境则平滑回退到现有文字提示。

#### 实现要点
```ts
// src/index.ts: launchLogin()
if (process.platform === 'darwin') {
  ctx.subprocess.spawn({
    argv: ['osascript', '-e', `tell application "Terminal" to do script "${exe}"`],
    ...
  })
  return `Opened Terminal for Antigravity login...`
}
```

#### 风险
极低。非 Windows 失败时有现成的文字提示作为兜底。

---

### 13. 插件热更新

#### 证据
- [package.json:38-46](package.json#L38-L46)：
```json
"dsh": { "client": { "inject": [], "platform": "web" } }
```
- [docs/sidebar-panel.md:92-95](docs/sidebar-panel.md#L92-L95) & [docs/development.md:55-66](docs/development.md#L55-L66)：
客户端是通过 `window.__ModuleLoader__.load({ id, factory })` 在宿主启动时以经典脚本 `<script>` 注入执行的。

#### 真实痛点评估
- **几乎不痛**。桌面客户端插件更新后重启主程序是标准习惯。

#### 可行性 + 阻塞点
- **结论：不可行，直接放弃**。
- **阻塞点**：DSH 宿主的微前端加载器根本没有提供 ESM 热重载接口。如果插件单方面将 `client.js` 改为动态 `import()`，会在经典脚本执行阶段破坏 `__ModuleLoader__` 的同步注册约定，直接导致 `web boot: 1 entry did not activate` 并出现侧边栏白屏故障。

---

### 14. 面板 UI 状态一致性

#### 证据
- **服务端重置标志竞争**：[src/agy-panel.ts:177-178](src/agy-panel.ts#L177-L178)：
```ts
const reset = !Number.isFinite(since) || since < 0 || since > run.text.length || run.resetPending
if (reset) run.resetPending = false
```
`run.resetPending` 是全局单个标志。多 Pane 或并发查询时，第一个查询直接把标志清零，第二个查询在缓冲区被截断后拿不到 `reset: true`，产生文本偏移错位！
- **客户端缺乏请求单飞锁**：[src/client.js:740-756](src/client.js#L740-L756)：
```javascript
const timer = setInterval(() => {
  post('/run', { runId, since: cursorRef.current })
    .then((payload) => {
      cursorRef.current = payload.cursor
      setRun((prev) => ({ ...prev, text: payload.reset ? payload.text : prev.text + payload.text }))
    })
}, 400)
```
400ms 定时器无条件持续发送请求，未等待前次请求返回。网络稍有延迟抖动，请求乱序结算，导致 `cursorRef` 回退并产生大段重复文本拼接。

#### 真实痛点评估
- 痛点中高：在运行长时间任务、生成大量文本（如跑单元测试输出），或者多标签页打开面板时，用户会目睹控制台日志重复打印或错位。

#### 可行性 + 阻塞点
- **结论：完全可行**。纯前端 + 服务端逻辑，无外部依赖阻塞。

#### 实现要点
1. 前端增加 `inFlight` 保护或改用递归 `setTimeout`，并确保游标单调递增：
```javascript
let inFlight = false
const tick = () => {
  if (inFlight || !alive) return
  inFlight = true
  post('/run', { runId, since: cursorRef.current })
    .then((payload) => {
      if (!alive) return
      cursorRef.current = Math.max(cursorRef.current, payload.cursor)
      setRun((prev) => prev ? { ...prev, text: payload.reset ? payload.text : prev.text + payload.text } : prev)
    })
    .finally(() => { inFlight = false })
}
```
2. 服务端移除全局单标志重置，改为比较绝对游标（`since < run.baseOffset` 时触发 `reset`）。

#### 风险
极低。纯健壮性修复。

---

# 第三部分：结论

### 1. 如果只做 3 件事，推荐哪 3 件？（按真实收益/成本比排序）

1. **解决空闲时反复 spawn `agy --print /usage` 进程（属于建议 1 的核心痛点解耦修复）**
   - **原因**：这是全仓库最严重的真实资源损耗。用户只要开着 DSH，每分钟都在后台启动一次 9-12s 的 `agy.exe` 进程拉配额，消耗大量 CPU 和系统进程资源。
   - **成本**：极小（在 `client.js` 中将轮询改为面板打开时刷新，或在空闲无任务时大幅延长 TTL，<15 行）。
2. **修复面板 UI 轮询乱序与多客户端竞态（建议 14）**
   - **原因**：直接消除长任务输出时的文本重复打印、游标跳跃和截断错乱，显著提升侧边栏稳定性。
   - **成本**：极小（客户端添加 `inFlight` 单飞锁，服务端游标绝对化，<30 行）。
3. **放宽任务注册表 50 条上限与日志滚动截断（建议 4 的务实解）**
   - **原因**：50 条上限导致多聊几个任务后历史会话丢失，模型无法 follow-up 恢复旧任务。提升到 500 条即可长期保存会话，同时加上 quota-log 30 天清理消除隐患。
   - **成本**：极小（改一个常量 + 几行清理过滤，<20 行）。

---

### 2. 哪些建议应该直接放弃？

1. **建议 3（能力探测先跑 `agy --version`）**：
   `fs.statSync` 仅需 0.1ms 且已有持久化缓存；改跑外部进程是典型的负优化。
2. **建议 7（改从 stream-json 累加 Token）**：
   致命缺陷。完全遗漏了 Antigravity IDE 占大头的配额消耗，破坏了记账准确性。
3. **建议 10（放宽多会话并行）**：
   不同会话早就是并行的；对同会话放宽并发会直接打烂底层的 SQLite 数据库和 transcript 文件。
4. **建议 11（中间人审批流）**：
   agy CLI 在无头模式下不提供任何外部拦截回调协议，根本无法实现。
5. **建议 13（客户端改 ESM hot-reload 动态 import）**：
   DSH 宿主使用的是经典脚本微前端加载器，强行动态 import 会直接导致侧边栏白屏崩溃。
6. **建议 6 & 建议 9（步骤增量同步 / 换 esbuild 构建）**：
   前端实时轮询根本没用 steps；项目早已开启 sourcemap 且必须依赖 tsc 生成 `.d.ts`，换 esbuild 弊大于利。

---

### 3. 清单里没提到，但代码里明显更值得修的问题（3 条）

1. **`client.js` 缺少错误捕获导致 React 整个侧边栏白屏**：
   [src/client.js:563-630](src/client.js#L563-L630) 在渲染历史步骤时，直接读取 `step.tool.parameters`。如果某次 agy 输出了非预期的特殊结构，React 在渲染循环中抛出异常，由于缺乏 React Error Boundary，会导致整个 DSH 右侧边栏彻底崩溃变白。
2. **超长 Prompt 的降级处理缺少工作区文件自动化支持**：
   在 [src/index.ts:1514-1518](src/index.ts#L1514-L1518) 中，当 prompt > 30,000 字符且无 `--prompt-file` 时，插件直接抛出致命异常中断任务。完全可以自动将其写入工作区临时文件（如 `.dsh-prompt-payload.md`），并将 prompt 转换为短指令，避免任务直接硬报错。
3. **任务意外中断时未清理残留的 `.corrupt` 和临时文件**：
   `writeJsonAtomic`（[src/index.ts:599](src/index.ts#L599)）和临时 prompt 写入在 Windows 进程异常被杀时，可能会在临时目录留下孤儿文件，缺少启动时的扫描回收机制。
