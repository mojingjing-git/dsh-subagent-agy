# 对抗式复审报告：批次 3+4 修复计划 (`scratch/fix-plan-batch34.md`)

> 复审时间：2026-11-02  
> 复审对象：`scratch/fix-plan-batch34.md`  
> 审查原则：挑错优先，严禁臆测，代码与测试全量核对  

---

## 总体裁定

**【有条件批准】（Conditional Approval，需修复 5 处硬伤方可执行）**

后端部分（批次 A）整体方向正确，但存在 **漏掉 `mergeStep` 导致字段丢弃** 的关键缺陷；  
前端部分（批次 B）设计思路可用，但存在 **引用不存在的符号、遗漏核心关联文件、手写 Markdown 范围过宽带来白屏风险、实时运行状态下折叠导致卡片失明** 等硬伤。必须在按本报告修正计划后，方可进入实施阶段。

---

## 一、逐条核对表

| 项 | 行号准确 | 现状属实 | 改法可行 | 必须修改的点 |
|---|---|---|---|---|
| **A1** 截断前提取 targetPath | **是**（`agy-steps.ts:56-72`, `280`, `283`, `305-318`） | **是** | **否（有严重漏洞）** | **必改 1**：`mergeStep`（L206-210）未保留 `targetPath`，二次 update 会被抹掉；<br>**必改 2**：`TARGET_PATH_KEYS` 与 `targetPath` 需上移消除隐式 TDZ 依赖。 |
| **A2** 后台 stdout 多字节截断 | **基本准确**（计划写 L2165-2177，实际 `spawnOnce` 位于 L2177，监听在 L2195-2207） | **是**（确为 `chunk.toString('utf8')`） | **是** | 需确保 `decoder` 局部作用于每次 `spawnOnce`，并在 `handle.stdout.on('end')` 时调 `decoder.end()`。且核实全工程仅此一处需改。 |
| **A3** 同步写约束注释 | **准确**（`index.ts:811`, `agy-panel.ts:360`, `agy-models.ts:135`, `agy-usage.ts:225`, `agy-usage-log.ts:171`） | **是** | **是** | 无逻辑改动，仅补注释，完全可行。 |
| **B1** 精简 Markdown 渲染器 | **否**（计划称放在 `outputValueText` 之后，但该符号属于 `src/index.ts:2320`，在 `client.js` 中根本不存在） | **否（符号张冠李戴）** | **高风险** | **必改 3**：修正插入位置说明；收缩 Markdown 范围至极简集（代码块+行内反引号+粗体），防止无构建纯 JS 状态机解析失败导致前端白屏。 |
| **B2** 折叠组件与工具组合并 | **部分准确**（`StepRow` 现已存在于 `client.js:420-501`，是重构而非新增） | **是** | **部分可行** | **必改 4**：若工具处于 `ACTIVE`（进行中）或 `ERROR`（失败）状态，**绝对不能默认折叠**，否则运行面板将无法感知实时执行进度。优先采用 HTML 原生 `<details>/<summary>` 简化实现。 |
| **B3** 历史视图接入 | **准确**（`client.js:563-593` 确实为 `steps.map`） | **是** | **是** | 需防范 `step.round` 为 undefined 的安全处理。 |
| **B4** 运行视图实时步骤 | **准确**（`agy-panel.ts:486-489`） | **是** | **部分可行** | **必改 5**：不能在 `steps.length > 0` 时硬编码隐藏 `<pre>` 文本流，必须保留原始流查看入口（折叠或 Tab）；处理实时 steps 缺失 `round`/`at`/`thinking` 字段的防御。 |
| **B5** 隐藏会话按钮 | **严重遗漏文件**（计划仅提修改 `agy-panel.ts`，遗漏了 `src/agy-conversations.ts`） | **否（缺少关键文件）** | **需补全范围** | **必改 6**：必须将 `src/agy-conversations.ts` 纳入修改范围，在 `ConversationItem` / `ListConversationsOptions` 接口增加 `hidden` 属性并修改内部过滤逻辑，并在 `agy-panel.ts` 路由入参解构 `body`。 |

---

## 二、必须修改的点（硬伤修复清单）

### 1. 【必改 1 · A1 缺陷】`mergeStep` 丢弃 `targetPath`
- **位置**：`src/agy-steps.ts:206-210`
- **问题**：在流式合并中，一个 step 会多次触发更新（如从 `ACTIVE` 到 `DONE`）。`mergeStep` 在构造新的 `tool` 时，字面量仅包含了：
  ```ts
  {
    name: incoming.tool.name.length > 0 ? incoming.tool.name : existing.tool.name,
    parameters: incoming.tool.parameters ?? existing.tool.parameters,
    error: incoming.tool.error ?? existing.tool.error,
  }
  ```
  **未传递 `targetPath` 字段**！当后续 update 到达时，`existing.tool.targetPath` 会被无情抹成 `undefined`，导致最终 `filesTouched` 依然取不到路径，BUG-16 无法被根治。
- **修正**：在 `mergeStep` 中补齐 `targetPath` 合并：
  ```ts
  targetPath: incoming.tool.targetPath ?? existing.tool.targetPath,
  ```

### 2. 【必改 2 · A1 架构隐患】消除 `targetPath` 与 `TARGET_PATH_KEYS` 隐式 TDZ 依赖
- **位置**：`src/agy-steps.ts` L56、L280-297
- **问题**：`normalizeStep`（L56）调用位于 L283 的 `targetPath`，后者读取 L280 的 `const TARGET_PATH_KEYS`。虽然目前顶层无执行代码，但跨越 220 多行的跨越式提升依赖属于脆性设计。一旦未来模块顶层增加常量初始化或测试环境求值，将直接因 TDZ 抛出 `ReferenceError`。
- **修正**：将 `TARGET_PATH_KEYS` 和 `targetPath` 物理剪切、粘贴到 `normalizeStep` 之前（紧随 L54 之后）。

### 3. 【必改 3 · B1 符号错误与规模失控】修正放置位置，降级手写 Markdown 范围
- **位置**：`src/client.js:348`
- **问题**：
  1. 计划中写「放在 `outputValueText` 之后、`STEP_LABEL` 之前」——实际 `outputValueText` 位于 `src/index.ts:2320`，在 `src/client.js` 中根本不存在！`src/client.js:348` 上方实际是 `TokensCard` 的结尾。
  2. `src/client.js` 是无任何构建、无转译的经典浏览器脚本。手写支持标题、代码块、有序列表、无序列表、引用、粗体、斜体、代码、链接的状态机极其繁杂（至少需 150+ 行高复杂度代码），没有任何单测保护，在真实 LLM 输出（未闭合标签、交叉标点、嵌套缩进）下极易抛出未捕获异常导致**面板整页白屏**。
- **修正**：
  1. 插入位置修正为：`TokensCard` 之后、`STEP_LABEL`（L349）之前。
  2. **大幅收缩 Markdown 复杂度**：仅实现最小实用子集：
     - **块级**：支持 ` ``` ` 代码块（等宽字体展示，背景色高亮）；其余段落直接按纯文本段落渲染（依赖 `whiteSpace: 'pre-wrap'` 保留天然换行和缩进）。
     - **行内**：仅支持单反引号 `` `code` `` 与粗体 `**bold**`。
     - 明确剔除：有序/无序列表状态机、引用块、多级标题、斜体、内联链接。

### 4. 【必改 4 · B2 体验盲区】`ACTIVE` 状态的工具严禁默认折叠
- **位置**：`src/client.js` 的 `ToolGroup` / `Disclosure`
- **问题**：计划规定 `defaultOpen: false for tools`。在实时运行（B4）中，正在执行的工具步骤状态为 `ACTIVE`。若默认折叠，正在运行的任务面板上用户只能看到一个折叠行，无法看到当前执行的命令或参数，造成「假死/黑盒」感。
- **修正**：折叠策略必须加入动态判断：
  - 若该组或该工具处于 `ACTIVE` 状态，**强制展开**（`defaultOpen = true`）。
  - 若该工具包含 `ERROR`，摘要行必须标红显示错误工具名称，且建议默认展开。
  - 推荐直接使用 HTML 原生 `<details>` 与 `<summary>` 标签（`h('details', { open: isOpen }, h('summary', ...), ...)`），无需 React `useState` 维护内部折叠态，简洁且零 Bug。

### 5. 【必改 5 · B4 文本流去留】不得在有 steps 时强制销毁原始文本流
- **位置**：`src/client.js` 运行视图
- **问题**：计划规定「`steps.length > 0` 时渲染步骤时间线，否则回退到 `<pre>`」。这会导致只要产生了一个 step，CLI 输出的全部原始非 step 内容（包括 stderr 警告、未匹配的协议行、进程崩溃诊断信息、CLI 退出前的额外日志）全部被隐藏且无任何途径查看。
- **修正**：不能做互斥的二选一替代。应以步骤时间线为主体，但在底部或通过一个「查看原始输出」折叠块（`<details>`）始终保留原始 `<pre>` 文本流，保障排错通道畅通。

### 6. 【必改 6 · B5 漏测文件】补齐 `src/agy-conversations.ts`
- **位置**：`src/agy-conversations.ts` 与 `src/agy-panel.ts`
- **问题**：计划称「后端改动仅限 `src/agy-panel.ts`」，但 `listConversations` 内部的 hidden 过滤发生在 `src/agy-conversations.ts:123`，且 `ConversationItem`、`ListConversationsOptions` 类型定义均在 `agy-conversations.ts`。漏改此文件将导致 TS 编译失败（缺少属性），且无法在前端展示「已隐藏」项。
- **修正**：修改目标加入 `src/agy-conversations.ts`：
  1. `ConversationItem` 增加 `hidden?: boolean`。
  2. `ListConversationsOptions` 增加 `includeHidden?: boolean`。
  3. `listConversations` 中当 `options.includeHidden === true` 时不跳过隐藏项，而是设置 `item.hidden = true`。
  4. `src/agy-panel.ts:408` 的 `/api-agy/conversations` 改为接收 `({ body })`，提取 `includeHidden` 并传给 `listConversations`。

---

## 三、建议但不强制（优化点）

1. **统一截断标记与重复保护**：
   `normalizeStep` 目前在二次归一化时，如果参数已经被替换为 `{ truncated: true, preview: ... }`，若再次序列化可能会重新超过 2048 字符并再次包装。建议加一句 `if (step.tool?.parameters && 'truncated' in step.tool.parameters) return step` 进行短路保护。
2. **时钟与时间渲染防御**：
   实时流 `/api-agy/run` 中的 step 不带 `at` 时间戳。`StepRow` 中的 `clockOf(step.at)` 必须保证在 `step.at` 为 `undefined` 时安全返回 `null`（当前实现通过 `new Date(at)` 在 `undefined` 时会生成当前时间或 Invalid Date，需改为 `if (!step.at) return null`）。
3. **`test/agy-steps.mjs` 中的已有幽灵断言修正**：
   L174 处的 `second[0].tool.preview` 实际应为 `second[0].tool.parameters.preview`，当前能通过仅仅是因为两边都是 `undefined`。可顺手修正该测试断言。

---

## 四、计划末尾 5 个裁定项回答

### 1. A1 的 TDZ/提升问题
- **明确结论**：**运行时暂不触发 TDZ，但属于危险的脆性实现，必须重构**。
- **理由**：`agy-steps.ts` 顶层在模块加载期仅声明常量和函数，没有任何顶层自执行代码调用 `normalizeStep`。所有对 `normalizeStep` 的调用都发生于事件监听或导出函数调用阶段，届时模块顶层的 `const TARGET_PATH_KEYS` 已经完成初始化求值。但让 L56 的函数跨越 220 行去读取位于 L280 的 `const` 常量，违反代码内聚原则，未来若有顶层静态求值将瞬间崩塌。必须移动至其上方。

### 2. B1 的手写 Markdown 规模
- **明确结论**：**不值得手写全量解析器，必须退化为最小实用集**。
- **理由**：在无构建系统的原生浏览器脚本中，手写覆盖标题、多级列表、引用块、链接和粗斜体的解析器至少需要 150-200 行状态机代码，边界繁杂（LLM 输出经常含有未闭合的反引号、星号或括号），在缺乏前端单元测试框架的环境下极易引发 TypeError 导致全屏白屏。降级为「代码块 + 行内反引号 + 粗体」仅需约 35-40 行正则分词，既能完全满足代码高亮与结论突出的诉求，又能将风险降低 80% 以上。

### 3. B4 的文本流去留
- **明确结论**：**绝对不可隐藏，必须共存**。
- **理由**：`stream-json` 模式下，底层进程的 stderr 溢出、非 JSON 警告、任务开始/退出诊断信息、以及未被归为 step 的原生标记（如 `[agy: ... step done]`）均只存在于文本流中。一旦单纯依赖 `steps`，用户将失去排错底牌。应以步骤为主视图，但在底部保留默认折叠的「原始输出」`<details>` 区块。

### 4. B5 的后端兼容性
- **明确结论**：**接口扩展完全兼容，但需补全受改动文件**。
- **理由**：`/api-agy/conversations` 默认仍执行过滤，保持入参为空或缺省时的向后兼容；前端当前也是通过 `post('/conversations', {})` 访问，不受影响。但计划遗漏了 `src/agy-conversations.ts`，后端改法需在该文件同步增加接口定义与过滤分支。

### 5. 更小的等效路径
- **明确结论**：**存在极优的极小路径，推荐采纳**。
- **路径定义**：
  1. 折叠采用原生 HTML `<details>/<summary>`，省去全部 `useState` 展开控制。
  2. Markdown 仅做「```代码块 + `code` + **bold**」，正文使用 CSS `white-space: pre-wrap; font-family: sans-serif` 处理自然换行。
  3. B4 先在当前 `<pre>` 上方增加一个简易的 Step 汇总行与计时器，步骤时间线作为展开卡片，而不是彻底颠覆现有视图。整体前端手写代码量可从 300 行压降到 100 行以内。

---

## 五、受影响测试清单（文件与行号）

若按现有未修正的计划改动，以下测试必然或极高概率变红：

1. **`test/panel-client.mjs:122-126`**
   - **断言**：`clientPaths` 必须在 host 的 `jsonRoute` 中全部存在。
   - **风险**：若 B5 在前端调用了非 `/prefs` 或非已有路由（例如错误地调用了新命名的 `/hide-conversation`），测试将在此处失败。
2. **`test/panel-client.mjs:131-133`**
   - **断言**：`assert.ok(source.includes('HistoryTimeline'))`、`assert.ok(source.includes('loadHistory(id)'))`。
   - **风险**：重构历史视图组件时，若组件被重命名（例如拆分为 `Timeline`）或刷新逻辑被重构，此断言将直接失败。
3. **`test/panel-routes.mjs:326-335`**
   - **断言**：`assert.equal(listed.json.items.length, 0)`（验证隐藏后列表为空）。
   - **风险**：若 B5 修改 `/api-agy/conversations` 时将默认行为改为了返回包含隐藏项，该测试在 L330 必定变红。
4. **`test/agy-steps.mjs`（潜在新测试失败）**
   - **断言**：若新增针对 `write_to_file` 多次更新的测试。
   - **风险**：由于现有计划中 `mergeStep` 遗漏了 `targetPath`，构造一个 `ACTIVE` 附带 parameters、随后 `DONE` 不带 parameters 的合并用例时，断言必定失败。

---

## 六、建议的拆分与实施顺序调整

原计划将高难度的前端 5 项堆叠在后半部分，且批次 B 第 9 步才做浏览器实测，反馈链路过长。建议调整为：

```
第一阶段：后端严密加固（零风险先落地）
  Step 1: A3（注释补充，固化同步写约束）
  Step 2: A2（StringDecoder 改造 + 后台 split-chunk 自动化测试）
  Step 3: A1（TARGET_PATH_KEYS 物理上移 + normalizeStep 捕获 + mergeStep 补齐 targetPath + 补全单元测试）
  验证：`npm test` 全绿

第二阶段：后端接口前置准备
  Step 4: B5 后端部分（修改 `agy-conversations.ts` 与 `agy-panel.ts`，为 `/conversations` 增加 `includeHidden`，保持默认过滤）
  验证：`node test/panel-routes.mjs` 绿

第三阶段：前端精简渐进改造（小步快跑）
  Step 5: B1 极简 Markdown 渲染器（仅代码块+反引号+粗体）
  Step 6: B2 折叠组件（原生 details + summary，ACTIVE 强制展开）+ 工具组合并
  Step 7: B3 接入 HistoryTimeline，在历史界面验证效果
  Step 8: B4 运行面板时间线（步骤与原始 pre 折叠共存）
  Step 9: B5 前端隐藏按钮交互
  验证：`node test/panel-client.mjs` + 浏览器现场检查
```
按此顺序，每一步都有明确的单测或语法保证，彻底隔绝白屏与功能回归风险。
