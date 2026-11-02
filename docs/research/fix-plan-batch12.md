# 修复计划：批次 1（后台路径）+ 批次 2（契约对齐）

> 依据：[agy-audit.md](agy-audit.md) 审计报告 + 本会话对 `#0` 的独立定位
> 修改目标：`src/*.ts`（源码），随后 `npm run build` 生成 `lib/`
> 状态：**待 Agent 复审，未执行**

---

## 0. 前置事实与约束

### 0.1 代码基线
- 源码在 `src/`，`lib/` 是 `scripts/build.mjs`（tsc）的产物，**不要直接改 `lib/`**。
- `build.mjs` 会探测 `@deepseek-ai/*` 是否提供可用 `.d.ts`，据此选择 `tsconfig.build.json` 或 `tsconfig.local.json`（带 `src/peers.d.ts` shim）。本机 peer 无类型 → 走 local 配置。
- **git 工作区当前已有未提交修改**（`src/index.ts`、`src/client.js`、`lib/*`、`README*`、`package.json`、`test/*` 等 14 个文件）。执行前必须先固化基线，否则无法区分本次改动与既有改动。

### 0.2 执行前置动作（必须先做）
```bash
cd <repo>
git diff > scratch/baseline-uncommitted.patch   # 固化既有改动
git status --short                              # 记录
npm run build && npm test                       # 确认基线绿色
```
若基线本身红，先停下来报告，不要开始改。

### 0.3 不在本次范围
- 批次 3（BUG-11/12/13 死数据）、批次 4（BUG-16/19/20/21）
- 任何前端 `client.js` 改动（除 F2-4 的文档外，本批次不动客户端）

---

## 批次 1：后台路径（5 项）

后台路径与前台路径的质量差距是本批次的主因。5 项彼此耦合，建议**一次改完再统一验证**，但可按下列顺序独立提交。

---

### F1-1 【BUG-02】后台新建任务与面板续跑丢失 `config.addDirs`

**严重度**：P0（对配置了全局 addDirs 的用户，后台任务必挂到超时）

**位置**：`src/index.ts`
- `startBackground()` — L1963-1970
- `startPanelRun()` — L1995

**改法**

L1963-1970，把 `extraDirs` 改为合并：
```ts
// before
const plan = await this.spawnPlan(
  request as ResolvedSubagentStartRequest,
  undefined,
  undefined,
  extraDirs,
  config.backgroundTimeoutMs,
  overrides,
)

// after
const plan = await this.spawnPlan(
  request as ResolvedSubagentStartRequest,
  undefined,
  undefined,
  [...this.config.addDirs, ...extraDirs],
  config.backgroundTimeoutMs,
  overrides,
)
```

L1995，面板续跑没有工具级 dirs，只补配置级：
```ts
// before
const plan = await this.spawnPlan(request, input.conversationId, input.cwd, [], config.backgroundTimeoutMs)

// after
const plan = await this.spawnPlan(request, input.conversationId, input.cwd, [...config.addDirs], config.backgroundTimeoutMs)
```

**依据**：前台 L~1571 `[...this.config.addDirs, ...extraDirs]` 与 resume 后台 L~1609 均正确合并，仅这两处漏。`spawnPlan` 内部会经 `validateAddDirs` 校验绝对路径/存在性，合并后行为一致。

**风险**：极低。重复传入同一目录不会产生重复 flag（`spawnPlan` 逐条 push，理论上会重复 `--add-dir`）。**需确认**：`addDirs` 未去重时是否会对 agy 造成问题 → 若担心，合并后套 `new Set()`。

**验证**
- 单测：`test/run.mjs` 加断言——配置 `addDirs: ['<tmp>']`，调用 background，检查 spawn 的 argv 含 `--add-dir`。
- 手工：配置全局 addDirs 后跑一次背景任务，检查进程命令行。

---

### F1-2 【BUG-01】后台非成功结算被标记为 `completed`

**严重度**：P1（修好 F1-3 后会升级为 P0）

**位置**：`src/index.ts` L2216-2221

**改法**
```ts
// before
} else {
  status = 'completed'
  detail = this.maybeAutoLogin(
    (finalError !== undefined && finalError.length > 0 ? finalError : stderr.trim()) || `agy exited with code ${String(outcome.exitCode)}`,
  )
}

// after
} else {
  // Reached when the run ended without a SUCCESS result: a non-zero exit,
  // an auth failure, or a stream that never produced a parseable result.
  // The `else` branch above already covers the "SUCCESS but empty" case.
  status = 'failed'
  detail = this.maybeAutoLogin(
    (finalError !== undefined && finalError.length > 0 ? finalError : stderr.trim()) || `agy exited with code ${String(outcome.exitCode)}`,
  )
}
```

**为什么这个 else 必定是失败**（需 reviewer 确认）：
- 后台 `spawnOnce` 只用 `stream-json` 或 `json` 两种协议（L~2251），不走 text 模式。
- `stream-json` 的正常结束一定有 `result` 事件；`json` 的整段回复会被当作 result 解析。
- 因此 `finalStatus` 为 undefined ⇔ 输出不可解析 ⇔ 也是失败。
- 上面已有 `else if (finalStatus === 'SUCCESS')` 分支，其 `empty` 子分支已处理「SUCCESS 但无正文」。

**影响链（修正审计报告的说法）**：审计报告称「job 成功唤醒主模型」，但当前 `run: () => bg` 并未接上 `done`，所以真正受影响的是 `agy-panel.js` 的 RunStore：`outcome.status !== 'completed'` 才设 `run.error`，导致面板把失败显示为 `done` 且无错误。**修好 F1-3 后，这条会同时影响 job 状态，故必须同批修**。

**验证**：`test/run.mjs` 用 fake-agy 返回 `{"status":"ERROR","error":"boom"}`，断言 `bg.done` 的 `status === 'failed'` 且 `detail` 含 `boom`；面板路径断言 `run.error` 被设置。

---

### F1-3 【#0】后台 job 的 result 没接上运行句柄

**严重度**：P1（每次 `background: true` 都读不到结果）

**位置**：`src/index.ts`
- L2656（resume 分支）
- L2703-2711（新建分支）

**根因**：`run: () => bg` 返回的是句柄对象（`AntigravityBackgroundHandle`），不是会 resolve 成结果的 Promise。句柄的 `done` 才是结算 promise，`readOutput()` 才是文本。代码里没有任何桥接。

**改法**

L2656：
```ts
// before
jobId = jobs.start({ kind: 'antigravity', label, owner: parent.session.id, run: () => bg })

// after
jobId = jobs.start({
  kind: 'antigravity',
  label,
  owner: parent.session.id,
  run: async () => {
    const outcome = await bg.done
    return { ...outcome, task: bg.id, text: bg.readOutput() }
  },
})
```

L2703-2711 同样处理（新建分支的 `bg` 来自 `provider.startBackground`）。

**依赖**：本项依赖 F1-4 先在句柄上加 `id`。

**风险（本计划最大不确定项，必须标注实测）**：
1. `@deepseek-ai/dsh-jobs` 在本仓库是**无类型 stub**（`node_modules/@deepseek-ai/dsh-jobs/lib/types/*` 仅 4 个空壳），真实实现位于 DSH 宿主 `app.asar` 内，**无法静态确认 `run` 返回值的消费方式**。
2. 若宿主把 result 当字符串渲染 → 返回对象会显示为 JSON，可接受但不理想。
3. 若宿主对 result 有结构约束 → 可能报错。

**回退方案**：若实测 job 输出异常，改回 `run: () => bg`，改为在 `tools` 层把 `jobId` 与 `task` 一并返回、并在文档中明确「后台结果用 `antigravity_followup` 或 `job_output` 的流式输出获取」。**不论如何，F1-2/F1-4 都独立有效，可单独保留。**

**验证**：
- `test/run.mjs` 已有 background 用例（L~583「Wake-on-settle」），加断言：job settle 后的 result 含非空 `text` 与 `task`。
- 端到端：派一个小任务 `background: true`，`job_output` 应能看到文本（本次会话中实测为空的场景应消失）。

---

### F1-4 【BUG-03】后台新建任务返回值缺 `task` 键

**严重度**：P1

**位置**
- `src/index.ts` L967-982（`AntigravityBackgroundHandle` 接口）
- `runBackgroundPlan` 的返回对象（约 L2075，对应 `lib/index.js:1903`）
- L2718

**改法**

1. 接口加 `id`：
```ts
export interface AntigravityBackgroundHandle {
  /** The run id — the task key handed to callers and written to the registry. */
  id: string
  cancel: (reason?: string) => void
  done: Promise<{ status: 'killed' | 'completed' | 'failed'; detail: string }>
  readOutput: () => string
  ...
}
```

2. `runBackgroundPlan` 末尾返回对象加 `id`：
```ts
return { id, cancel, done, readOutput, tool: () => lastTool, steps: () => snapshotSteps(steps) }
```

3. L2718：
```ts
// before
return { kind: 'background', jobId }

// after
return { kind: 'background', jobId, task: bg.id }
```

**一致性说明**：`plan.id` 就是 `remember()` 与 `updateTaskRegistry()` 使用的 key（`records[id]`），所以 `bg.id` 在 run 结束后一定能被 `followup` 查到。run 未结束时查不到是预期行为（此时应用 `antigravity_tasks` 的 running 列表）。

**验证**：断言 `background: true` 的返回含 `task`，且该 key 在 run 结束后出现在 `~/.dsh/agy-conversations.json`。

---

### F1-5 【BUG-07】后台任务从不写 transcript

**严重度**：P1（承诺的审计证据在后台完全缺失）

**位置**：`src/index.ts` `runBackgroundPlan`（L2003-2240 区间）

**改法**

1. 声明累积器（与 `visible` 同级，约 L2030）：
```ts
/** Raw NDJSON lines of this run, for the transcript. Capped to bound memory. */
const rawLines: string[] = []
let rawBytes = 0
const MAX_TRANSCRIPT_BYTES = 32 << 20
```

2. 在 stdout 的 `data` 回调里收集（约 L2258 的 while 循环内）：
```ts
if (line.length > 0) {
  if (rawBytes < MAX_TRANSCRIPT_BYTES) {
    rawLines.push(line)
    rawBytes += line.length + 1
  }
  consumeLine(line)
}
```

3. 在 `finally` 之后、`remember()` 之前写入（约 L2227-2231 之间）：
```ts
if (config.transcript !== false) {
  writeTranscript(config, plan.id, transcriptHeader(plan) + rawLines.join('\n'))
}
```
与前台保持一致：`writeTranscript` 自身 best-effort，失败返回 undefined，绝不影响 run。

**注意**：`transcriptHeader(plan, status?)` 的第二参类型是 `'cancelled' | 'timeout'`，与 `done.status`（`killed|completed|failed`）不同词汇。**本计划不传 status**（与前台 L1820 一致），避免类型冲突；若需要区分取消，后续单独做映射。

**风险**：长任务（1h）内存占用。32 MB 上限 + 超限后停止累积，可接受。

**验证**：跑一个后台任务后，`~/.dsh/agy-transcripts/<sanitized-id>.ndjson` 存在且非空；`index.json` 含该 task 条目。

---

## 批次 2：契约对齐（4 项）

均为「文档/描述承诺 A，实现是 B」，改动集中在工具层，不碰执行内核。

---

### F2-1 【BUG-05】`antigravity_cancel` 对非运行任务抛异常

**严重度**：P1

**位置**：`src/index.ts` L3014-3022

**改法**
```ts
// before
const cancelled = current.cancelActive(args.task)
if (!cancelled) {
  throw new Error(`${PREFIX}: no running task "${args.task}" — ...`)
}
return { cancelled: true, task: args.task, message: `...` }

// after
const cancelled = current.cancelActive(args.task)
if (!cancelled) {
  return {
    cancelled: false,
    task: args.task,
    message: `No running task "${args.task}". Finished tasks cannot be cancelled — resume them with ${config.followupToolName}. Running tasks: ${config.tasksToolName}.`,
  }
}
return { cancelled: true, task: args.task, message: `Cancellation requested for task ${args.task} — its run settles as cancelled.` }
```

**保留**：provider 类型不符时的 `throw`（那是真实的装配错误，不是可预期的用户输入）。

**同步**：`docs/interfaces-reference.md` 中 cancel 的 `cancelled` 字段说明已写「true only if a live run was actually stopped」，代码改后即与文档一致，无需改文档。

**验证**：传一个不存在的 task key，断言返回 `{ cancelled: false }` 且不抛。

---

### F2-2 【BUG-06】`[task: ...]` 形式的 key 不被解析

**严重度**：P1（工具描述主动引导模型这么传）

**位置**
- 新增 helper（建议放 `src/index.ts` 工具定义之前，约 L2540）
- 两个调用点：`antigravity` 的 resume 分支 L~2629、`antigravity_followup` L~2795

**改法**

helper：
```ts
/**
 * Tool descriptions tell the model it may pass either the bare task key or the
 * `[task: <key>]` line from a previous result. Accept both.
 */
function parseTaskKey(raw: string): string {
  const trimmed = raw.trim()
  const match = /^\[?\s*task\s*:\s*([^\]]+?)\s*\]?$/i.exec(trimmed)
  return match?.[1]?.trim() ?? trimmed
}
```

两处替换：
```ts
// before
const task = args.task.trim()
// after
const task = parseTaskKey(args.task)

// before（followup）
const record = records[args.task]
// after
const task = parseTaskKey(args.task)
const record = records[task]
```
followup 的返回值与注册表写回也要改用 `task` 变量。

**风险**：极低。唯一副作用是原本就合法但形如 `task: xxx` 的 key 会被误解析——但 run id 形如 `<session>::agy::<n>`，不含该前缀，安全。

**验证**：`ctl.callTool(config.toolName, { prompt: 'x', task: '[task: <valid>]' })` 应成功；裸 key 仍成功。

---

### F2-3 【BUG-04】`antigravity_followup` 不是真正的别名

**严重度**：P1

**位置**：`src/index.ts` L2760-2839（followup 工具）

**问题**：文档（`docs/interfaces-reference.md:63,71`）称其为 `antigravity(task: ...)` 的别名、返回相同的 foreground/background 形状；实际是独立实现：无 `background`/`model`/`effort` 参数，output schema 把 `kind` 固定为 `foreground`，且未接 `jobs.start`。

**改法（推荐：抽取共享实现）**

1. 在 provider 之上抽一个模块级函数，供两个工具共用：
```ts
async function executeResume(
  ctx: Ctx,
  config: Config,
  args: { description?: string; task: string; prompt: string; background?: boolean; model?: string; effort?: string },
  exec: ExecContext,
): Promise<ToolResult> { /* 即当前 L2629-2680 的 resume 分支逻辑 */ }
```
该函数内部分支：`background === true` → `jobs.start(...)`（含 F1-3 的接线），否则前台 `followup`。

2. `antigravity` 的 resume 分支改为调用它。
3. `antigravity_followup` 改为：参数补齐 `background`/`model`/`effort`，output schema 与 `antigravity` 对齐（`kind` 不再 `const: 'foreground'`，补 `jobId`），`execute` 直接调 `executeResume`。

**风险（中等）**：这是本批次唯一涉及结构重排的改动，容易在重构中丢失细节（注册表写回、`label` 回退、`conversationId` 合并）。**建议：先做 F2-1/F2-2/F2-4，本项单独一次提交，并逐行对照原 `antigravity` resume 分支。**

**回退**：若重构风险不可接受，降级方案是**只改文档**——把 `docs/interfaces-reference.md` 与 `README.zh.md` 中「alias / same shape / supports background」的表述改成「followup 只支持前台」的准确描述，代码不动。此降级仍需 reviewer 确认是否接受。

**验证**：`antigravity_followup({ task, prompt, background: true })` 返回 `{ kind: 'background', jobId, task }`；前台调用返回与 `antigravity(task:)` 相同形状。

---

### F2-4 【BUG-18】文档把 `output` 写成 string，实为 Content 块数组

**严重度**：P2（纯文档）

**位置**：`docs/interfaces-reference.md` L40 附近

**改法**
```ts
// before
output: string          // final answer + [agy] summary line

// after
output: ContentBlock[]  // final answer + [agy] summary line; render with outputValueText()
```

**验证**：无代码改动，仅需 reviewer 确认描述与 `lib/index.js:2212`（`{ type: 'array', items: { type: 'json' } }`）一致。

---

## 执行顺序与验证策略

| 步骤 | 内容 | 提交粒度 | 验证 |
|---|---|---|---|
| 0 | 固化基线 patch、`npm run build && npm test` | — | 必须绿 |
| 1 | F1-1 | 独立 | test + 手工 argv 检查 |
| 2 | F1-4 → F1-2 | 独立 | test |
| 3 | F1-3 | 独立（风险最高） | test + 端到端 `job_output` |
| 4 | F1-5 | 独立 | 检查 transcript 文件落盘 |
| 5 | F1 整体回归 | — | 全量 `npm test` |
| 6 | F2-1 → F2-2 | 可合并 | test |
| 7 | F2-3 | 独立（重构） | test + 两个工具形状对比 |
| 8 | F2-4 | 独立 | 文档 diff |

**每步之后**：`npm run build && npm test`（build 会清空 `lib/` 重新生成，注意不要覆盖手工改动）。

**最终回归**：`npm run test:panel` 也应保持绿（本批次改动可能影响 panel 的 RunStore 错误设置路径）。

---

## 需要 reviewer 重点裁定的事项

1. **F1-2 的前提**：`finalStatus !== 'SUCCESS'` 是否**必然**表示失败？（我据「后台只用 json/stream-json、正常结束必有 result 事件」推断为是。）若存在「agy 正常结束但不发 result」的版本，此项会误报失败。
2. **F1-3 的宿主契约**：`jobs.start({ run })` 的返回值如何被消费，静态不可知。是否接受「先按对象返回、实测后调整」的策略，还是要求更保守的字符串返回？
3. **F1-1 的 `--add-dir` 去重**：`config.addDirs` 与工具 `dirs` 重叠时会产生重复 flag，是否需要 `Set` 去重？
4. **F2-3 的重构 vs 改文档**：是否接受「只改文档、不动代码」的降级方案？
5. **F1-5 的内存上限**：32 MB 是否合适，还是应该直接流式追加写文件（更复杂但无上限）。

---

# 复审裁定与执行记录（v2）

## 复审结果
复审报告：[plan-review.md](plan-review.md) — **有条件批准**，4 个阻塞项。

| 阻塞项 | 复审意见 | 采纳情况 |
|---|---|---|
| F1-3 的 `run: async () =>` 改法 | **致命错误**：`JobStart.run()` 必须同步返回 `JobHooks`（`test/harness.mjs:170`、`dsh-jobs` 类型定义）。async 会让 `cancel` 变 undefined、`job_kill` 失效、后台测试全红 | ✅ **整项撤销**，不改代码 |
| F1-4 返回对象行号 | 实际在 L2271（原写 L2075，偏 196 行） | ✅ 已按实际位置修改 |
| F1-5 收集点 | 应在 `consumeLine` 入口收集，否则 `end` 事件的 tail 会丢；上限降到 16 MB + 截断标记 | ✅ 采纳 |
| F2-3 重构 | 严重低估：漏 `dirs`、output schema 的 `required` 会让后台返回被校验拦截、`render` 遇到 undefined 会崩 | ✅ **降级为改文档** |
| F2-2 调用点 | 漏了 `antigravity_cancel` | ✅ 已补 |

复审对 5 个裁定项的结论（已全部采纳）：
1. `finalStatus !== 'SUCCESS'` 必然表示失败 → 改 `failed` 正确；
2. 必须保持 `run()` 同步返回 `JobHooks`；
3. 不需要手写 `Set` 去重（`validateAddDirs` 内部已去重）；
4. F2-3 降级为文档修正；
5. transcript 上限用 16 MB + 显式截断标记。

**F1-3 的重要结论**：`#0` 不是「result 没接上」——`run: () => bg` 是**正确契约**，宿主会在 settle 时 drain `hooks.readOutput()` 填 ring（`test/harness.mjs:194-206` 复刻该行为，且测试 `background/job-reads-output` 一直验证它能读到最后那段文本）。本会话中 `job_output` 返回空，属于宿主侧行为差异，**不是插件代码缺陷**，需在真实 DSH 上单独定位。

## 实际执行

| 项 | 改动位置（`src/index.ts`） | 状态 |
|---|---|---|
| F1-1 | `startBackground` 合并 `config.addDirs`；`startPanelRun` 由 `[]` 改为 `[...config.addDirs]` | ✅ |
| F1-2 | 失败分支 `status = 'completed'` → `'failed'` | ✅ |
| F1-4 | `AntigravityBackgroundHandle` 加 `id`；`runBackgroundPlan` 返回 `id`；后台工具返回 `task: bg.id` | ✅ |
| F1-5 | `runBackgroundPlan` 累积 raw 行（在 `consumeLine` 入口，16 MB 上限 + 截断标记），settle 后 `writeTranscript` | ✅ |
| F1-3 | 不改代码（见上） | ⏸ 撤销 |
| F2-1 | `antigravity_cancel` 对非运行任务返回 `{ cancelled: false }` 而非抛错 | ✅ |
| F2-2 | 新增 `parseTaskKey()`，用于 `antigravity` 续聊、`antigravity_followup`、`antigravity_cancel` | ✅ |
| F2-3 | 降级：`docs/interfaces-reference.md` + `README.md` + `README.zh.md` 改为「前台快捷方式」 | ✅ |
| F2-4 | `output: string` → `ContentBlock[]` | ✅ |

## 验证结果

- `npm test`：**145/145**（基线 135 + 新增 10 条断言）
- `npm run test:panel`：全绿（exit 0）
- `npm run build`：通过（`tsconfig.local.json` + `peers.d.ts`，client bundle 校验通过）

**新增回归测试**（`test/run.mjs`）：
1. `background/job-reads-output` → 增加了「返回 task 键」「写 transcript」两条断言
2. `background/keeps-config-add-dirs` → 后台运行必须带上配置的 `--add-dir`
3. `background/exit-1-settles-failed` → 非零退出必须 settle 为 `failed`（**F1-2 的守卫**，修复前该断言必红）
4. `cancel/unknown-task-answers-false` → 取消不存在的任务不抛错
5. `tool/task-bracket-form-resumes` → `[task: ...]` 形式可用

## 遗留

1. **`#0` 端到端复验**：需在真实 DSH 上跑一次 `background: true`，确认 `job_output` 是否有内容。若无，问题在宿主侧，另行定位。
2. 批次 3（BUG-11/12/13 死数据）、批次 4（BUG-16/19/20/21）未做。
3. 复审补充发现：前台续聊 `provider.followup()` 也不接收 `dirs`（`src/index.ts:2663` 附近），属同类参数丢弃缺陷，建议记入下一批。

