# `@dsh-subagent-antigravity` 修复计划（FIX-plan v2）

> 依据：[AUDIT-report.md](./AUDIT-report.md)（v2 · 实证复审版）。
> 只覆盖 v2 仍然成立的结论：**C1、I1–I11、S1–S38、T1–T32**，以及 v2 的两条新发现（`src/index.ts:100` 未锚定相对路径 → 并入 I6；`src/client.js:514` reset 死代码 → 并入 I2 顺带救活）。
> v1 已被实证推翻的结论（v1 C1 前台丢 conversation_id、v1 I8 Go 时间戳偏 8 小时）**不在本计划内**。
>
> **v2 修订记录（antigravity 对抗复审判定 REVISE，逐条核验后全部采纳）**：
> 1. **I2 游标语义纠错（致命）**：reset 置位时内部切片游标必须为 `0`（原稿误写 `run.text.length`——会使 `text.slice(cursor)` 发空串、客户端全文被清）；payload 的 `cursor` 字段保持 `run.text.length`。
> 2. **C1 单测适配**：`test/panel-routes.mjs` 的 `call()` mock 请求不带 `headers`，服务端校验落地前必须先给测试桩补合法 headers，否则现有路由用例全崩；并补 `Origin: null` → 403、畸形 Host/Origin → 403（fail-closed）。
> 3. **T2 换行符**：实测已提交 lib 全为 LF（`git ls-files --eol` = `i/lf w/lf`）、本机 tsc 5.9 产物即 LF、`autocrlf=true` 下 diff 经 clean 过滤归一——复审"CI 必红"不成立；仍加 `"newLine": "lf"` 作零成本确定性保险；不加全仓 `.gitattributes`（避免 renormalize 搅动，列为 Phase 4 可选）。
> 4. **T27 补 `pretest:panel`**：npm 的 pre 钩子按脚本名精确匹配，`pretest` 覆盖不到 `npm run test:panel`。
> 5. **I6 补根因锚点 `src/index.ts:1422`**（`header.cwd ?? ''` 是空串源头）。
> 6. **I7 锚点纠偏 + 方案内聚化**：事件摄入在 `src/index.ts:1922`、步骤状态在 `:1870`（`:2061` 只是返回值出口）；防复活逻辑封进 `mergeStepInto`（`incoming.index < steps[0].index` 直接丢弃），不再让调用方持水位线。
> 7. **T15 Windows 锁文件容错**：清理 lib 改为清空目录内容 + try/catch（EBUSY/EPERM 警告不中断）。

---

## 〇、总览

| Phase | 目标 | 条目 | 预估 |
|---|---|---|---|
| **0** | 先修测试与构建链路，让后续每一步的"测试通过"可信 | T27、T24、T11、T12、T2、T1、T15、T3、T26、T8 | 0.5–1 天 |
| **1** | P0：安全与核心可用性 | C1、I1、I2 | 1 天 |
| **2** | P1：正确性与资源上界 | I3、I4、I5、I7、I8、I9 | 1–1.5 天 |
| **3** | P2：平台兼容、泄漏、提示、发布链 | I6、I10、I11、T10、T13、T14 | 0.5–1 天 |
| **4** | P3：S 建议与 T 建议批量清理（择机） | S1–S38、T4–T9、T16–T23、T25、T28–T32 | 按需 |
| **发布** | pack + selftest + 真机装验 | patched.13（Phase 0–2 后）、patched.14（Phase 3 后） | 0.5 天 |

**依赖关系（为什么这样排序）**

- Phase 0 必须最先：T24（测试打的是 `lib/` 产物）+ T11（异步断言未 await，失败不计数）+ T12（过滤器 0 匹配静默通过）叠加的结果是——**在修好它们之前，任何修复的"绿"都不可信**。
- Phase 1 的 C1 / I1 / I2 相互独立，可并行。
- I7、I8、S1 都动 `src/agy-steps.ts` 的归一化路径，**必须同一次改动、同一批测试**，拆开做会互相踩。

---

## 一、统一工作流（每个修复项都走一遍）

1. 建分支：`fix/<编号>-<slug>`（如 `fix/C1-panel-csrf`）。
2. **先写失败测试**：把 AUDIT 报告的复现方法固化成断言，先跑出"红"。
3. 改 `src/`，最小改动，不顺手重构。
4. `npm run build`（Phase 0 完成后由 pretest 自动触发）。**`lib/` 随仓库提交——改了 src 忘了 build 等于没改**。
5. `npm run typecheck && npm test && npm run test:panel`。
6. 跑对应的运行时回归脚本（§七）。
7. 动了面板协议 → 同步 `src/client.js` 与 `test/panel-*.mjs`；动了错误文案 → 同步 README。
8. `CHANGELOG.md` 增条目。
9. commit：src + lib + test + docs 放**同一个提交**（lib 是提交产物，必须同步；也便于单点 revert）。
10. 对照 §八 DoD 核对后合并。

---

## 二、Phase 0 — 先让"验证"变可信

### T27（建议级，但必须最先做）pretest 钩子

- **步骤**：`package.json` scripts 加 `"pretest": "node scripts/build.mjs"` **和** `"pretest:panel": "node scripts/build.mjs"`。npm 的 pre 钩子按脚本名精确匹配——`pretest` 只在 `npm test` 时触发，**覆盖不到 `npm run test:panel`**（复审补充），必须成对声明。两行同时缓解 T1 / T2 / T24。
- **涉及环节**：package.json。
- **验证**：改一行 `src/` → 直接 `npm test` → 观察先出现 build 输出、测试再跑；`npm run test:panel` 同样先出 build 输出；连续跑两次第二次幂等。

### T24 测试对象 = 发布对象

- **方案选择**：a) 测试迁移到 import `src/`（要引入 tsx，动静大）；b) **推荐**——pretest 强制重建（T27）+ CI `git diff --exit-code -- lib/`（T2）闭环：只有 lib 与 src 同步时才允许合并/发布，此时测试打 `lib/` 就等于打发布物。
- **验证**：改 src 不提交 lib → CI 必须红。

### T11 异步断言未 await（摘要谎报通过）

- **步骤**：① 排查 `test/run.mjs`、`test/harness.mjs`、`test/panel-*.mjs` 中返回 Promise 的断言，全部 await；② harness 增加"发起但未 settle"的断言登记表，套件结尾 `assert.equal(pending.size, 0)`；③ 进程退出码由真实失败数决定。
- **验证（变异测试）**：临时把一个正确断言改成必失败 → 摘要必须报 1 failed 且退出码 1；还原后全绿。

### T12 过滤器 0 匹配静默通过

- **步骤**：test 入口解析 `--filter` 后匹配数为 0 → 打印 "no tests matched" 并 `process.exit(1)`。
- **验证**：`node test/run.mjs --filter does-not-exist` → 退出码 1。

### T2 CI 校验 lib 同步

- **步骤**：`.github/workflows/ci.yml` 在 test 步骤前加：
  ```yaml
  - run: node scripts/build.mjs
  - run: git diff --exit-code -- lib/
  ```
- **换行符（复审补充，实测后修正）**：`git ls-files --eol` 实测已提交 lib 全部 `i/lf w/lf`、本机 tsc 5.9 产物即 LF，且 `core.autocrlf=true` 下 `git diff` 对工作区文件先经 clean 过滤——**换行符在当前链路不会造成 CI 必红**（复审的"必红"判断不成立）。仍采纳其保险建议：`tsconfig.json` 的 `compilerOptions` 显式加 `"newLine": "lf"` 把平台变量钉死。**不**加全仓 `.gitattributes`（`* text=auto` 会触发全库 renormalize 搅动）；如将来需要，列为 Phase 4 可选。
- **涉及环节**：ci.yml、`scripts/build.mjs`（确保在 CI 环境可重复构建）、`tsconfig.json`（newLine）。
- **验证**：本地跑同样两条命令；故意只提交 src 不提交 lib → push 后 CI 红；本机 build 两次、`git diff -- lib/` 恒为空。

### T1 rebuild.ps1 只监视 index.ts

- **步骤**：`rebuild.ps1:47-54` 的"需要重建吗"判定改为比较 `src/` 下**任一**源文件与 `lib/` 产物的新旧；或最简单——**无条件重建**（构建本身秒级，判定逻辑直接删）。
- **验证**：只改 `src/agy-panel.ts` → 跑 rebuild.ps1 → `lib/agy-panel.js` mtime 更新。

### T15 build 不清理 lib/

- **步骤**：`scripts/build.mjs` 产物生成前清理 `lib/`：删除**目录内容**（遍历子项 rmSync）而非整目录删除，整体包 try/catch——Windows 下文件被占用会抛 EBUSY/EPERM（复审补充），此时打印警告继续构建（tsc 会覆盖同名产物；残留风险仅限已不再生成的孤儿文件）。
- **验证**：临时删除 `src/agy-summaries.ts` → build → `lib/agy-summaries.js` 消失且构建报错（缺失模块应显式失败）；恢复后正常；占用 lib 下某文件时 build 不中断。

### T3 selftest 把旧版 agy 判为失败

- **步骤**：`scripts/selftest.mjs:86-92` 区分"必需 flag 缺失"（fail）与"可选 flag 缺失"（skip 并列出清单）——插件本身就能自适应缺 flag（探针降级），selftest 不该更严。
- **验证**：伪造一份缺 `--sandbox` 的 `agy --help` 输出喂给 selftest → 报 skip；缺 `--output-format` 这类必需 flag 仍 fail。

### T26 engines 声明

- **步骤**：`package.json` 加 `"engines": { "node": ">=22.5.0" }`（`node:sqlite` 自 22.5 内置）；README 安装节注明版本下限与原因。
- **验证**：低版本 Node 上 `npm install --engine-strict` 报错；README 有说明。

### T8 CI 覆盖面板模块

- **步骤**：ci.yml 的 test 步骤后加 `npm run test:panel`。
- **验证**：临时在 `agy-panel.ts` 引入一个路由回归 → CI 红；还原后绿。

---

## 三、Phase 1 — P0

### C1 面板 8 条路由无跨站防护（插件侧与宿主侧都空）

**修复步骤**（全部在 `src/agy-panel.ts`）：

1. `readJsonBody`（:250-263）入口校验 `Content-Type`：不是 `application/json`（允许 `+json` 后缀）→ **415**。一步挡掉 `text/plain` / `form-urlencoded` 两类浏览器 simple request。
2. `jsonRoute`（:222-248）加两层校验（**fail-closed**：头缺失/畸形按拒绝处理，URL 解析包 try/catch）：
   - **Host 校验（防 DNS rebinding）**：`req.headers.host` 的 hostname 必须属于 `{ 127.0.0.1, localhost, [::1], ::1 }`，否则 **403**。端口不限定（宿主端口可配置，从 Host 头动态取，勿硬编码 6193）。
   - **Origin 校验（防跨站 fetch / 表单）**：请求带 `Origin` 时，其 hostname 必须同为环回名、且端口与 `req.headers.host` 一致（同源），否则 **403**；`Origin: null`（沙箱 iframe）显式 **403**（复审补充）。无 Origin（curl、本机进程直呼）放行——本机进程本就可信，浏览器跨站请求必带 Origin。GET 无需单独防护：jsonRoute 已对一切非 POST 返回 405（复审确认）。
3. **单测桩适配（复审补充，必须先做）**：`test/panel-routes.mjs` 的 `call()` 构造的 mock 请求**不带任何 `headers`**（`req.headers === undefined`）——校验一落地，现有全部 POST 用例立即崩（TypeError→500）或被 415/403 拦截。先给 `call()` 注入合法测试头（`host: '127.0.0.1:<port>'`、`'content-type': 'application/json'`），再落服务端校验，最后补 5 个反例用例。
4. 修正文件头注释 `:5-8`：如实写明实际防护（415 + Host/Origin 403）与残余风险（已授权本机进程仍可直呼）。
5. （可选加固，不阻塞本条）新增 `panelSandbox` 配置：面板触发的运行可追加 `--sandbox`，默认 false 并在 README 说明取舍。

**涉及环节**：`src/agy-panel.ts`、`test/panel-routes.mjs`（新增用例）、README 配置表（若加开关）、CHANGELOG。

**验证方法**：

- 路由级（test/panel-routes.mjs 新增 5 例）：`text/plain` POST → 415；`Origin: http://evil.com` → 403；`Host: evil.com`（模拟 rebinding）→ 403；`Origin: http://127.0.0.1:<同端口>` → 200；无 Origin + 合法 JSON → 200。
- 浏览器实测：本地 `evil.html` 里 `fetch('http://127.0.0.1:<port>/api-agy/usage', { method:'POST', mode:'no-cors', headers:{'content-type':'text/plain'}, body:'…' })` → 网络面板确认 415；带恶意 Origin 的 fetch → 403。
- 回归保障：现有 panel 60 checks 必须全绿——前提是 `call()` 已按第 3 步补 headers（复审确认：测试桩原本无 headers，不改桩则全崩）；生产路径 `src/client.js:45-47` 本来就发 `application/json` + 同源 Host/Origin，不受影响。

### I1 conversationId 未校验就拼进文件路径

**修复步骤**：

1. `src/agy-conversations.ts` 新增并导出 `isSafeConversationId()`，正则对齐 `src/agy-history.ts:424` 已有的 `/^[0-9a-fA-F-]{8,64}$/`。
2. `modelFromDb`（:70-71 拼 `${id}.db`）与 `titleFromAnnotations`（:85-87 拼 `${id}.pbtxt`）拼路径前校验，非法直接返回 `null`（**零触盘**）。
3. `listConversations`（:113 的 `existsSync` 前）同样校验，非法 record 跳过——防御 registry 被污染后的连锁反应。
4. 面板 history 路由已有白名单，保持不动（作为第二道防线）。

**涉及环节**：`src/agy-conversations.ts`、`test/panel-routes.mjs`、（若有）conversations 专属单测。

**验证方法**：扩展 V6 复现脚本（见 §七）：`modelFromDb(dir, '..\\..\\..\\evil')` → null 且断言未发生任何文件系统读（注入计数或代理 fs）；路由层传 `..%2f..%2f` → 会话被跳过 / 返回 invalid id；**合法 UUID 全链路不受影响**（对真实 114 个 `.db` 目录跑 listConversations，结果与修复前一致）。

### I2 面板输出 400 KB 永久冻结

**修复步骤**：

1. `PanelRun` 增加 `resetPending: boolean`。
2. `drain()` 截断发生处（:179）置 `run.resetPending = true`。
3. `read()`（:156-162）：`reset` 判定追加 `|| run.resetPending`；**置位时内部切片游标必须为 `0`**（保持现有 `cursor = reset ? 0 : since` 语义）——路由层 `text: run.text.slice(cursor)` 才会发全量文本；payload 的 `cursor` 字段由路由独立取 `run.text.length`，无需改动（v1 稿误写"置位时 cursor = run.text.length"，会使 `slice` 发出空串、客户端全文被清——复审纠正）；置位消费后清掉 resetPending。
4. 客户端**无需改动**：`src/client.js:514` 的 `payload.reset ? payload.text : prev.text + payload.text` 就是为 reset 设计的，只是服务端从未发过——本修复同时救活这段死代码。
5. 协议兼容性：`reset` 是既有协议字段，老面板客户端已实现消费逻辑 → 服务端补发属向后兼容。

**涉及环节**：`src/agy-panel.ts`、`test/panel-stream.mjs`（长输出用例）、CHANGELOG。

**验证方法**：

- 复用 V1 复现脚本（转正进 §七回归套件）：注入 500,000 字符 → 第一次轮询必须 `reset=true` 且 text 长度 409600、cursor=409600；再注入 100,000 → 下一次轮询 `reset=false` 且 text 长度 100,000——**增量送达，冻结消失**。
- 端到端：panel-stream.mjs 断言"客户端拼接后的全文 === 注入的全文"。
- 边界：恰好 409,600 字符（不触发截断）→ 全程 reset=false；一次注入 1 MB（连续两次截断）→ 客户端最终内容 = 最后 400 KB 且中途经历过一次整体替换。

---

## 四、Phase 2 — P1

### I3 超时/取消的运行不写 transcript

- **步骤**：`src/index.ts` :1691（cancelled）与 :1692-1704（timedOut）两处早退 return 之前调用 `writeTranscript`：内容用当前已收集的 `stdout` + header，header 里标 `status: 'timeout' | 'cancelled'`；调用包 try/catch（证据写盘失败不得掩盖原始错误）；transcriptPath 赋值后进返回值。
- **涉及环节**：`src/index.ts`、`test/run.mjs`（超时/取消用例补 transcript 断言）。
- **验证**：① fake-agy 挂死场景：超时后 `~/.dsh/agy-transcripts/` 出现本次 run 的 `.ndjson`，header 含 `status:"timeout"`；② 取消场景同理 `status:"cancelled"`；③ **真实 agy（本机未登录）跑 e2e**：认证超时天然产生一次"超时"——同时验证 transcript 落盘与 I11 的新文案。

### I4 transcript 索引非原子、无并发保护

- **步骤**：抽 `writeJsonAtomic(file, data)`（写 `${file}.${pid}.tmp` → `renameSync`）；`writeTranscript` 的 `index.json` 直接覆盖写（:808）改用它；并发串行化用模块级 promise 队列（模式照抄同文件 registry 的 :592 / :612）。
- **涉及环节**：`src/index.ts`、test/run.mjs 并发用例。
- **验证**：单测并发 5 次写索引 → 终态 JSON 可解析且 5 条俱全；注入 rename 抛错 → 旧索引未损坏。

### I5 前后台 stream-json 判定不一致

- **步骤**：新增 `resolveStreamMode(jsonMode, support): 'stream-json' | 'json'`，规则取前台的严格版（`support.streamJson === true`）；后台 :1523（`jsonMode && (support.streamJson || !support.probed)`）与前台 :1634 都改为调用它。后台本就有裸 json 解析回退（:1952），探针失败时前后台行为从此一致。
- **涉及环节**：`src/index.ts`、test/run.mjs。
- **验证**：run.mjs 全量回归 + 新用例：`support = { probed: true, streamJson: false }` → 前后台 spawn 参数都不含 `stream-json`；`streamJson: true` → 都含。

### I7 步骤表无上限裁剪

- **步骤**：`src/agy-steps.ts` `mergeStepInto`（:200-206）返回前做窗口收缩：超过 `MAX_STEPS` 丢最老。**必须同时处理一个坑**：steps 按 `index` upsert（:201），丢掉的最老步骤若再收到同 index 事件会被"复活"，数组在窗口边缘来回抖动。**方案（复审纠偏后内聚化）**：把防复活逻辑封在 `mergeStepInto` 内部——`incoming.index < steps[0].index`（已丢出窗口）时直接原样返回，**不再需要调用方持水位线**。锚点纠偏（复审）：事件摄入点在 `src/index.ts:1922`（consumeLine 的 step_update 合并）、步骤状态声明在 `:1870`，`:2061` 只是返回值出口（snapshotSteps 调用处），不在那里放状态。`snapshotSteps`（:215-218）的窗口裁剪保留作双保险。
- **涉及环节**：`src/agy-steps.ts`、test/agy-steps.mjs。
- **验证**：V2 脚本回归：合并 2000 步 → 数组长度 ≤ 200；驻留内存从 ≈1.35 MB 降一个量级；水位线以下 index 的事件被忽略（断言无抖动）；panel-stream 用例确认面板渲染最近 200 步正常。

### I8 每 250 ms 重复归一化（含 S1 truncate 幂等）

- **步骤**：① `snapshotSteps`（:217）去掉 `.map(normalizeStep)`——归一化只在 merge 入口发生一次；② 同文件 `truncate`（:44-47）加幂等守卫：`const TRUNCATED = /…\(\+\d+ chars\)$/`，已带截断标记则原样返回（S1 一并修复）。
- **涉及环节**：`src/agy-steps.ts`、test/agy-steps.mjs。
- **验证**：V3 脚本回归：同一 step 连拍三次，text 与 tool.preview **逐字节不变**；单测断言 `truncate(truncate(x)) === truncate(x)`；计时对比 200 步 × 250 ms 轮询下的耗时。

### I9 固定名临时文件并发覆盖

- **步骤**：`src/agy-usage.ts:210` 与 `src/agy-panel.ts:283-285` 的 `${path}.tmp` 改为 `${path}.${process.pid}.tmp`，失败路径 unlink 清理——写法对齐仓库内已有的 `src/agy-models.ts:137`。
- **涉及环节**：两个源文件 + 各自测试。
- **验证**：单测两个并发 writer → 双双成功互不覆盖；注入 rename 抛错 → 无 `.tmp` 残留。

---

## 五、Phase 3 — P2

### I6 `resolveChildCwd` 的 `?? ''` 与未锚定相对路径（含 `src/index.ts:100` 新发现）

- **步骤**：`src/index.ts:97-101`：
  - `base` 为空串时显式回退：`parentCwd`（须绝对路径）否则 `process.cwd()`——消除 POSIX 上 `cwd: ""` 的 ENOENT；
  - `base` 非空且非绝对：`join(...)` 后 `resolve()` 锚定到 parentCwd，杜绝 `join('', base)` 产生相对路径（:100 同样处理）；
  - **根因锚点（复审补充）**：空串源头在 `src/index.ts:1422` 的 `header.cwd ?? ''`——移除 `?? ''` 保留 `undefined`，让回退统一走 resolveChildCwd；并验证 followup / wake 链路的 cwd 行为不变。
- **涉及环节**：`src/index.ts`（:97-101 与 :1422）、test/run.mjs 的 cwd 用例。
- **验证**：单测矩阵——`cwd: ''` / `cwd: 'sub'` × parentCwd 绝对 / 缺省 / 空串，Windows 真跑 + `path.win32` / `path.posix` 双平台断言；fake-agy 记录实际工作目录断言正确。

### I10 history 副本失败泄漏临时目录

- **步骤**：`src/agy-history.ts:353-370` 副本分支包 try/finally，失败路径 `rmSync(tmpDir, { recursive: true, force: true })`。
- **验证**：单测注入 `copyFileSync` 抛错 → 临时目录不存在；成功路径现有 history 测试回归不变。

### I11 认证提示无效

- **步骤**：重写 `src/index.ts:821-824` `authHintFor`：删掉"设置 `ANTIGRAVITY_API_KEY`"（宿主 `scrubbedParentEnv()` 按 `/KEY|PASSWORD|SECRET|TOKEN/i` 清洗，且真实 agy 无任何 API key 开关）与"agy → login"（无此子命令）；改为："agy 未完成认证。运行任意 agy 命令会弹出浏览器 OAuth 登录（或访问 stderr 中的授权 URL），完成登录后重试。"同步 README 常见问题节。
- **涉及环节**：`src/index.ts`、README.md / README.zh.md、test/run.mjs 文案断言。
- **验证**：真实未登录 agy 跑一次 → 工具返回的错误文案含新提示、不含 API key 字样；run.mjs 鉴权用例更新后全绿。

### T10 `npm run pack` 跑不起来

- **步骤**：`scripts/pack.mjs:21-25` 给参数默认值（outDir 默认 `dist/`、版本号取 package.json），npm script 传参补全。
- **验证**：`npm run pack` 直接产出 tgz + sha256；产物被 `npm run selftest` 接受。

### T13 文档漂移（随发布一起做）

- **步骤**：README.md:16 / README.zh.md:14 版本号；README.md:42 / README.zh.md:40 安装文件名指向真实存在的 tgz；README.md:238 与 CHANGELOG.md:21 的断言数改为发布时实测值；CHANGELOG 补 patched.13 / patched.14 条目（含"面板已是 8 条路由"）。
- **验证**：`grep -n "patched\.9\|0\.2\.0\.tgz\|39 assertions" README*.md CHANGELOG.md` 零命中；README 引用的文件名 `Test-Path` 为真。

### T14 发布类型被降级为 `Config: any`

- **步骤**：先解包 patched.12 tgz 确认 `lib/index.d.ts` 现状；若是 peers.d.ts 空洞兜底所致，构建时生成真实声明（`tsc --emitDeclarationOnly` + CI 安装真实 peer）或在包内附完整 `.d.ts`。
- **验证**：解包新 tgz → `lib/index.d.ts` 的 Config 含具体字段（skipPermissions / sandbox / …）而非 `any`；示例工程 `import type { Config }` 后访问字段 tsc 通过。

（T3 / T8 / T15 / T26 已在 Phase 0 完成，不在此重复。）

---

## 六、Phase 4 — P3 批量清单（按性价比排序，择机做）

| 项 | 一句话修复 | 验证 |
|---|---|---|
| **S37** | `agy-conversations.ts:76` 改只读文件头：`openSync` + `readSync(fd, buf, 0, 1<<20, 0)` + `closeSync`，超 1 MB 不再全量读 | V4 脚本：冷扫 114 库的耗时与 rss 显著下降；对真实库 diff 修复前后模型名识别结果一致 |
| **S19** | `agy-panel.ts:250-263` 超限 **413**、JSON 非法 **400**（替代 500） | panel-routes 用例 |
| **S9** | `agy-models.ts:115` `fetchedAt` 加 `Number.isFinite`（NaN 放行 → 缓存永不过期） | 单测 NaN → 判过期 |
| **S16** | `agy-conversations.ts:59` MODEL_CACHE 加 LRU 上限 | 单测超限淘汰 |
| **S20** | summaries 加 30–60 s TTL 缓存（面板 20 s 轮询每次重读盘） | panel-routes 计时断言 |
| **S28/S29** | transcript 保留期 / 清理命令；可选密钥掩码 | 单测 + 手工 |
| **S34** | `src/client.js:474` 的 setTimeout 保存引用并在 cleanup 清除 | panel-client 用例 |
| **S35** | package.json `files` 加 `src`（可审计）；`.gitignore` 加 `*.tgz`，发布产物挪 GitHub Release | 解包 tgz 含 src；`git status` 不再出现 tgz |
| S2–S8、S10–S18、S21–S24、S26–S27、S30–S33、S36、S38 | 逐条小改：正则收紧（S7/S13/S14/S15）、死代码删除（S3/S4）、`STATE_RANK ?? 0` 未知态（S2）、原子写补齐（S10/S30）、SQL 层分页（S11/S12）、文案（S31）、传 logger（S32）、createdAt 语义（S33）、CHANGELOG 8 条路由（S36）、readString/readBool 收口（S38） | 各自单测 |
| T4 / T5 / T6 / T7 / T9 / T16–T23 / T25 / T28–T32 | 测试与脚本层小改：白名单统一（T4）、POSIX 发布（T5）、mac 矩阵（T6）、spill 重复写（T7）、合并 test 入口（T9）、定时器泄漏（T16）、scratch 原子创建（T17）、去硬编码（T18）、孤儿文件（T19）、零引用 fixtures（T20）、cache-buster（T21）、重复计数（T22）、fake-agy 拒绝未知旗标（T23）、SHA 全文件覆盖（T25）、注释 six→eight（T28）、tar 边界（T29）、Resolve-Node 版本校验（T30）、断言口径（T31）、固定 150 ms 改事件驱动（T32） | 套件自身回归 |

> S1 已并入 I8（Phase 2）；S37 / S38 的定性修正说明见 AUDIT 报告第四章。

---

## 七、验证矩阵（总）

| 层 | 手段 | 主要覆盖 |
|---|---|---|
| 单元 | `npm test`（test/run.mjs 93 例 + agy-steps / models / history / summaries） | I3 / I4 / I5 / I6 / I9 / I11、协议、超时、取消、follow-up |
| 面板路由 | `npm run test:panel`（60 checks）+ 新增 415 / 403 / 413 / 400 用例 | C1 / I1 / S19 |
| 流式 | `test/panel-stream.mjs` 长输出用例 | I2 / I7 / I8 |
| **运行时回归（新增 `test/regression-runtime.mjs`）** | 把 AUDIT 第七章 V1–V6 的假 ctx / req / res 驱动法固化为可重复断言，随套件跑 | I2（V1 冻结）、I7（V2 上限）、I8（V3 归一化）、S37（V4 整库读）、I1（V6 穿越） |
| 端到端 | `npm run test:e2e` + `test/history-real.mjs`（真实 agy；本机未登录 → 认证失败链路） | I3 / I11 的真实路径 |
| 发布链 | `npm run pack` → `selftest` → 解包检查（d.ts / 清单 / SHA） | T10 / T13 / T14 / T25 |
| CI | build + `git diff --exit-code -- lib/` + test + test:panel | T2 / T8 / T24 |
| 手工验收 | 真 DSH 装 tgz：开面板、跑长任务（>400 KB 输出）、跑超时任务、检查 transcript 目录 | C1 / I2 / I3 真机确认 |

---

## 八、每个修复项的 DoD

- [ ] 失败测试先行（先红后绿）
- [ ] `npm run typecheck`、`npm test`、`npm run test:panel` 全绿
- [ ] 对应运行时回归脚本（§七）通过
- [ ] 动了协议 → `client.js` 同步；动了文案 → README 同步
- [ ] CHANGELOG 条目
- [ ] src + lib + test + docs 同一 commit

## 九、里程碑、提交与回滚

- **patched.13** = Phase 0 + 1 + 2 完成（P0 / P1 清零）；**patched.14** = Phase 3 完成；Phase 4 择机并入任一版本。
- 提交粒度：每个修复项一个 commit（便于单点 revert）；合并顺序 Phase 0 → 1 → 2 → 3。
- 回滚：单 commit revert；已发布 tgz 保留旧版供降级（S35 落地后从 GitHub Release 取）。
- **主要风险**：
  1. **C1 的 Host/Origin 白名单**：宿主端口可配置 → 端口从 `req.headers.host` 动态取，勿硬编码 6193；宿主当前禁止非环回绑定，若未来放开需重审本条。
  2. **I2 协议行为变化**：老 client 已支持 reset 字段，风险低；仍需 panel-stream 全量回归。
  3. **I5 判定统一**：后台从宽松转严格，必须以 run.mjs 全量回归兜底。
  4. **I7 窗口语义**：丢最老 + 水位线必须一起做，否则 upsert 复活会造成抖动（见步骤中的坑）。
  5. **忘记重建 lib**：pretest + CI diff 双保险落地前，每次改 src 后手工 build 是硬纪律。

## 十、全局完成定义

Phase 0–3 全部条目 DoD 勾销；CI 全绿且因 T11 / T12 修复而"绿"可信；`test/regression-runtime.mjs` 转正并通过；patched.13 通过 selftest + 真机装验；T13 的 grep 零漂移。
