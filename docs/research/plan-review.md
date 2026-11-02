# 对抗式复审报告：批次 1（后台路径）+ 批次 2（契约对齐）修复计划

> **复审标的**：`scratch/fix-plan-batch12.md`  
> **源码基线**：`src/index.ts`（3034 行）及相关测试与依赖类型定义  
> **执行状态**：**只读复审完成，未执行任何修复，未修改任何源码**

---

## 裁定

**有条件批准（需重大修正后方可执行）**：计划中的 BUG 定位方向基本准确，但 **F1-3 包含破坏测试与 DSH 宿主契约的致命错误（绝对不能把返回 hooks 的 `run` 改为 async 函数）**，**F1-4/F1-5 存在多处严重行号漂移（最大偏差近 200 行）与漏收集 `end` 尾部数据**，**F2-3 重构方案严重低估了模式验证必填项与 `render` 崩溃风险（强烈建议降级为改文档）**；必须修正全部「必须修改的点」后方可执行。

---

## 逐条核对表

| 项 | 计划标注行号 | 实际行号与偏差 | before 代码属实? | 改法可行? | 核心核对结论 / 必改点 |
|---|---|---|---|---|---|
| **F1-1** (BUG-02) | L1963-1970<br>L1995 | L1963-1970（偏 0）<br>L1995（偏 0） | **属实**（逐字一致） | **可行** | `spawnPlan` 内部的 `validateAddDirs` 已有 `Set` 去重，无需在合并处手写 `Set`。前台 `followup` (L1611) 亦遗漏 `extraDirs`，建议同注。 |
| **F1-2** (BUG-01) | L2216-2221 | L2216-2221（偏 0） | **属实**（逐字一致） | **可行** | 改为 `status = 'failed'` 完全正确且类型匹配。在 stream-json/json 协议下，未达成 SUCCESS 即为失败，原先将 exit-1/auth 错标为 completed 属于重大 bug。 |
| **F1-3** (#0) | L2656<br>L2703-2711 | L2656（偏 0）<br>L2703-2713（偏 0） | **属实**（逐字一致） | **致命错误<br>不可行** | **致命违约**：`@deepseek-ai/dsh-jobs` 并非不可知 stub（见 `types.d.ts` 与 `test/harness.mjs:170`），其 `run()` 必须**同步返回 `JobHooks`** (`{ cancel, done, readOutput }`)。若改为 `run: async () => ({...})`，`hooks.cancel` 将为 `undefined`，单测会立即抛出契约违规异常，且任务无法被 `job_kill` 取消！ |
| **F1-4** (BUG-03) | 接口 L967-982<br>返回约 L2075<br>工具返回 L2718 | 接口 L967-982（偏 0）<br>返回 **L2271**（**偏差 +196 行**）<br>工具返回 L2718（偏 0） | **部分属实**<br>（L2075 实际在 `consumeLine` 内部） | **可行**<br>（修正行号后） | 接口加 `id: string` 及返回 `{ id, ... }` 类型安全；L2718 补充 `task: bg.id` 符合已声明的 output schema。但计划标注的返回行号 L2075 严重漂移，实际在 L2271。 |
| **F1-5** (BUG-07) | 累积器约 L2030<br>收集约 L2258<br>写入约 L2227-2231 | 累积器 L2030（偏 0）<br>收集 **L2168**（**偏差 -90 行**）<br>写入 L2227-2231（偏 0） | **部分属实**<br>（L2258 实际在 `readOutput` 内部） | **需修正** | 1. 收集点行号漂移，实际在 L2168 的 `data` 监听内；<br>2. **严重遗漏**：计划只在 `data` while 循环收集，漏掉了 `handle.stdout.on('end')` 处理的 `tail`（L2175）；<br>3. 32 MB 内存累积偏大，建议降至 16 MB 并加截断标记。 |
| **F2-1** (BUG-05) | L3014-3022 | L3014-3022（偏 0） | **属实**（逐字一致） | **可行** | 改为返回 `{ cancelled: false, ... }` 完全符合 output schema 和接口文档定义，且不会破坏现有测试。但注意：该工具也应调用 `parseTaskKey`。 |
| **F2-2** (BUG-06) | helper 约 L2540<br>resume L~2629<br>followup L~2795 | helper 约 L2545<br>resume L2632（偏 +3）<br>followup L2805（偏 +10） | **属实**（逐字一致） | **可行**<br>（需强化正则） | 1. 计划遗漏了 `antigravity_cancel`（L3014），该处也应使用 `parseTaskKey`；<br>2. 建议强化正则以剥离反引号、首尾引号和行末句点。 |
| **F2-3** (BUG-04) | L2760-2839 | L2760-2839（偏 0） | **属实**（逐字一致） | **存在重大隐患** | **计划严重低估重构风险**：<br>1. 抽取的 `executeResume` 参数漏掉了 `dirs?: string[]`；<br>2. `followup` 工具目前的 output schema 中 `runId` 与 `output` 是 `required: true`，若后台运行返回 `{ kind: 'background' }` 会直接被契约校验器拦截报错；<br>3. `followup` 的 `render` 直接读取 `value.output`，后台运行时为 undefined 会抛 `TypeError` 崩溃。<br>强烈建议**降级为改文档**；若坚持重构必须修齐上述 3 点。 |
| **F2-4** (BUG-18) | docs L40 附近 | L40（偏 0） | **属实**（逐字一致） | **可行** | 纯文档修正，代码中 output schema 确实为 `{ type: 'array', items: { type: 'json' } }`，与描述一致。 |

---

## 必须修改的点（阻塞项）

在执行该修复计划前，必须对计划文档做出以下修正：

### 1. 【致命缺陷】彻底推翻 F1-3 中 `run: async () => ({...})` 的改法
- **问题说明**：
  计划称「`dsh-jobs` 是无类型 stub，静态不可知消费方式，将 `run: () => bg` 改为 `run: async () => ({ ...outcome, task: bg.id, text: bg.readOutput() })`」。
  **这是事实错误。**
  代码库中存在完整确凿的契约定义：
  - `node_modules/@deepseek-ai/dsh-jobs/lib/types/types.d.ts`（第 56-83 行）明确规定：`JobStart.run(): JobHooks`。`JobHooks` 必须具备 `{ cancel(reason?: string): void; done: Promise<JobOutcome>; readOutput?(): string; }`。
  - `test/harness.mjs` 第 170-174 行明确断言：
    ```javascript
    const hooks = spec.run(handle)
    if (hooks === undefined || typeof hooks.cancel !== 'function' || hooks.done === undefined) {
      throw new Error(`job ${id} producer violated the contract: run() must return { cancel, done }`)
    }
    ```
- **破坏后果**：
  若按原计划改为 `async () => ...`，`run` 返回 Promise，`hooks.cancel` 为 `undefined`，`test/harness.mjs` 在启动 job 时会**立即抛出致命异常**，导致全量后台单测全部爆红崩溃；且在真实环境里会导致任务彻底丧失取消能力（`job_kill` 失效）。
- **修正方案**：
  保持 `run()` 同步返回 `JobHooks` 对象的契约不变！
  `bg`（`AntigravityBackgroundHandle`）本身就已经实现了 `cancel`、`done` 和 `readOutput`，且测试证明 `jobsService.readOutput` 在任务结束后能通过 `test/harness.mjs:199-206` 自动 drain `readOutput()` 读取文本。
  若要确保终端状态也携带 `output` 和 `task`，正确的改法是桥接 hooks，绝不能把 `run` 改成异步函数：
  ```ts
  jobId = jobs.start({
    kind: 'antigravity',
    label,
    owner: parent.session.id,
    run: () => ({
      cancel: (reason) => bg.cancel(reason),
      done: bg.done.then((outcome) => ({ ...outcome, output: bg.readOutput(), task: bg.id })),
      readOutput: () => bg.readOutput(),
    }),
  })
  ```
  或者保持原有的 `run: () => bg`，将终端输出补充在 `bg.done` 的解析值中。

---

### 2. 【行号漂移与漏行】修正 F1-4 与 F1-5 的定位与收集逻辑
- **F1-4 返回点行号纠正**：
  计划称「`runBackgroundPlan` 的返回对象（约 L2075）」。实际 `src/index.ts` L2075 处是 `if (event === 'init')`，真正的返回语句在 **L2271**：
  ```ts
  return { id, cancel, done, readOutput, tool: () => lastTool, steps: () => snapshotSteps(steps) }
  ```
- **F1-5 收集点行号纠正与尾部漏收集**：
  1. 计划称收集点在「约 L2258 的 while 循环内」，实际该循环位于 **L2168-2172**（L2258 位于 `readOutput` 内部）。
  2. **严重遗漏**：计划只在 `data` 事件的 while 循环中 push `rawLines`，但 `src/index.ts` 第 2174-2177 行有 `end` 事件的 `tail` 处理：
     ```ts
     handle.stdout?.on('end', () => {
       const tail = buffer.trim()
       if (tail.length > 0) consumeLine(tail)
     })
     ```
     如果只在 while 循环收集，最后一段 `tail` 就会在 transcript 中丢失！
  3. **修正**：将 `rawLines` 收集逻辑放入 `consumeLine(line)` 函数入口处，一次性覆盖 `data` 流式切片和 `end` 尾部残卷，并补充末尾换行符：
     ```ts
     const consumeLine = (line: string): void => {
       if (rawBytes < MAX_TRANSCRIPT_BYTES) {
         rawLines.push(line)
         rawBytes += line.length + 1
       }
       ...
     ```

---

### 3. 【重大遗漏与崩溃风险】F2-3 重构方案必须补全 3 处关键代码，或降级为改文档
如果执行团队选择「抽取 `executeResume`」的代码重构路线，计划中存在 3 个会导致编译或运行失败的严重遗漏：
1. **参数漏掉 `dirs`**：
   计划第 358-363 行抽取的 `executeResume` 参数缺少 `dirs?: string[]`。而原 `antigravity` resume 分支（L2653）需要将 `args.dirs ?? []` 传递给 `startResumeBackground`。
2. **Output Schema 必填约束导致 Schema 校验崩溃**：
   `antigravity_followup` 当前的 output schema（L2785-2791）将 `kind` 固定为 `const: 'foreground'`，并将 `runId` 和 `output` 标注为 `required: true`。
   后台任务返回的是 `{ kind: 'background', jobId, task }`，不含 `runId` 和 `output`。
   在 DSH 运行时闭合校验（`additionalProperties: false` 且检查 `required`）下，调用 `antigravity_followup({ ..., background: true })` 将直接抛出 **Schema Validation Error**！
   **修正**：必须在 schema 中移除 `const: 'foreground'`，将 `runId` 和 `output` 的 `required: true` 移除，并补充声明 `jobId` 和 `label`。
3. **`render` 函数因 undefined output 抛异常崩溃**：
   当前 `antigravity_followup` 的 `render`（L2794）为：
   ```ts
   render: (_args: unknown, value: { output: unknown[] }) => [{ type: 'text', text: outputValueText(value.output) }]
   ```
   如果为后台调用，`value.output` 为 `undefined`，`outputValueText` 执行 `values.filter(...)` 会触发 `TypeError: Cannot read properties of undefined`。
   **修正**：必须像 `antigravity` 工具（L2610-2615）一样，先分支判断 `if (value.kind === 'background')`。

---

### 4. 【调用点遗漏】F2-2 应同时应用到 `antigravity_cancel`
- 计划只在 `antigravity` 的 resume 分支和 `antigravity_followup` 中应用了 `parseTaskKey`。
- 但 `antigravity_cancel`（L3014）直接将用户传入的 `args.task` 传给了 `current.cancelActive(args.task)`。
- 如果模型根据之前的工具提示传递了 `[task: session::agy::1]`，`cancelActive` 会直接判定任务不存在。
- **修正**：在 `antigravity_cancel`（L3014 前）同样加入 `const task = parseTaskKey(args.task)`。

---

## 建议但不强制的点

1. **F1-1 遗漏的前台 resume `extraDirs` 丢弃问题**：
   在 `src/index.ts` L2663 中，`antigravity` 前台 resume 分支直接调用 `provider.followup(request, record.conversationId, record.cwd, overrides)`。`provider.followup` 并没有接收 `dirs` 参数，导致前台 resume 时若传入 `dirs` 会被静默忽略。虽然这不在本次 BUG-02 的最小修复范围内，但属于同一类配置/参数丢弃缺陷，可记入后续批次。
2. **F2-2 正则健壮性增强**：
   计划给出的正则 `/^\[?\s*task\s*:\s*([^\]]+?)\s*\]?$/i` 无法处理模型偶尔附带的反引号、单双引号或句末标点（如 `` `[task: xxx]` `` 或 `` `xxx` `` 或 `[task: xxx].`）。
   建议增强为：
   ```ts
   function parseTaskKey(raw: string): string {
     const cleaned = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim()
     const match = /^\[?\s*task\s*:\s*([^\]]+?)\s*\]?\.?$/i.exec(cleaned)
     const key = match?.[1]?.trim() ?? cleaned
     return key.replace(/^[`'"]+|[`'"]+$/g, '').trim()
   }
   ```

---

## 5 个裁定项的回答

### 1. F1-2 的前提：`finalStatus !== 'SUCCESS'` 是否必然表示失败？
- **明确结论**：**是，必然表示失败。**
- **理由**：
  在 `stream-json` 和 `json` 协议规范下，agy 正常且完整执行完毕时，其输出事件流必定包含 `status: 'SUCCESS'` 的 result 事件或根对象。
  若未收到 SUCCESS（`finalStatus` 为 undefined 或 `'ERROR'`），只能是以下情况：
  1. 进程以非 0 退出（exit code 1 / 认证失效 / 参数错误 / crash）；
  2. 进程虽为 0 退出但输出流截断（没有 result 事件，单测 `stream-json/no-result-event` 中前台已明确将其判为 error/failure）；
  3. 执行被安全策略阻断且无有效回复。
  而对于「SUCCESS 但内容为空（如动作被拒）」的场景，L2199 的 `empty` 子分支已经先一步捕获并设置为了 `status = 'failed'`。
  因此进入底部的 `else` 分支**必定是异常或失败**，原代码设置为 `completed` 属于明显的逻辑颠倒。将其改为 `status = 'failed'` 100% 正确。

### 2. F1-3 的宿主契约：接受「先按对象返回」还是要求更保守的字符串返回？
- **明确结论**：**两者皆非。必须维持同步返回 `JobHooks` 对象（`{ cancel, done, readOutput }`），严禁把 `run` 改为 async 返回任意结果对象。**
- **理由**：
  如前所述，`node_modules/@deepseek-ai/dsh-jobs/lib/types/types.d.ts` 和 `test/harness.mjs:170` 明确定义了契约：`run()` 必须同步返回包含 `cancel` 和 `done` 的句柄对象。
  宿主对后台 job 文本的获取，是通过定时或结算时调用 `hooks.readOutput()` 收集入环形缓冲区；
  如果把 `run` 改成 `async () => { ... }`，不仅 `test/run.mjs` 中的所有后台测试全部抛错失败，真实宿主也无法执行 `job_kill`。
  如果宿主确实需要通过 `done` 的 resolve 值获取输出，`bg.done` resolve 的对象可以补充 `output: string`，但 `run()` 本身的同步工厂函数签名绝不可更改。

### 3. F1-1 的 `--add-dir` 去重：是否需要 `Set` 去重？
- **明确结论**：**不需要在合并处手动加 `Set` 去重。**
- **理由**：
  查阅 `src/index.ts` 第 1475 行，`spawnPlan` 接收到 `dirs` 参数后，第一行代码就是：
  `const addDirs = validateAddDirs(PREFIX, dirs, 'config/tool')`
  而在 `validateAddDirs` 实现中（`src/index.ts` L925-946），已经内置了：
  ```ts
  const seen = new Set<string>()
  for (const raw of dirs) {
    ...
    if (!seen.has(dir)) {
      seen.add(dir)
      out.push(dir)
    }
  }
  ```
  它已经在保证顺序的同时完成了严格去重与路径合法性校验。因此外层调用处直接传入 `[...this.config.addDirs, ...extraDirs]` 即可，不会生成重复的 `--add-dir` 标志。

### 4. F2-3 的重构 vs 改文档：是否接受降级为「只改文档」？
- **明确结论**：**强烈建议降级为「只改文档」（推荐方案）；若团队坚持代码重构，必须先补充完整重构细节清单。**
- **理由**：
  主工具 `antigravity` 在传入 `task` 时，已经完全支持了前台续聊、后台续聊（`background: true`）、目录扩充（`dirs`）以及模型/思考参数覆盖（`model`/`effort`），功能完备且已被充分测试；
  `antigravity_followup` 诞生时的实际定位就是一个只有 3 个必填参数（`description`, `task`, `prompt`）的前台快捷工具。
  如果要强行将 `antigravity_followup` 改造为完整别名，必须同步修改其输入 Schema、放宽其输出 Schema（去除非前台场景下的必填字段）、重写其 `render` 渲染逻辑以防止 undefined 崩溃。这一系列改动的破坏半径和测试成本明显超出收益。
  直接将 `docs/interfaces-reference.md` 和 `README.zh.md` 中的「别名且支持后台」纠正为「前台快捷工具，后台续聊请使用 `antigravity(task: ...)`」，是风险最低、契约最清晰的做法。

### 5. F1-5 的内存上限：32 MB 是否合适，还是流式写文件？
- **明确结论**：**建议采用「16 MB 内存上限 + 显式截断标记」，无需引入复杂的临时文件流式追加。**
- **理由**：
  虽然流式写入临时文件从理论上能做到无上限，但需要处理跨平台文件句柄、异常退出清理、Windows 文件独占锁等问题，复杂度过高且增加崩溃面。
  但在 Node.js 内存中保持 32 MB 的字符串数组（`rawLines: string[]`）会产生 10 万到 20 万个碎片字符串对象，V8 堆内存实际占用可达 80-100 MB，最后 `join('\n')` 又需要分配一块连续的 32 MB 内存，存在 GC 停顿甚至 OOM 隐患。
  对于 NDJSON 审计事件流，**16 MB** 已经足够容纳数万步高密度事件。
  在达到 16 MB 上限停止 push 时，追加一行显式的截断注释（例如 `# [transcript truncated: exceeded 16MB ceiling]`），既保护了宿主进程内存安全，又保证了日志读取者能明确得知日志截断事实，避免被误判为数据损坏。

---

## 建议的执行顺序调整

原计划中的执行顺序将高风险的 F1-3 放在中间，且未考虑 F1-3 被否决后的情况。修正后的安全执行顺序如下：

| 步骤 | 内容 | 变更说明 |
|---|---|---|
| **0** | 基线固化与验证 | `git diff > scratch/baseline.patch`，确认 `npm run build && npm test` 135 项全绿。 |
| **1** | **F1-1**（后台补 addDirs） | 极低风险，直接改 `startBackground` 与 `startPanelRun`。 |
| **2** | **F1-4**（句柄与返回加 task） | 修正 L2271 行号，加 `id` 并让 L2718 返回 `task: bg.id`。 |
| **3** | **F1-2**（失败结算改 failed） | 将 L2217 的 `else` 改为 `status = 'failed'`。 |
| **4** | **F1-5**（后台 transcript） | 修正 L2168 行号，统一在 `consumeLine` 收集，采用 16 MB 截断。 |
| **5** | **回归 F1** | 此时先完整运行 `npm test`，确认后台基线依然全部通过。 |
| **6** | **F2-1 + F2-2**（cancel 不抛错 + parseTaskKey） | 合并执行，记得将 `parseTaskKey` 同时赋给 `antigravity_cancel`。 |
| **7** | **F2-4**（文档 output 类型修正） | 纯文档修正，无代码风险。 |
| **8** | **F2-3 裁定执行** | **建议直接执行文档修正**；若执行重构，必须同步改完 schema 与 render 再做单测。 |
| **9** | **审慎评估 F1-3** | 绝不采用原计划的 async run；保持 `run: () => bg`，验证现有 `readOutput` 机制是否已满足端到端需求。 |
