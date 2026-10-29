# PLAN — dsh-subagent-agy 使用体验改进

基线：`ef93f7c release: 0.2.0-patched.15`（`main`）。
来源：外部评审（agy / gemini-3.8-flash-high）对 10 条设想的逐条结论 + 本机实测。

## 0. 评审后的取舍

保留（评审同意且证据充分）：

- 空回答/拒绝被结算成 `completed` 是**静默假成功**（`src/index.ts:1744`、`:2051`）。
- 后台超时只留一行原因，半截输出未落盘（`:2045`）。
- 工具描述过长抑制调用意愿（`:2262`，25 行防御性说明）。
- `model`/`effort` 底层已就绪、只是没暴露（`:1519-1529`）；用量/耗时已在抓、只是没外露（`agy-steps.ts:10`、`:1915`、`:2292`）。
- 续聊缺 `background`（`:2442`）；`dirs` 缺省会挂死（`:2280`、`:1470`）。

驳回 / 降级：

- **不删** `antigravity_tasks`：它持有 `~/.dsh/agy-conversations.json` 的持久索引，`job_list` 是瞬态的，跨重启无法续聊。
- **不删** `antigravity_cancel`：前台运行不受 `job_kill` 约束。
- **不裸跑 `git diff`**：工作区可能不是 git 或有既有脏改动；以 agy 自己的写文件工具步骤为准。
- 配置瘦身（preset）本轮不做：需要 schema 兼容层，收益低于风险。

## 0.1 复审修正（第二轮，已并入下文）

1. 前台 stdio 是 collect 模式，**没有** `handle.stdout.on`（`src/index.ts:1671`、`test/subprocess-shim.mjs:133`）→ 前台只能在 `done` 之后按行切分内存里的 `stdout`，不能挂流监听。
2. 后台 `visible` 会混入 `[agy: tool step done]` 之类的进度标记（`:1979`）→ 空回答判定**不能看 `visible`**，只能看 `sawDelta` 与 `finalResponse`。
3. 后台续聊必须把串行门的释放绑到 `bg.done`，否则 gate 在返回 handle 时就放行（`:1589`）。
4. 用量字段是 `input_tokens` / `output_tokens`（`agy-steps.ts:158`），且 step 只有单轮增量；整场用量取 terminal `result.usage`。
5. `description` 放宽为可选后，`jobs.start` 的 label 非空校验（`:2337`）会炸 → 必须回退到 registry 里的 `record.label`。
6. `denied_actions` 实际形状是 `[{action, display_name}]`，流尾部还可能有非 JSON 文本行 → 解析要容错，不能假定每行都是 JSON。

实施顺序改为 **D → A → B → C**（A 的前台降级规则依赖 D 的 step 解析）。

## 1. 范围

四项，按顺序实施；每项独立可交付、可回滚。

### A. 诚实结算（P0）

问题：`result.status=SUCCESS` + `response=""`（或 `denied_actions` 非空）仍算成功，返回空气泡；用户与主模型都无从判断。

改法：

1. `AgyJsonReply`（`:683`）增补 `denied_actions?: unknown`、`usage?`、`num_turns?`、`duration_seconds?`。
2. 新增 `describeDenials(reply)`：把 `denied_actions` 归一成 `command`、`file_write` 之类的简短动作名列表（兼容字符串与 `{action|tool|name}` 对象），空数组返回 `undefined`。
3. 前台（`:1744`）：
   - `SUCCESS` 且 `response.trim()===''` → `stopReason:'error'`，文案分两种：有 denied → 明说「agy 请求了 N 个动作的权限（…），headless 无法弹窗，因此没有产出；开启 `skipPermissions` 或加白名单后重试」；无 denied → 「SUCCESS 但无文本，可能是非 TTY 丢输出；见 transcript」。
   - `SUCCESS` 且有文本但 denied 非空 → 仍 `completed`，正文末尾追加 `[agy denied N action(s): …]`，让主模型知道子代理被挡过。
4. 后台/面板（`:2051`）：`finalStatus==='SUCCESS'` 但 **`!sawDelta` 且 `finalResponse` 为空**（不看 `visible`，它含进度标记）→ `status:'failed'`，`detail` 用同一文案；denied 非空但仍有文本 → `completed`，把注记 append 进 `visible`（`readOutput`/唤醒通知可见）。
5. 同一结算逻辑只写一处：抽 `explainEmptyResult({denied, stderr, transcript})`，前台/后台共用。

验收：

- `test/fake-agy.mjs` 增 `denied`（SUCCESS + `response:''` + `denied_actions:['command']`）与 `empty-success`（SUCCESS + `response:''`，无 denied）两个 scenario。
- `test/run.mjs` 断言：foreground 两种都抛错且文案含关键字；`background:true` 的 `done()` 落在 `failed` 且 detail 非空（此前是 `completed` + 空）。
- 有文本 + denied 的情况返回 `completed`，正文含 `denied`。

### B. 工具描述精简（P1，提升主动调用）

问题：`:2262` 的描述约 2000 字符，把失败模式、mount id、环境注记全塞进模型上下文，劝退调用。

改法：

- 重写为 ≤ 800 字符，只留：它是什么（独立 agy/Gemini agent）、什么时候用（派活/并行/需要另一模型视角/长任务后台跑）、契约（self-contained prompt；返回 `task` 可续聊；`background:true` 会通知、别轮询）、`dirs` 一行警告。
- 环境注记（browser/大文件）本就在 prompt 尾部自动拼接（`:1460-1461`），从描述里删除。
- 「不是 skill」保留一句。
- `antigravity_followup` 描述压到 ≤ 400 字符。
- 必须保留 `test/run.mjs:520` 断言的「会唤醒/通知」措辞（`woken|wakes you|notify`）。

验收：`antigravity` 描述 < 800 字符；`npm test` 全绿（含 description 断言）。

### C. 统一入口：续聊 + 模型/思考等级（P1）

问题：续聊要换工具、不支持后台；换模型/等级要改配置重启。

改法：

1. `antigravity` 增加参数：`task?`（续聊键）、`model?`（slug 或 `auto`）、`effort?`（`low|medium|high|xhigh|max`）。
   - `task` 存在时走续聊：从 `~/.dsh/agy-conversations.json` 取 `conversationId` + `cwd`，`description` 变为可选（缺省用记录里的 label）。
   - `task` 不存在时 `description` 必填（运行时校验，schema 里保持可选以免破坏旧调用）。
2. `background: true` 对续聊同样生效：`provider.startResumeBackground(...)` 复用 `runBackgroundPlan`；串行门（`:1583`）的释放绑到 `bg.done`，不能在返回 handle 时放行。label 兜底顺序：`args.description` → `record.label` → `task` 键本身（`jobs.start` 要求非空，`:2337`）。
3. `model`/`effort` 逐调用覆盖配置：`spawnPlan` 增可选 `overrides?: {model?:string; effort?:string}`，`resolvedModel()` 接受 override；`effort` 不在 `EFFORT_LEVELS` 时按现有策略告警但透传。
4. `antigravity_followup` 保留为别名：内部转调同一 handler（`task` 必填），不删不降级。

验收：

- 新测试：`antigravity({task})` 续聊成功并沿用原 conversation；`antigravity({prompt, model:'claude-sonnet-4-6', effort:'max'})` 的 argv 含 `--model`/`--effort`；`background:true` + `task` 返回 jobId 且 `done()` 完成。
- 旧测试 `:451-465`（followup）与 schema 快照测试不变通过。

### D. 交付摘要：改动文件 + 用量（P1）

问题：跑完只有一段文本，主模型无法判断改了什么、花了多少。

改法：

1. 新增 `summarizeRun({steps, durationMs, usage, turns})`：
   - 文件：从 step 里的 `write_to_file` / `replace_file_content` / `multi_replace_file_content` / `sed_file` / `notebook_edit` 提取目标路径（参数值里第一个绝对路径或带扩展名的路径），去重保序。
   - 用量：`usage.input_tokens/output_tokens`（千位缩写）、`duration_seconds`、`num_turns`。
   - 形如：`[agy] 7 steps · 2m 14s · 12.3k in / 1.1k out · 3 files: a.ts, b.md, c.json`。
2. 前台：`runOnce` 在 `handle.done` 之后按行切分**内存里的 `stdout`**（不挂流监听——collect 模式下 `handle.stdout` 是 undefined），对 `event==='step_update'` 的行复用 `parseStepUpdate`（`agy-steps.ts:176`）收集步骤；结算时把摘要追加到最后一个 text block。
3. 后台/面板：复用已维护的 `steps` 数组，在 `done()` 里 `appendVisible(summary)`，让通知里能看到。
4. 摘要不影响 `stopReason`；解析失败静默跳过（不因摘要丢结果）。

验收：`tool-then-answer` scenario 的返回文本含步骤数/文件行；无工具步骤时不出现空摘要行；`test/agy-steps.mjs` 增加路径提取单测。

## 2. 非目标（本轮）

- 删除任何工具；改工具名；改 DSH provider 注册方式。
- `autoLoginWindow` 默认值、`dirs` 自动补全、配置 preset —— 下轮。
- 写 ACP 适配层。

## 3. 顺序与验证

A → B → D → C（C 风险最高，放最后；若 C 失败可独立回滚）。

每步后：`npm run typecheck` + `npm test`；C 完成后加跑 `npm run test:panel`；最后 `npm run build` 并确认 `lib/` 产物更新。

## 4. 风险

- **C 改签名**：`startWithDirs`/`followup`/`spawnPlan` 增加可选参数，保持向后兼容；`antigravity` schema 里 `description` 由 required 改可选属**放宽**，旧调用不受影响。
- **A 可能误伤**：某些 agy 版本「工具执行成功但无文本回复」是合法的（例如只改文件不回话）→ 因此只在 `response` 为空**且**无任何步骤文本时才判失败；有工具步骤则降级为 `completed` + 提示「无文字总结」。
- **D 误报文件**：只认已知写文件工具名，避免把 `view_file` 的读路径算成改动。

## 5. 实施记录（2026-10-29）

- 顺序实际为 **D → A → B → C**（采纳复审建议：A 的前台降级规则依赖 D 的步骤解析）。
- **A 的最终规则比 §4 更严**：`response` 为空一律判失败，**即使有工具步骤**——全工具无回复时主模型仍拿不到任何结论；`[agy] N steps …` 摘要会随错误一起返回，信息不丢。已由 `denied/foreground-is-not-success`、`empty-success/foreground-is-not-success`、`denied/background-settles-failed` 钉住。
- **D**：`[agy] 7 steps · 2m 14s · 12.3k in / 1.1k out · 2 files changed: a.ts, b.ts`；文件来源是 agy 的写入类工具步骤（不跑 git）。
- **B**：主工具描述 ≈640 字符，`antigravity_followup` ≈300 字符；环境注记仍由插件内部拼接。
- **C**：`antigravity({ task?, prompt, model?, effort?, background? })`，`description` 对新任务必填、续聊可选；`antigravity_followup` 保留为别名。
- 测试：`npm test` **135/135**；`npm run test:panel`（14 + 8 + 8）全绿；`npm run build` 通过。
- 未做（§2 非目标）：`dirs` 自动补全、`autoLoginWindow` 默认值、配置 preset、ACP 层。
- 遗留：本机 `npm run typecheck` 仍是坏的基线（peer 包解析到 `backups/…` 缺 `.d.ts`），与本次改动无关；CI 上应按 `tsconfig.typecheck.json` 复核。
