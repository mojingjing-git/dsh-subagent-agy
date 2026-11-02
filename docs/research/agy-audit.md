# @dsh-external/dsh-subagent-antigravity 对抗式契约一致性审计报告

> **审计模式**：对抗式契约一致性审计（找 Bug、断言违背、承诺未兑现、死代码、静默失败、竞态与资源泄漏）  
> **审计标的**：`lib/index.js`（约 2580 行）及 11 个关联模块、`docs/*.md`、`README*.md`、类型定义与配置 Schema  
> **严重级别**：  
> - **P0**：用户/模型会因此做错事、关键状态虚假报告或数据损坏  
> - **P1**：核心契约承诺功能失效但有部分绕过路径  
> - **P2**：死代码、数据不一致、脏数据、性能浪费与体验缺陷  
> - **P3**：规范洁癖、极端平台边界、低频边缘情况  
> **排除项基准**：Bug #0（后台任务 job 结果无法获取文本，`lib/index.js:2301`）已由用户确认，不作为新编号重复报告。

---

## 一、审计问题总表

| 编号 | 类别 | 级别 | 涉及文件与行号 | 简述 |
|---|---|---|---|---|
| **BUG-01** | 承诺 vs 实现 / 静默失败 | **P0** | `lib/index.js:1850-1853` | 后台任务非 0 退出或出错时，被强行标记为 `status: 'completed'` 假装成功 |
| **BUG-02** | 配置项空转 | **P0** | `lib/index.js:1602`, `1626` | 新建后台任务与面板续跑完全丢弃配置项 `config.addDirs`，导致外部目录任务直接挂起超时 |
| **BUG-03** | 承诺 vs 实现 / Schema | **P1** | `lib/index.js:2317` vs `docs/interfaces-reference.md:44-51` | 新建后台任务返回值彻底缺失 `task` 键，使调用方无法追踪和后续续聊 |
| **BUG-04** | 承诺 vs 实现 | **P1** | `lib/index.js:2345-2415` vs `docs/interfaces-reference.md:71` | `antigravity_followup` 声称是别名并代理到相同处理，实为不支持后台与覆盖参数的独立实现 |
| **BUG-05** | 承诺 vs 实现 | **P1** | `lib/index.js:2566-2569` vs `docs/interfaces-reference.md:121-130` | `antigravity_cancel` 传入非活跃/历史任务直接抛出异常，违反返回 `{ cancelled: false }` 契约 |
| **BUG-06** | 承诺 vs 实现 | **P1** | `lib/index.js:2235`, `2390` vs `lib/index.js:2179`, `2347` | 工具描述声称可传入 `[task: ...]` 行续聊，代码未做正则提取直接查表抛出异常 |
| **BUG-07** | 承诺 vs 实现 | **P1** | `lib/index.js:1633-1904` vs `docs/configuration.md:106` | 后台运行任务完全未调用 `writeTranscript`，导致后台任务永远不写入事件流文件 |
| **BUG-08** | 资源泄漏 / 竞态 | **P1** | `lib/index.js:1613-1632` vs `1305`, `1336` | 面板「接着跑」完全绕过 `followupGates` 会话互斥锁，可与工具续聊并发写入同一会话文件 |
| **BUG-09** | 配置项空转 | **P1** | `lib/index.js:850-865` vs `docs/interfaces-reference.md:24` | 显式配置模型后，单次工具调用传 `model: 'auto'` 无法覆盖配置项，沦为无效空转 |
| **BUG-10** | 静默失败 | **P1** | `lib/client.js:755` | 客户端 400ms 轮询 `/run` 遇到异常空 catch，导致面板在任务失效后永久死锁在「运行中…」 |
| **BUG-11** | 死代码 / 算了没人用 | **P2** | `lib/agy-panel.js:383-384` vs `lib/client.js:744-752` | `/api-agy/run` 算出的 `steps` 和 `stepsVersion` 被客户端彻底丢弃，从未在前端渲染 |
| **BUG-12** | 死代码 / 算了没人用 | **P2** | `lib/agy-panel.js:385` vs `lib/client.js:744-752` | `/api-agy/run` 返回的 `elapsedMs` 被客户端直接忽略丢弃 |
| **BUG-13** | 死代码 / 承诺未兑现 | **P2** | `lib/agy-panel.js:396-407` vs `lib/client.js` | 服务端实现的 `/api-agy/prefs` 路由在前端完全无调用，隐藏/显示会话承诺落空 |
| **BUG-14** | 静默失败 | **P2** | `lib/client.js:799-801` | 客户端点击「停止」按钮异常被空 catch 吞噬，前端无视后端失败乐观强改状态为 `cancelled` |
| **BUG-15** | 配置项空转 / 静默失败 | **P2** | `lib/index.js:997-1017` | `launchLogin` 中构建的 `env` 与代理配置未传入 `subprocess.spawn`，登录窗口代理失效 |
| **BUG-16** | 承诺 vs 实现 / 静默失败 | **P2** | `lib/agy-steps.js:58-68`, `221-239` | 超过 2KB 的文件写入参数被截断，导致 `filesTouched` 丢失文件路径，摘要统计文件数归零 |
| **BUG-17** | 承诺 vs 实现 | **P2** | `lib/index.js:325` vs `docs/configuration.md:40` | `agy-proxy.txt` 承诺只读取第一行，实现读取整个文件，导致多行/注释污染代理环境变量 |
| **BUG-18** | Schema 与返回值不一致 | **P2** | `lib/index.js:2212` vs `docs/interfaces-reference.md:40` | 前台任务 `output` 在 schema 与代码中均为数组对象，文档却承诺为 `string` |
| **BUG-19** | 资源泄漏 / 竞态 | **P2** | `lib/index.js:646-660` | `writeTranscript` 中对 `index.json` 的读写无锁，并发前台任务存在读取-修改-写回竞态 |
| **BUG-20** | 资源泄漏 / 竞态 | **P2** | `lib/agy-models.js:121`, `lib/agy-panel.js:257` 等 | 4 个模块的原子写入临时文件固定使用 `${path}.${process.pid}.tmp`，同进程异步并发写冲突 |
| **BUG-21** | 资源泄漏 / 竞态 | **P2** | `lib/index.js:1794-1795` | 后台标准输出流按 chunk 裸调用 `.toString('utf8')` 未使用 StringDecoder，多字节字符截断损坏 |
| **BUG-22** | 平台假设 | **P3** | `lib/agy-history.js:203` | `isProse` 路径识别仅匹配 Windows 盘符 `^[A-Za-z]:[\\/]`，Linux/macOS 绝对路径易被误判为人读语句 |
| **BUG-23** | 平台假设 | **P3** | `lib/agy-steps.js:255` | `filesTouched` 强行使用 `toLowerCase()` 作为去重键，破坏 Linux 大小写敏感文件系统一致性 |
| **BUG-24** | 边界条件 | **P3** | `lib/index.js:1181-1207` | 用户 prompt 接近 30000 字符时，插件追加的环境提示词使其超出限制且在无 `--prompt-file` 时抛错 |

---

## 二、逐条问题详述

### BUG-01 【P0】后台任务非 0 退出或报错被强行标记为 `status: 'completed'` 伪造成功
- **涉及位置**：`lib/index.js:1850-1853`，关联 `lib/agy-panel.js:43-46`
- **关键代码片段**：
  ```javascript
  // lib/index.js:1850-1853
  else {
      status = 'completed';
      detail = this.maybeAutoLogin((finalError !== undefined && finalError.length > 0 ? finalError : stderr.trim()) || `agy exited with code ${String(outcome.exitCode)}`);
  }
  ```
- **承诺在哪**：
  `docs/agy-integration.md:114` 特别强调「结算不撒谎（Settlement does not lie）——这是本集成最重要的规则」；`docs/interfaces-reference.md:199` 明确规定后台任务在完成时将结果通知 owner agent。
- **实现在哪、差在哪**：
  在 `runBackgroundPlan` 中，当 agy 进程退出且 `finalStatus !== 'SUCCESS'` 时（例如进程 exit code 1 失败、认证失败或 CLI 报错），代码进入 `else` 分支，竟然将 `status` 赋值为 `'completed'`，而不是 `'failed'`！
  连锁反应：在 `lib/agy-panel.js:43` 中：
  ```javascript
  run.status = outcome.status === 'completed' ? 'done' : outcome.status === 'killed' ? 'cancelled' : 'failed';
  if (outcome.status !== 'completed') run.error = outcome.detail;
  ```
  因为 `outcome.status` 被错误设置成了 `'completed'`，面板端状态直接变成 `'done'`，且 `run.error` 被直接跳过不赋值！在 DSH Jobs 体系内，该 job 也以成功态结算唤醒主模型，主模型误认为子代理成功完成并基于错误结果继续推导。
- **严重度判定**：**P0**。彻底违背任务完成状态真实性，导致模型把错误当成功，产生严重逻辑误判。
- **验证方式**：启动一个预期失败的后台任务（例如传入非法参数或引发 CLI 报错），检查 `jobsService.wait()` 返回的 `settled.status`，实测将观察到其为 `'completed'` 而非 `'failed'`。

---

### BUG-02 【P0】新建后台任务与面板续跑完全丢弃配置项 `config.addDirs`
- **涉及位置**：`lib/index.js:1602`, `1626`
- **关键代码片段**：
  ```javascript
  // lib/index.js:1600-1604
  async startBackground(request, extraDirs, overrides) {
      const { config } = this;
      const plan = await this.spawnPlan(request, undefined, undefined, extraDirs, config.backgroundTimeoutMs, overrides);
      return this.runBackgroundPlan(plan, config.backgroundTimeoutMs);
  }

  // lib/index.js:1626
  const plan = await this.spawnPlan(request, input.conversationId, input.cwd, [], config.backgroundTimeoutMs)
  ```
  对比正确合并的地方（前台及 resume）：
  ```javascript
  // lib/index.js:1288
  return this.runOnce(request, undefined, undefined, [...this.config.addDirs, ...extraDirs], this.config.printTimeoutMs, overrides);
  // lib/index.js:1326
  const plan = await this.spawnPlan(request, conversationId, cwd, [...this.config.addDirs, ...extraDirs], this.config.backgroundTimeoutMs, overrides);
  ```
- **承诺在哪**：
  `docs/configuration.md:32, 47-49` 警告：「Targets outside the session workspace: Use absolute paths for addDirs when the task touches anything outside the session workspace. Headless agy cannot answer the interactive "add directory to workspace?" prompt and will hang until its timeout fires.」
- **实现在哪、差在哪**：
  在前台方法 `startWithDirs`（1288行）和续跑后台 `startResumeBackground`（1326行）中，代码都正确做了 `[...this.config.addDirs, ...extraDirs]` 的合并。但在**新建后台任务 `startBackground`**（1602行）中，直接只传入了 `extraDirs`，把 `this.config.addDirs` 彻底漏掉了！在面板续跑 `startPanelRun`（1626行）中更是写死了 `[]`！
  一旦用户在配置文件中声明了全局 `addDirs`，通过 `background: true` 派发的新任务完全拿不到这些目录，无头 agy 遇到非工作区文件必然触发交互提示并挂起直至 1 小时超时被杀。
- **严重度判定**：**P0**。配置声明核心安全与目录机制在后台主场景下失效，导致长时间进程挂起与任务报废。
- **验证方式**：在配置文件中指定 `addDirs: ['C:\\some\\dir']`，调用 `antigravity({ prompt: '...', background: true })`，检查生成进程的 argv 中是否缺少 `--add-dir`。

---

### BUG-03 【P1】新建后台任务返回值彻底缺失 `task` 键
- **涉及位置**：`lib/index.js:2317` vs `docs/interfaces-reference.md:44-51`
- **关键代码片段**：
  ```javascript
  // lib/index.js:2317（新建后台任务）
  return { kind: 'background', jobId };

  // lib/index.js:2263（resume 后台任务）
  return { kind: 'background', jobId, task };
  ```
- **承诺在哪**：
  `docs/interfaces-reference.md:44-51` 明确声明契约：
  ```ts
  // Background mode:
  {
    kind: 'background',
    jobId: string, // use with job_output / job_kill
    task: string   // task key for resuming after settlement
  }
  ```
  且 `lib/index.js:2206` 的 `output.schema` 亦声明了 `task: { type: 'string' }`。
- **实现在哪、差在哪**：
  在 `execute` 中处理非 resume 的新建后台任务时（第 2317 行），返回对象仅为 `{ kind: 'background', jobId }`，遗漏了 `task` 字段（而第 2263 行 resume 路径则返回了 `task`）。结合 Bug #0（后台 job 文本输出读不到），调用模型不仅当前拿不到 `task`，事后也完全无法得知该任务的 task key，导致后续无法通过 `antigravity_followup` 续聊。
- **严重度判定**：**P1**。违反工具返回值 schema 与契约文档，破坏任务续聊链条。
- **验证方式**：调用 `await ctl.callTool('antigravity', { description: 'test', prompt: 'test', background: true })`，断言返回结果中是否包含 `task` 属性。

---

### BUG-04 【P1】`antigravity_followup` 声称为别名且支持后台，实为不支持后台与覆盖参数的独立实现
- **涉及位置**：`lib/index.js:2345-2415`
- **关键代码片段**：
  ```javascript
  // lib/index.js:2366-2378
  output: {
      schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
              kind: { type: 'string', required: true, const: 'foreground' }, // 仅支持 foreground！
  ...
  async execute(args, exec) {
      // 独立实现，直接调用 provider.followup(...)，无 background 判断分支
  ```
- **承诺在哪**：
  `docs/interfaces-reference.md:63, 71`：「Kept as an alias of `antigravity(task: ...)`. Internally delegates to the same handler as `antigravity`; returns the same foreground/background shape.」；`README.zh.md:62-63` 称两种用法都支持 `background: true`。
- **实现在哪、差在哪**：
  代码并没有代理到同一个 handler，而是注册了完全独立的工具：
  1. 参数仅声明了 `{ description, task, prompt }`，根本没有 `background`、`model`、`effort` 参数；
  2. output schema 强制限制 `kind` 为 `const: 'foreground'`；
  3. `execute` 内未对接 `jobs.start`，无法在后台运行；
  4. 甚至没有对传入的 `args.task` 执行 `.trim()`。
- **严重度判定**：**P1**。用户/模型按文档将 `antigravity_followup` 当做别名传入 `background: true` 或 `model` 时，参数被静默忽略或因 schema 报错。
- **验证方式**：检查 `ctx.tools` 中 `antigravity_followup` 的参数声明及返回值 schema。

---

### BUG-05 【P1】`antigravity_cancel` 传入非活跃/历史任务直接抛出异常，违反返回 `{ cancelled: false }` 契约
- **涉及位置**：`lib/index.js:2566-2569` vs `docs/interfaces-reference.md:121-130`
- **关键代码片段**：
  ```javascript
  // lib/index.js:2566-2569
  const cancelled = current.cancelActive(args.task);
  if (!cancelled) {
      throw new Error(`${PREFIX}: no running task "${args.task}" — running tasks are listed by ${config.tasksToolName}; finished tasks cannot be cancelled (their conversations resume via ${config.followupToolName})`);
  }
  return {
      cancelled: true,
      task: args.task,
      message: `Cancellation requested for task ${args.task} — its run settles as cancelled.`,
  };
  ```
- **承诺在哪**：
  `docs/interfaces-reference.md:121-130` 明确承诺：
  - 参数 `task` 描述为：「Task key from `antigravity_tasks` (either `running` or `recent` list).」
  - 返回值 `cancelled` 描述为：「`cancelled: boolean, // true only if a live run was actually stopped`」
- **实现在哪、差在哪**：
  如果传入的 task 是已完成任务（文档明确告知可以传 `recent` 列表中的 key）或已终止任务，`cancelActive` 返回 `false`，代码直接 `throw new Error(...)`！工具执行彻底失败，该工具永远无法返回 `{ cancelled: false, ... }`。
- **严重度判定**：**P1**。调用模型根据文档传入已完成任务检查或取消时，预期得到 `{ cancelled: false }` 却遭遇工具调用崩溃抛错。
- **验证方式**：调用 `antigravity_cancel({ task: 'non-running-task' })`，断言是否抛出异常而非返回 `{ cancelled: false }`。

---

### BUG-06 【P1】工具描述声称可传入 `[task: ...]` 行续聊，代码未做正则提取直接查表抛出异常
- **涉及位置**：`lib/index.js:2235-2236`, `2390-2391` vs `lib/index.js:2179`, `2347`
- **关键代码片段**：
  ```javascript
  // lib/index.js:2235-2236
  const task = args.task.trim();
  const record = loadTaskRegistry(config)[task];
  if (record === undefined) {
      throw new Error(`${PREFIX}: no such task "${task}" — run the antigravity tool first...`);
  }
  ```
- **承诺在哪**：
  工具参数描述（`lib/index.js:2179`）：「pass the `task` key returned by an earlier call (or its [task: ...] line).」；`antigravity_followup` 描述（`lib/index.js:2347`）：「Pass the `task` key from the antigravity result or its [task: ...] line」。
- **实现在哪、差在哪**：
  注册表中的 key 为纯 ID（如 `sess::agy::1`）。代码没有任何提取 `[task: (.*)]` 正则或去除外围括号的前置处理，直接使用 `args.task.trim()` 查表。当模型遵循工具 prompt 提示直接把 `[task: sess::agy::1]` 传给 `task` 参数时，直接触发 `no such task "[task: sess::agy::1]"` 异常。
- **严重度判定**：**P1**。工具自身描述引导模型的调用方式在实现中未予支持，直接引发调用失败。
- **验证方式**：调用 `ctl.callTool('antigravity', { prompt: 'hi', task: '[task: valid-task-id]' })`，验证是否抛出 `no such task`。

---

### BUG-07 【P1】后台运行任务完全未调用 `writeTranscript`，导致后台任务永远不写入事件流文件
- **涉及位置**：`lib/index.js:1633-1904` vs `docs/configuration.md:106`
- **关键代码片段**：
  全局搜索 `writeTranscript` 仅在 `runOnce`（前台）的两处出现：
  ```javascript
  // lib/index.js:1470
  transcriptPath = config.transcript === false ? undefined : writeTranscript(config, plan.id, transcriptHeader(plan) + stdout);
  // lib/index.js:1552
  transcriptPath = writeTranscript(config, plan.id, transcriptHeader(plan, status) + raw);
  ```
  而在 `runBackgroundPlan`（1633-1904行）全流程中，**没有任何一处调用 `writeTranscript`**。
- **承诺在哪**：
  `docs/configuration.md:106, 114` 承诺：「`transcript: true` Persist each run's raw event stream as NDJSON. A transcript is the only record of what a delegated task actually did」；`docs/architecture.md:61` 指明 transcripts 会被保存在 `~/.dsh/agy-transcripts/<task>.ndjson`。
- **实现在哪、差在哪**：
  后台任务通过标准输出流管道收集 NDJSON，但在结束处理时（1810-1885行）仅更新了注册表 `updateTaskRegistry`，完全遗漏了向 `~/.dsh/agy-transcripts/` 写入 `.ndjson` 及更新 `index.json` 的逻辑！所有在后台运行的任务，在插件专属 transcript 目录中没有任何落盘痕迹。
- **严重度判定**：**P1**。违反架构与配置关于审计日志与事件流持久化的核心承诺，导致后台执行证据完全丢失。
- **验证方式**：执行一个后台任务直至完成，检查 `~/.dsh/agy-transcripts/` 下是否存在该任务对应的 `.ndjson` 文件。

---

### BUG-08 【P1】面板「接着跑」完全绕过 `followupGates` 会话互斥锁，与工具续聊并发写入同一会话文件
- **涉及位置**：`lib/index.js:1613-1632`，对比 `1305`, `1336`
- **关键代码片段**：
  ```javascript
  // lib/index.js:1613-1631
  async startPanelRun(input) {
      const { config } = this;
      const abort = new AbortController();
      ...
      const plan = await this.spawnPlan(request, input.conversationId, input.cwd, [], config.backgroundTimeoutMs)
          .finally(() => abort.abort());
      plan.baseArgv.push('--conversation', input.conversationId);
      return this.runBackgroundPlan(plan, config.backgroundTimeoutMs); // 未经过 followupGates！
  }
  ```
- **承诺在哪**：
  `docs/interfaces-reference.md:73-76` 承诺：「Resumption gate: Follow-ups to the same conversation id are serialized: a second prompt waits for the first to finish, preventing two processes from interleaving writes into one agy conversation file.」
- **实现在哪、差在哪**：
  在 provider 中，`followupSerialized` 和 `startResumeBackground` 均在 `this.followupGates` 中加锁互斥。然而侧边栏面板触发的 `startPanelRun` 却直接调用了 `spawnPlan` 与 `runBackgroundPlan`，完全不获取、不等待、也不登记 `followupGates`。同时 `RunStore.isRunning` 仅检查面板内部内存，不感知工具调用。当外部 Agent 正在通过工具对某会话执行操作时，用户在侧边栏点击「接着跑」，两个 agy 进程将同时向同一个 `<id>.db` 写入，造成 SQLite 锁争用或文件损坏。
- **严重度判定**：**P1**。锁屏障出现结构性绕过，并发写破坏会话文件完整性。
- **验证方式**：模拟前台 tool 运行某 conversationId，同时发起 `startPanelRun`，断言两个进程是否发生并发启动。

---

### BUG-09 【P1】显式配置模型后，单次工具调用传 `model: 'auto'` 无法覆盖配置项，沦为无效空转
- **涉及位置**：`lib/index.js:850-865` vs `docs/interfaces-reference.md:24`
- **关键代码片段**：
  ```javascript
  // lib/index.js:850-865
  modelFor(override) {
      const requested = override?.trim() ?? '';
      if (requested.length === 0 || requested.toLowerCase() === 'auto')
          return this.resolvedModel();
      return requested;
  }
  resolvedModel() {
      const configured = this.config.model.trim();
      if (configured.toLowerCase() !== 'auto')
          return configured;
      return this.modelCatalog?.chosen ?? '';
  }
  ```
- **承诺在哪**：
  `docs/interfaces-reference.md:24` 规定工具参数 `model`：「Override the model for this call only... `auto` = newest Gemini Flash at highest thinking level. Omitted = inherit plugin config.」
- **实现在哪、差在哪**：
  如果用户在配置中指定了静态模型（如 `config.model = 'claude-sonnet-4-6'`），当模型在工具调用中传入 `model: 'auto'` 时，`modelFor` 将 `requested` 识别为 auto 并调用 `resolvedModel()`；然而 `resolvedModel()` 首先检查 `if (this.config.model.trim().toLowerCase() !== 'auto') return configured;`，直接返回了 `claude-sonnet-4-6`！
  单次覆盖传入的 `auto` 彻底失效，无法动态选用最新的 Gemini Flash，行为与省略该参数没有任何区别。
- **严重度判定**：**P1**。单次调用模型参数无法按照契约选择 auto 模型，逻辑完全被静态配置覆盖。
- **验证方式**：配置 `model: 'claude-sonnet-4-6'`，调用 `antigravity` 传入 `{ model: 'auto' }`，检查 spawn argv 中的 `--model` 是否为 claude 而不是 Gemini Flash。

---

### BUG-10 【P1】客户端 400ms 轮询 `/run` 遇到异常空 catch，导致面板在任务失效后永久死锁在「运行中…」
- **涉及位置**：`lib/client.js:740-756`
- **关键代码片段**：
  ```javascript
  // lib/client.js:740-756
  const timer = setInterval(() => {
    post('/run', { runId, since: cursorRef.current })
      .then((payload) => {
        if (!alive) return
        cursorRef.current = payload.cursor
        setRun((prev) => (prev !== null && prev.id === runId
          ? {
            ...prev,
            text: payload.reset ? payload.text : prev.text + payload.text,
            status: payload.status,
            tool: payload.tool,
            error: payload.error,
          }
          : prev))
      })
      .catch(() => {}) // 空 catch，吞掉所有网络或业务错误！
  }, 400)
  ```
- **承诺在哪**：
  `docs/sidebar-panel.md` 描述轮询机制与状态转换；面板承诺如实展示当前运行状态与失败原因。
- **实现在哪、差在哪**：
  在 `RunStore` 中，如果服务端经历重启，或内存中 run 数量超过 20 条触发 `prune()` 剔除了该 run，服务端路由 `/run` 会返回 400 `{ ok: false, error: 'unknown run (it may have expired)' }`。
  客户端的 `post` 函数会抛出 Error，但被此处 `.catch(() => {})` 彻底静默吞没。结果：`setRun` 永远不被触发，`run.status` 保持 `'running'`，`timer` 每 400ms 持续发送无效请求，前端面板永久死锁显示「运行中…」，用户无法重试也无法看清错误。
- **严重度判定**：**P1**。前端 UI 产生不可逆的虚假运行状态死锁。
- **验证方式**：在面板启动一次运行后，人为在后端删除该 runId，观察前端面板是否停滞在「运行中…」且控制台无任何错误反馈。

---

### BUG-11 【P2】`/api-agy/run` 算出的 `steps` 和 `stepsVersion` 被客户端彻底丢弃，从未在前端渲染
- **涉及位置**：`lib/agy-panel.js:383-384` vs `lib/client.js:744-752`
- **关键代码片段**：
  ```javascript
  // lib/agy-panel.js:383-384（服务端精心计算并返回）
  steps: run.steps,
  stepsVersion: run.stepsVersion,

  // lib/client.js:744-752（客户端直接丢弃）
  setRun((prev) => (prev !== null && prev.id === runId
    ? {
      ...prev,
      text: payload.reset ? payload.text : prev.text + payload.text,
      status: payload.status,
      tool: payload.tool,
      error: payload.error,
    }
    : prev))
  ```
- **承诺在哪**：
  `docs/sidebar-panel.md:58-64` 详细说明了设计哲学：「Steps: they are updated data, not an append-only stream... They therefore travel as a whole list with a stepsVersion fingerprint; the client replaces the list when the version changes rather than trying to delta it.」
- **实现在哪、差在哪**：
  文档声称客户端会根据 `stepsVersion` 指纹替换列表，服务端也在每 250ms 的 `drain` 中不断解析 `steps` 并生成版本指纹；但客户端 `client.js` 解构 payload 时根本没有读取 `steps` 和 `stepsVersion`，而是在运行结束后才去重新请求 `/history`。服务端消耗 CPU 维持的步骤流沦为纯粹的死数据。
- **严重度判定**：**P2**。文档承诺的实时步骤更新机制落空，服务端无效计算。

---

### BUG-12 【P2】`/api-agy/run` 返回的 `elapsedMs` 被客户端直接忽略丢弃
- **涉及位置**：`lib/agy-panel.js:385` vs `lib/client.js:744-752`
- **关键代码片段**：
  `lib/agy-panel.js:385` 返回了 `elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt`。在 `lib/client.js:745-753` 中该属性未被接收和使用。
- **承诺与差异**：服务端专门计算了运行毫秒数，前端无消费者。
- **严重度判定**：**P2**。

---

### BUG-13 【P2】服务端实现的 `/api-agy/prefs` 路由在前端完全无调用，隐藏/显示会话承诺落空
- **涉及位置**：`lib/agy-panel.js:396-407` vs `lib/client.js`
- **关键代码片段**：
  `lib/agy-panel.js:396-407` 注册了 POST `/api-agy/prefs`，用于 `{ hide, show }` 会话偏好设置。在 `lib/client.js` 全文搜索 `prefs`，无任何调用代码；UI 上也没有任何隐藏会话的操作入口。
- **承诺在哪**：
  `docs/sidebar-panel.md:38` 明确将 `/prefs` 列在对外公开的 Routes 表格中（「Hide/unhide a conversation from the list」）。
- **实现在哪、差在哪**：
  服务端与 `readPrefs/writePrefs` 功能完整，但前端未提供对应功能，路由成为死代码。
- **严重度判定**：**P2**。

---

### BUG-14 【P2】客户端点击「停止」按钮异常被空 catch 吞噬，前端无视后端失败乐观强改状态为 `cancelled`
- **涉及位置**：`lib/client.js:798-801`
- **关键代码片段**：
  ```javascript
  const stop = useCallback(() => {
    if (run === null) return
    post('/cancel', { runId: run.id }).catch(() => {})
    setRun((prev) => (prev === null ? prev : { ...prev, status: 'cancelled' }))
  }, [run])
  ```
- **实现在哪、差在哪**：
  点击停止后，发起取消请求但对 Promise 进行了空 catch 处理。若后端取消失败（如 400 状态不匹配或网络错误），前端界面直接乐观显示为「已停止」，向用户反馈虚假的停止成功状态，实际后端进程仍在运行。
- **严重度判定**：**P2**。静默失败并掩盖错误状态。

---

### BUG-15 【P2】`launchLogin` 中构建的 `env` 与代理配置未传入 `subprocess.spawn`，登录窗口代理失效
- **涉及位置**：`lib/index.js:997-1017`
- **关键代码片段**：
  ```javascript
  // lib/index.js:997-1010
  const env = { ...scrubbedParentEnv(), ...config.env };
  applyProxyEnv(env, resolveProxyUrl(config)); // 精心准备了带代理的 env
  ...
  ctx.subprocess.spawn({
      argv: ['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath '${psPath}'${style}`],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4 << 10 }, stderr: { maxBytes: 4 << 10 } },
      graceMs: config.disposeGraceMs,
      // 遗漏了 env: env ！！！
  });
  ```
- **承诺在哪**：
  `docs/configuration.md:40`：「`proxy` is required in regions Google rejects with User location is not supported.」
- **实现在哪、差在哪**：
  在 `launchLogin` 中，代码合并了父环境、用户自定义环境变量并计算注入了 `HTTP_PROXY` 等代理变量，但传给 `ctx.subprocess.spawn` 的选项中根本没有 `env` 字段！PowerShell 默认继承宿主环境，导致启动的交互式登录窗口完全脱离配置的代理，在受限区域登录必然失败。
- **严重度判定**：**P2**。算好了但没传入下游，功能静默失败。

---

### BUG-16 【P2】超过 2KB 的文件写入参数被截断，导致 `filesTouched` 丢失文件路径，摘要统计文件数归零
- **涉及位置**：`lib/agy-steps.js:58-68`, `221-239`，关联 `lib/index.js:1476-1478`
- **关键代码片段**：
  ```javascript
  // lib/agy-steps.js:58-66
  if (serialized.length > MAX_TOOL_PARAM_TEXT) { // > 2048
      tool = {
          ...tool,
          parameters: {
              truncated: true,
              preview: truncate(serialized, MAX_TOOL_PARAM_TEXT),
          },
      };
  }
  ```
- **实现在哪、差在哪**：
  当调用文件写入工具（如 `write_to_file` / `replace_file_content`）写入代码超过 2048 字符时，`normalizeStep` 将 `tool.parameters` 暴力替换为 `{ truncated: true, preview: '...' }`，原对象的 `file_path` 等字段被完全抹除。
  随后 `filesTouched`（221行）去提取路径时，不仅原 key 丢失，且后备的字符串检测要求以 `\.[A-Za-z0-9]{1,8}$` 结尾，但此时 `preview` 已经带上了 `…(+xxx chars)` 的截断后缀，正则无法匹配，最终返回 `null`。
  导致实际开发中绝大多数代码修改在 `[agy]` 摘要中均被报告为 `0 files changed`。
- **严重度判定**：**P2**。统计失真，误导用户与调用方。

---

### BUG-17 【P2】`agy-proxy.txt` 承诺只读取第一行，实现读取整个文件，导致多行/注释污染代理环境变量
- **涉及位置**：`lib/index.js:325` vs `docs/configuration.md:40`
- **关键代码片段**：
  ```javascript
  // lib/index.js:325
  const text = readFileSync(join(base, 'agy-proxy.txt'), 'utf8').trim();
  return text.length > 0 ? text : '';
  ```
- **承诺在哪**：
  `docs/configuration.md:40` 和 `docs/agy-integration.md:87` 均明确承诺：「the first line of `~/.dsh/agy-proxy.txt`」。
- **实现在哪、差在哪**：
  实现直接读取全文件内容，未按换行符截断。若用户在文件中记录了备用代理、空行或注释，包含 `\n` 的完整多行字符串将被注入环境变量 `HTTP_PROXY`，引发子进程网络崩溃。
- **严重度判定**：**P2**。

---

### BUG-18 【P2】前台任务 `output` 在 schema 与代码中均为数组对象，文档却承诺为 `string`
- **涉及位置**：`lib/index.js:2212` vs `docs/interfaces-reference.md:40`
- **关键代码片段**：
  ```javascript
  // lib/index.js:2212
  output: { type: 'array', items: { type: 'json' } },
  ```
  而在 `docs/interfaces-reference.md:40` 中：
  ```ts
  output: string          // final answer + [agy] summary line
  ```
- **实现在哪、差在哪**：
  文档误导调用方可直接将 `result.output` 作为字符串使用，而实际代码返回的是 DSH Content 块数组 `[{ type: 'text', text: '...' }]`。
- **严重度判定**：**P2**。类型不一致。

---

### BUG-19 【P2】`writeTranscript` 中对 `index.json` 的读写无锁，并发前台任务存在读取-修改-写回竞态
- **涉及位置**：`lib/index.js:646-660`
- **关键代码片段**：
  ```javascript
  const indexPath = join(dir, 'index.json');
  ...
  const raw = readFileSync(indexPath, 'utf8');
  index = JSON.parse(raw);
  ...
  index.push({ task: id, file: path, at: new Date().toISOString() });
  writeJsonAtomic(indexPath, JSON.stringify(index, null, 2));
  ```
- **实现在哪、差在哪**：
  在注册表写入时，作者专门构建了 `registryTail` 串行 Promise 队列以避免 RMW 竞态；然而在 `writeTranscript` 中，多个并发前台任务在结算时各自读取磁盘上的 `index.json` 并原子写回，后写者将覆盖先写者的任务记录，造成 transcript 索引丢失。
- **严重度判定**：**P2**。

---

### BUG-20 【P2】4 个模块的原子写入临时文件固定使用 `${path}.${process.pid}.tmp`，同进程异步并发写冲突
- **涉及位置**：
  - `lib/agy-models.js:121`
  - `lib/agy-panel.js:257`
  - `lib/agy-usage.js:192`
  - `lib/agy-usage-log.js:125`
- **关键代码片段**：
  以 `agy-panel.js:257` 为例：
  ```javascript
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(prefs), 'utf8');
  renameSync(temp, path);
  ```
- **实现在哪、差在哪**：
  注释写道：「A per-process temp name: two writers sharing one `${path}.tmp` would interleave」，自以为引入 `process.pid` 就解决了冲突。但在同一个 Node.js 进程中，若并发执行两个异步操作，它们拥有完全相同的 pid，依然会竞争写入同一个 `${path}.${pid}.tmp`。对比 `lib/index.js:445`（加入了时间戳和随机串）显得极不严密。
- **严重度判定**：**P2**。

---

### BUG-21 【P2】后台标准输出流按 chunk 裸调用 `.toString('utf8')` 未使用 StringDecoder，多字节字符截断损坏
- **涉及位置**：`lib/index.js:1794-1795`
- **关键代码片段**：
  ```javascript
  // lib/index.js:1794-1795
  handle.stdout?.on('data', (chunk) => {
      buffer += chunk.toString('utf8'); // 裸转换！
  ```
- **实现在哪、差在哪**：
  后台任务采用流式事件管道。Node.js 的 Stream `data` 事件分块如果刚好将一个多字节字符（例如 UTF-8 的 3 字节中文字符）切割在两个 chunk 之间，直接调用 `chunk.toString('utf8')` 会立即把未完成的字节转化为 `\uFFFD` 乱码字符，导致后续 JSON.parse 崩溃或文本乱码。正确做法应当使用 `string_decoder` 的 `StringDecoder`。
- **严重度判定**：**P2**。

---

### BUG-22 【P3】`isProse` 路径识别仅匹配 Windows 盘符 `^[A-Za-z]:[\\/]`，Linux/macOS 绝对路径易被误判为人读语句
- **涉及位置**：`lib/agy-history.js:203`
- **关键代码片段**：
  ```javascript
  // lib/agy-history.js:203
  if (/^[A-Za-z]:[\\/]/.test(clean))
      return false;
  ```
- **实现在哪、差在哪**：
  过滤非人类句子的 prose 检查中，硬编码了 Windows 盘符正则。对于 Linux/macOS 下带空格的绝对路径（如 `/home/user/my folder/file.ts`），无法通过此项排除，容易被混入对话正文。
- **严重度判定**：**P3**。

---

### BUG-23 【P3】`filesTouched` 强行使用 `toLowerCase()` 作为去重键，破坏 Linux 大小写敏感文件系统一致性
- **涉及位置**：`lib/agy-steps.js:255`
- **关键代码片段**：
  ```javascript
  const key = path.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  ```
- **实现在哪、差在哪**：
  对修改文件列表去重时强行 `toLowerCase()`。在 Linux/macOS 大小写敏感场景下，`Makefile` 与 `makefile` 或 `App.tsx` 与 `app.tsx` 会被错误合并。
- **严重度判定**：**P3**。

---

### BUG-24 【P3】用户 prompt 接近 30000 字符时，插件追加的环境提示词使其超出限制且在无 `--prompt-file` 时抛错
- **涉及位置**：`lib/index.js:1181-1207`
- **关键代码片段**：
  `parameters.prompt` 要求保持在 30000 字符以内。当用户传入 29800 字符时，插件自身开启的 `avoidBrowser` 和 `avoidLargeReads` 追加了约 580 字符的提示词，导致最终 `effectivePrompt` 达到 30380 字符，超过 `MAX_ARGV_PROMPT_CHARS`（30000）。在当前 agy 不支持 `--prompt-file` 的情况下直接抛出错误拒绝执行。
- **严重度判定**：**P3**。

---

## 三、排查排除项（可疑但核实无害）

1. **`flagCachePath` 在 Config 中未提供 `.default()`**：
   - *怀疑点*：`lib/index.js:208` 中写为 `flagCachePath: z.string()`，缺少 `.default(...)`，怀疑用户传空配置 `{}` 时会导致校验失败。
   - *核实结果*：通过 `@deepseek-ai/schemastery` 实测，未加 `.required()` 的属性默认允许缺省并产出 `undefined`。代码在第 254 行显式做了 `if (config.flagCachePath !== undefined) return config.flagCachePath;`，成功 fallback 回默认路径，不会崩溃。

2. **Windows 下 `renameSync` 覆盖已有目标文件**：
   - *怀疑点*：Windows 历史版本或部分实现中对已存在的目标文件调用 `renameSync` 会报 `EEXIST` 或权限拒绝。
   - *核实结果*：Node.js 16+ 在 Windows 上封装的 `renameSync` 在目标文件未被占用独占锁时具备原子覆盖能力，实测单进程测试全部通过。

3. **`RunStore.runs` 定时器内存泄漏导致 Node 无法退出**：
   - *怀疑点*：`agy-panel.js` 中的 250ms interval 是否会导致进程挂起无法退出。
   - *核实结果*：代码在创建 timer 时显式调用了 `run.timer.unref?.()`，在 Node.js 环境下已解除对事件循环的持有，不会阻止主进程退出。

4. **`loginWindowMinimized` 配置生效机制**：
   - *怀疑点*：PowerShell 启动参数是否正确传递最小化状态。
   - *核实结果*：代码拼接了 `Start-Process -FilePath '...' -WindowStyle Minimized`，实测在 Windows 下正常拉起最小化终端窗口。
