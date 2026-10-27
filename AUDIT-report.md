# `@dsh-external/dsh-subagent-antigravity` 全面审核报告（v2 · 经实证复审）

- 审核对象：`C:\Users\wrz20\Documents\deepseek-harness\default-workspace\dsh-subagent-agy`（版本 `0.2.0-patched.12`，上游基线 `ZEM17/dsh-subagent-agy@0.2.0`）
- 审核日期：2026-10-28（v1 同日）｜**v2 = 实证复审后修订**
- 审核范围：全量通读 `src/index.ts`（2619 行）、`src/client.js`（773 行）、`src/agy-panel.ts`（439 行）、`src/agy-history.ts`（480 行）、`src/agy-conversations.ts`（152 行）、`src/agy-usage.ts`（258 行）、`src/agy-models.ts`（140 行）、`src/agy-steps.ts`（218 行）、`src/agy-summaries.ts`（126 行）、`src/peers.d.ts`（40 行）；执行 `npm test`（93/93 通过）、`npm run test:panel`（60 checks 通过）
- **复审方式**：用**本机真实 agy 二进制**（v1.4.8）、**真实会话数据**（`~/.gemini/antigravity-cli/`，114 个 `.db` / 56.8 MB）、**宿主 DSH webserver 源码**（解包 asar）以及一份自写的运行时复现脚本，对 v1 每条结论做**可执行验证**；另由一个独立 agent 逐条做**对抗性证伪**（21 条清单），结论交叉比对。
- 结论概览（v2）：**Critical 1 · Important 23 · Suggestion 58**

> 严重度定义
> **Critical** — 可导致数据损坏、越权或核心功能静默失效，且在默认配置下可达
> **Important** — 真实缺陷或安全弱化，在常见场景下造成错误行为、证据丢失、攻击面扩大或资源失控
> **Suggestion** — 一致性、可维护性、性能或文档层面的改进

---

## 〇、复审结论速查（v1 → v2 的全部变化）

v1 是纯静态审查的结论；v2 用**本机真实 agy 二进制 + 真实会话数据库 + 宿主 webserver 源码**做了实证复审，并引入一个**独立的对抗式证伪复核**。**3 条被推翻、2 条被降级、1 条被升级。**

| v1 编号 | v1 结论 | v2 判定 | 依据 |
|---|---|---|---|
| C1 | 前台 stream-json 解析可能静默丢失 `conversation_id`，导致 follow-up 失效 | ❌ **撤回** | 真实 agy v1.4.8 成功运行的 stream-json 输出里，`init` **与** `result` 事件**都**带 `conversation_id`；插件取内层 `result` 是正确的 |
| I1 | 面板路由无鉴权 / 无 Origin / 不校验 Content-Type | ⬆️ **升级为 Critical（现 C1）** | 插件侧与**宿主侧**（`dsh-host-webserver` 只按路径匹配）**两端都空**；且 agy 默认 `--dangerously-skip-permissions` 且不加 `--sandbox` |
| I2 | `conversationId` 未校验就拼进文件路径 | ✅ **维持 Important（现 I1）**，补充可达性 | 需先污染 registry 才能利用；目标名还须以 `.db`/`.pbtxt` 结尾才落地。`agy-conversations.ts` 确实缺 `agy-history.ts:424` 已有的白名单 |
| I3 | 面板输出在 400 KB 处永久冻结 | ✅ **维持（现 I2），已运行时复现** | 真实路由复现：截断后 text 长度 409600→0，`reset` 恒为 false，新输出永远送不到客户端 |
| I4 | 超时 / 取消不写 transcript | ✅ **维持（现 I3）** | `src/index.ts:1691-1704` 的两个 return 早于 `:1709` 的 `writeTranscript` |
| I5 | transcript 索引非原子、无并发保护 | ✅ **维持（现 I4）** | `:808` 直接覆盖写；对比同文件 registry 用了 tmp/rename + 串行队列（`:592`、`:612`） |
| I6 | 前后台对 stream-json 的判定不一致 | ✅ **维持（现 I5）** | `:1523` `support.streamJson \|\| !support.probed` vs `:1634` `=== true`；"未知 flag → text 重试"只在前台（`:1676-1690`） |
| I7 | `resolveChildCwd` 的 `?? ''` 使 nullish 合并失效 | ✅ **维持（现 I6）**，并新增一条 | Windows 上退化为 `process.cwd()`，**POSIX 上 `cwd:""` 是 ENOENT → 插件不可用**；另 `src/index.ts:100` 的 `join(parentCwd ?? process.cwd(), base)` 在 `parentCwd === ""` 时产生**未锚定相对路径** |
| I8 | Go 时间戳解析过窄、无时区 → 时间全丢 / 偏 8 小时 | ❌ **撤回** | 真实时间戳是 `"2026-10-22 10:52:42.098176+00:00"`，插件 `parseTime` **解析完全正确**（毫秒值 1792666362098），**自带 +00:00 不存在偏 8 小时**；仅 3/112 条 Go 零时间 → null（本就应过滤） |
| I9 | 步骤数组无上限 | ✅ **维持（现 I7），已运行时复现** | 合并 2000 步 → `steps.length = 2000`（`MAX_STEPS=200` 只裁 `snapshotSteps` 的返回值），常驻 ≈1.35 MB / 53.6 ms |
| I10 | 每 250 ms 重复归一化 | ✅ **维持（现 I8），已运行时复现** | 同一 step 连拍三次，尾部标记 `(+904 chars)` → `(+13 chars)` → `(+12 chars)`；每次快照都在**改写**已截断文本 |
| I11 | 为找模型名把整个会话 `.db` 读进内存 | ⬇️ **降级为 Suggestion（现 S37）**，数字修正 | 实测：单文件最大 3.1 MB → `modelFromDb` **2.8 ms**；**冷缓存扫完 114 个 .db = 600 ms、rss +53 MB**（二次 12 ms）。v1 写的"首屏卡死数秒、峰值 2× 文件"**夸大了** |
| I12 | 固定名临时文件并发覆盖 | ✅ **维持（现 I9）** | `agy-usage.ts:207-217`、`agy-panel.ts:281-286` 用 `${path}.tmp`；同仓库 `agy-models.ts:137` 已用 `${file}.${pid}.tmp` |
| I13 | `as` 强转"绕过 TS 检查"，7 处 | ⬇️ **降级为 Suggestion（现 S38）**，定性修正 | `body as {x?: unknown} \| null` + 每处紧跟 `typeof`/可选链，是**标准安全收窄**；且是 **6 处** handler，不是 7 处（第 7 处在 `readPrefs:272`） |
| I14 | history 副本失败时临时目录泄漏 | ✅ **维持（现 I10）** | `agy-history.ts:353-370` 的 cleanup 只在成功路径注册 |
| I15 | 认证提示无效 | ✅ **维持（现 I11）并加强** | ① `agy --help` 中**没有任何 API key 开关**（官方只有 OAuth 网页登录）；② `ANTIGRAVITY_API_KEY` 会被宿主 `scrubbedParentEnv()` 按 `/KEY\|PASSWORD\|SECRET\|TOKEN/i` 清洗掉；③ 真实 agy **没有 `login` 子命令**，提示里的 "agy → login" 指向不存在的命令 |
| T1 / T2 / T10 / T11 / T12 / T24 | 构建与测试链路 6 条 Important | ✅ **全部维持** | 独立证伪复核逐条 CONFIRMED |

**v1 未列出的新发现（3 条）**

> 1. `src/index.ts:100` `join(parentCwd ?? process.cwd(), base)` 在 `parentCwd === ""` 时产生**未锚定的相对路径**（`join("", "x") === "x"`），与 v1 的 I7 同源但路径更糟。
> 2. `src/client.js:514` 的 `payload.reset ? payload.text : prev.text + payload.text`——由于服务端 `reset` 因 v1 的 I3 永不成立，**客户端的 reset 分支是死代码**，作者为该 bug 写的恢复逻辑完全没生效。
> 3. 宿主 `dsh-host-webserver` 的 `Config` **拒绝绑定通配地址**（注释："binding every interface would expose remote code execution to the network"），默认只绑 `127.0.0.1` —— 这是 C1 的重要边界条件。

## 一、总体评价

这个插件的工程质量**明显高于一般社区插件**：

- **安全基线扎实**：prompt 走 argv 不经 shell（无命令注入）；工作目录与 `--add-dir` 有显式校验；子进程环境经宿主 `scrubbedParentEnv()` 清洗；登录窗口的 PowerShell 路径已做单引号转义；`SQL` 全部为常量、无注入面。
- **协议适配用心**：一次性 `agy help` 探测 + 按 `exe@size:mtime` 缓存 flag 支持；`--print-timeout` 的"带单位/裸数字"两种写法都实测过（`probePrintTimeout`）；未知 flag 有降级到 text 的兜底。
- **注释即决策记录**：几乎每处非显然行为都写明了"为什么"，包含历史回归（`Cannot access 'transcriptPath' before initialization` 的 TDZ 问题、第 9 版白屏 `module is not defined`）。
- **可测试性设计好**：纯函数与 IO 分离（`parseUsage` / `parseModels` / `pickDeepestFlash` / `parseStepUpdate` 都可脱离 agy 单测）；错误处理普遍做到"不抛出、返回可渲染状态"。
- **测试扎实**：离线套件 93/93 通过，覆盖 stream-json 协议容错、超时、取消、探针缓存与降级、follow-up、后台任务、transcript 开关、工具 schema 一致性。

但**边界条件是系统性短板**，集中为三个方向：

1. **信任边界没统一收口** —— 同一类输入在不同文件里校验程度不同：`agy-history.ts:424` 校验了会话 id，`agy-conversations.ts:71,87,113` 没校验；面板 body 统一声明为 `unknown` 后又在 6 个 handler 里各自 `as` 强转。
2. **有界性承诺没落到代码** —— `MAX_STEPS` / `MAX_HISTORY_STEPS` / `MAX_RUN_TEXT` 三个上限，只有最后一个真正生效，且生效方式破坏了客户端游标，导致面板输出**永久冻结**。
3. **注释里的安全/性能承诺与实现有出入** —— 面板文件头声称"JSON content type 让跨站表单进不来"，但代码从未校验 content-type；有界窗口只是注释；"stale cache beats blank badge" 实际是每次都重读盘。

---

## 二、Critical

### C1. 面板 8 条 HTTP 路由无跨站防护（插件侧与宿主侧都空）→ 跨站网页可驱动本机 agent，等价本地命令执行

> **本条由 v1 的 I1 升级而来**。升级依据是复审阶段读到了宿主 DSH webserver 的真实源码（第七章 §3）：v1 标为 Important 是因为当时无法确认宿主是否另有防护；现在可以确认——**没有**。

**位置**

| 位置 | 内容 |
|---|---|
| `src/agy-panel.ts:222-248` | `jsonRoute` —— 只检查 HTTP method，**不检查 `Origin` / `Sec-Fetch-Site` / token** |
| `src/agy-panel.ts:250-263` | `readJsonBody` —— **不检查 `Content-Type`**，直接 `JSON.parse(text)` |
| `src/agy-panel.ts:293-435` | 全部 8 条路由 |
| `src/agy-panel.ts:5-8` | 文件头声称的防护（**未实现**） |
| `src/index.ts:1502-1503` | agy 实际启动参数：`--dangerously-skip-permissions`（默认开）、`--sandbox`（默认不开） |
| 宿主 `dsh-host-webserver/lib/index.js:378-394` | 请求分发**只按路径匹配**，socket 到插件 handler 之间只有 gzip 中间件 |

**事实链（两端都空）**

*插件侧*

- `readJsonBody` 不看 `Content-Type`；`jsonRoute` 不看 `Origin` / `Sec-Fetch-Site`；没有任何 token / 会话校验，也没有速率限制。
- 文件头 `src/agy-panel.ts:5-8` 写着"JSON content type 让跨站表单进不来，浏览器必须预检且预检失败"——**这个承诺代码里没有实现**，而它恰恰是下面攻击链成立的前提。

*宿主侧（v1 未确认，v2 已确认）*

- 解包 `F:\Agent\DSH\resources\app.asar` 得到的 `@deepseek-ai/dsh-host-webserver/lib/index.js`，全文检索 `origin|csrf|sec-fetch|referer|x-forwarded|authorization`：**只命中 5 处，全是注释、`getOrigin()` 与 `register()`，没有任何鉴权或 Origin 校验**。
- 请求分发（`:378-394`）：

  ```js
  const rawPath = new URL(req.url ?? "/", "http://x").pathname;
  const route = this.match(rawPath);
  if (route !== void 0) { await route.handler(req, res); return; }
  ```

  即：从 socket 到插件的 route handler 之间，**没有任何一层检查请求的来源**。`register(route)`（`:326-333`）也只做路径去重。
- 宿主 `Config` 会拒绝绑定通配地址（注释原文："binding every interface would expose remote code execution to the network"）→ 默认只监听 127.0.0.1。**这是本条严重性的边界条件**，见下方「可利用性」。

**攻击链**

1. 恶意网页发起 `fetch('http://127.0.0.1:6193/api-agy/continue', { method:'POST', mode:'no-cors', headers:{'content-type':'text/plain'}, body:'{"conversationId":"…","prompt":"…"}' })`。
2. `POST` + `text/plain` 是浏览器的 **simple request**，**不触发 CORS 预检**；服务端又不校验 `Content-Type` → 请求被**完整送达并执行**（响应读不到，但副作用已经发生）。
3. 攻击者还需要一个有效的 `conversationId`。跨站读不到响应（插件不设 CORS 头），但 **DNS rebinding** 可以：把 `evil.com` 解析到 `127.0.0.1` 后，浏览器认为页面与 `http://evil.com:6193` 同源，从而读取 `/api-agy/conversations` 拿到 id——**宿主也不校验 `Host` 头**（上文 `:378-394` 已证明）。
4. 拿到 id 后，攻击者让本机 agy 在用户的项目目录里执行任意提示词。因为默认 `--dangerously-skip-permissions` 且**不带 `--sandbox`**（`src/index.ts:1502-1503`），agy 不会问任何权限、也不在沙箱里 → **等价于本地命令执行**。

**可利用性（诚实的边界）**

服务端确实没有防线，但浏览器侧存在**部分**缓解：Chrome 的 Private Network Access / Local Network Access 会对"公网源 → 环回地址"的请求加预检或权限提示，跨源读响应也仍被 CORS 挡住。因此：

- **不受浏览器缓解影响的场景**：本机任意进程直接打这些路由（无 token）；已被攻陷的本地页面（如 `file://` 或 `http://localhost` 上的恶意页）；用户已授予"本地网络访问"权限后。
- **受影响、且需要浏览器策略配合的场景**：任意外部恶意网页 → 依赖浏览器对本地网络的限制策略；该策略**因浏览器与版本而异**，不能当作服务端防护。
- 无论浏览器策略如何，**插件文件头宣称的防护并不存在**，这是必须修的——它属于"承诺了但没做"。

**修复建议（按性价比排序）**

1. **`readJsonBody` 校验 `Content-Type` 必须是 `application/json`，否则 415** —— 一步挡掉全部 simple request（`text/plain` / `form-urlencoded`），成本最低、收益最大。
2. **`jsonRoute` 增加 `Origin` 白名单**：请求带 `Origin` 且不属于 `http://127.0.0.1:<port>` / `http://localhost:<port>` / `http://[::1]:<port>` 时返回 **403**。
3. **面板路由挂宿主鉴权中间件**（若 `dsh-host-webserver` 提供 session/token 能力）；当前宿主 `register()` 只做路径去重，需要宿主侧配合。
4. **面板触发的运行默认走 `--sandbox`**，或提供 `panelSandbox` 开关，把"网页 → 本机 agent"的爆炸半径限制在沙箱内。
5. **修正 `src/agy-panel.ts:5-8` 的文件头注释**，使其与实现一致。
6. 给 `/api-agy/usage`、`/api-agy/prefs` 这类**不需要任何前置条件**即可触发的路由加速率限制。

> **附带确认（宿主做对的地方）**：宿主 `Config` 拒绝绑定 `0.0.0.0` / `::`，默认只监听环回地址，错误信息里明确写了"会暴露远程代码执行"。插件依赖这个前提是合理的；但插件自己不该再假设"别人不会从浏览器打过来"。

---

> **v1 的 C1（前台丢失 `conversation_id`）已撤回**，论证见第五章「已核实并排除的疑点」。真实 agy v1.4.8 的 `init` 与 `result` 事件**都**携带 `conversation_id`，插件前台的取法是正确的。

---

## 三、Important

### A 组 · 安全与信任边界

#### I1. `conversationId` 未校验就拼进文件路径 → 越权读取任意 `.db` / `.pbtxt`（纵深防御缺口）

**位置**：`src/agy-conversations.ts:71`、`:87`、`:113`；写入入口 `src/index.ts:561-572`（只校验 string + 非空）

```ts
join(conversationsDir, `${id}.db`)      // :71
join(annotationsDir, `${id}.pbtxt`)      // :87
existsSync(join(conversationsDir, …))    // :113
```

**事实**：`join` 不阻止 `../` 越界。id 来自 registry，registry 值来自 agy stdout（`src/index.ts:1913,1952`）——即**外部进程输出直接进路径**。一旦 registry 被污染（手工编辑、被别的进程写入、或某个 agy 构建把非预期文本回显进 `conversation_id`），攻击者控制的 id 就能把 `modelFromDb`（读全文件）、`titleFromAnnotations`（读任意 `.pbtxt` 并**回显 title**）指向任意路径。

**可达性说明（重要）**：HTTP 直接可控的那条路径**是安全的**——`/api-agy/history` 的 `conversationId` 来自请求体（`src/agy-panel.ts:343-346`），但 `src/agy-history.ts:424` 的白名单 `/^[0-9a-fA-F-]{8,64}$/` 会在建路径之前拦下。所以这条不是"网页 → 读任意文件"，而是"**污染的 registry → 读任意文件**"，属于纵深防御缺口而非直接远程漏洞。按 Important 而非 Critical 记录。

**对比**：同一个仓库的 `src/agy-history.ts:424` 已经有白名单 —— 说明校验是必要的，只是没共享。

**修复建议**：新增 `src/agy-conversation-id.ts` 导出 `isSafeConversationId(id)`（正则 + 排除 `..` `/` `\`），在 `agy-conversations.ts` 三处与 `src/index.ts:561` 统一使用，脏数据在入口即丢弃。

### B 组 · 正确性缺陷

#### I2. 面板运行输出在 400 KB 处**永久冻结**

**位置**：`src/agy-panel.ts:179` + `:159-161`（MAX_RUN_TEXT 定义在 `:90`）；客户端 `src/client.js:507-514`

```ts
// agy-panel.ts:179
if (run.text.length > MAX_RUN_TEXT) run.text = run.text.slice(run.text.length - MAX_RUN_TEXT)
```

**机制**：缓冲被左移 d 字符后，**长度仍是 409600**；客户端把 `since` 当作当前 `run.text` 的下标，cursor = `run.text.length` = 409600；服务端判定 `since > run.text.length` → `409600 > 409600` 为 false → **不 reset** → `slice(409600)` 返回空串。此后长度恒定、cursor 恒定，客户端永远收不到新字符，输出框停在 400 KB 不再更新。

**影响**：单次运行输出 > 400 KB（长任务很常见）即触发，**直接决定"长任务能不能用"**。

**测试盲区**：`test/panel-routes.mjs:197` 只覆盖"越界游标要 reset"，没覆盖"缓冲区被截断"。

**修复建议**（服务端约 5 行，客户端已有 reset 分支可复用）

```ts
// PanelRun 增加 textResetPending: boolean
// drain 里截断时： run.textResetPending = true
// read() 里：
const reset = run.textResetPending || !Number.isFinite(since) || since < 0 || since > run.text.length
if (reset) run.textResetPending = false
```

更彻底的方案是引入绝对偏移 `base`/`total`（需同时改 `src/client.js`）。


**运行时复现（v2 实测）**：用假 `ctx` / 假 `req` / 假 `res` 驱动**真实的** `/api-agy/run` 路由，注入 500 000 字符后连续轮询——第 1 次 `text` 长度 **409600**、`cursor` 409600、`reset=false`；第 2 次 `since=409600` → `text` 长度 **0**、`reset=false`；再注入 100 000 字符，第 3 次仍是 **0**。**新输出永远送不到客户端**，与静态推导一致。
#### I3. 超时与取消的运行不写 transcript —— 最需要诊断证据的两种失败恰好没有证据

**位置**：`src/index.ts:1691-1704`（aborted / timedOut 分支）早于 `src/index.ts:1709`（写盘）

```ts
if (cancelled || request.signal.aborted) return { …, transcript: transcriptPath }   // 1691
if (timedOut)               return { …, transcript: transcriptPath }                // 1692-1704
…
transcriptPath = config.transcript === false ? undefined
  : writeTranscript(config, plan.id, transcriptHeader(plan) + stdout)                // 1709
```

**影响**：`src/index.ts:1706-1708` 的注释明确写着"persist the raw stream **before** parsing it, so a parse failure still leaves the evidence on disk"——但**超时与取消这两个最需要事后排查的场景（agy 卡死、网络停滞、等待认证）恰好在写盘之前就返回了**，返回的 `transcript` 是 `undefined`。用户只拿到一句"agy did not finish within 360000ms"，却拿不到 agy 当时输出了什么。

**修复建议**：把写盘移到 `timedOut` / `aborted` 判断**之前**（紧跟 `await handle.done` 之后），并保证在 `finally` 中一定发生。注意重试分支（`src/index.ts:1684-1689`）会产生第二次 spawn，写盘位置需相应调整为取最终那次 handle 的输出，或两次都写。

#### I4. `writeTranscript` 的 `index.json` 非原子、无并发保护、文件名可能冲突

**位置**：`src/index.ts:786-813`

```ts
let index = []
try { index = JSON.parse(readFileSync(indexPath,'utf8')) } catch { index = [] }   // 799-804
index = index.filter(…)
index.push({ task: id, file: path, at: … })
index = index.slice(-100)
writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')                 // 808
```

**三个问题**

- **并发丢失**：两个 run 同时结束 → 双方都读同一份旧索引 → 各自 push → 后写者覆盖前者，丢一条记录。**同一份代码里 registry 走了 tmp/rename + 模块级串行队列**（`src/index.ts:592`、`:612`），两种标准并存。
- **崩溃即全丢**：`:808` 是直接覆盖写，进程写入中途崩溃会留下半截 JSON；下次读取 `JSON.parse` 抛错 → `catch` → `index = []` → **整个索引被清空**（`.ndjson` 文件还在，但没有索引就再也找不到了）。
- **文件名冲突**：transcript 文件名是 `sanitize(id)`（`src/index.ts:793`），id 形如 `<sessionId>::agy::<seq>`，sanitize 后不同 id 可能映射到同一文件名 → 覆盖。

**修复建议**：复用 registry 的 tmp+rename 原子写；索引更新放进同一串行队列（或改成"一条记录一个文件 + 目录扫描"的无锁模型）。

#### I5. 前台与后台对 "stream-json 是否可用" 的判定不一致

**位置**：后台 `src/index.ts:1523`、前台 `src/index.ts:1634`

```ts
streamMode: jsonMode && (support.streamJson || !support.probed),                              // 1523：探测失败 ⇒ 假定支持
if (jsonModeArg) argv.push('--output-format', plan.support.streamJson === true ? 'stream-json' : 'json')  // 1634：探测失败 ⇒ 用 json
```

**影响**：探针失败（agy 未安装、帮助文本变化、超时）时后台仍下发 `--output-format stream-json`，前台用 `json`——同一台机器两个入口表现不同；且后台**没有**前台那套"未知 flag → 退化为 text 重试"兜底（`src/index.ts:1676-1690` 只在前台），老构建拒绝该 flag 时后台直接失败。

**修复建议**：收敛为一个字段（如 `plan.outputFormat: 'stream-json' | 'json' | 'text'`）前后台共用，并在后台补上 text 重试。

#### I6. `resolveChildCwd` 的 `?? ''` 让 nullish 合并失效，`childCwd` 可能为空字符串

**位置**：`src/index.ts:97-101` + `src/index.ts:1422-1423`

```ts
function resolveChildCwd(parentCwd: string | undefined, configuredCwd: string): string {
  const base = configuredCwd.trim()
  if (base.length === 0) return parentCwd ?? process.cwd()   // ← '' ?? x === ''，?? 不生效
  …
}
const inheritedCwd = request.parent.session.header.cwd ?? ''   // 1422：undefined 被抹成 ''
const childCwd = cwdOverride ?? resolveChildCwd(inheritedCwd, this.configuredCwd ?? '')  // 1423
```

**影响**：`header.cwd` 缺失时 `inheritedCwd` 是 `''`（非 nullish），于是返回 `''`。

- **Windows**：实测 `spawn(…, { cwd: '' })` 正常（Node 退化为当前目录），表现为"悄悄跑在了 `process.cwd()` 而非预期目录"。
- **POSIX（Linux/macOS）**：`cwd: ''` 会 `ENOENT`（空串不是有效目录）→ **整个插件在非 Windows 平台不可用**，前提是宿主 session header 不带 `cwd`。

**修复建议**

```ts
const base = configuredCwd.trim()
const parent = parentCwd !== undefined && parentCwd.trim().length > 0 ? parentCwd : process.cwd()
if (base.length === 0) return parent
return isAbsolute(base) ? base : join(parent, base)
```

并把 `src/index.ts:1422` 的 `?? ''` 改为保留 `undefined`。

#### I7. 步骤表无上限裁剪 → 长运行内存与 CPU 双失控

**位置**：`src/agy-steps.ts:200-206`（`mergeStepInto`）、`:38`（`MAX_STEPS = 200`）、`:215-218`（`snapshotSteps`）；调用方 `src/index.ts:1870`、`:1922`

**事实**：`mergeStepInto` 里 `[...steps, normalizeStep(incoming)].sort(...)` **无上限**；`MAX_STEPS` 只在 `snapshotSteps` 对**返回值**裁剪，而调用方持有的是**原始数组**。文件头 `:31-37` 承诺的"有界窗口"并未实现。每步最多 4096 字符正文 + 2048 字符工具参数，上千步 ≈ **6 MB 常驻**，且每事件 **O(n log n)** 复制 + 排序。

**修复建议**

```ts
const next = [...steps, normalizeStep(incoming)].sort(…)
return next.length > MAX_STEPS ? next.slice(next.length - MAX_STEPS) : next
```


**运行时复现（v2 实测）**：`mergeStepInto` 合并 2000 步后 `steps.length === 2000`（`MAX_STEPS = 200` 只裁 `snapshotSteps` 的**返回值**），常驻 ≈ **1.35 MB**、耗时 **53.6 ms**。
### C 组 · 性能与资源

#### I8. 每 250 ms 对整份步骤表重复 `normalizeStep`（含 `JSON.stringify`）→ 最坏 ≈8 MB/s 字符串构造阻塞宿主事件循环

**位置**：`src/agy-steps.ts:215-218` × `src/agy-panel.ts:182-188`（`POLL_MS = 250`，`:92`）

**机制**：drain 每 250 ms 调 `handle.steps()` → `src/index.ts:2061` `snapshotSteps` → 对窗口内每步再跑一遍 `normalizeStep`（`src/agy-steps.ts:50-66`），带工具参数的步骤会 `JSON.stringify(parameters)`（≤2048 B）。`MAX_RUNS = 20` 最坏 ≈ **8 MB/s** 的字符串构造，全在 DSH 宿主事件循环里。

**附带问题**：重复归一化**会改变数据**——`truncate` 不幂等（见 S1），同一段文本第二次归一化会把 "(+904 chars)" 改成 "(+13 chars)"，面板显示的截断字符数是错的。

**修复建议**：`snapshotSteps` 去掉 `.map(normalizeStep)`，只做窗口裁剪（步骤在 `mergeStepInto` 时已归一化，重复归一化零收益）。


**运行时复现（v2 实测）**：同一 step 连拍三次，正文尾部截断标记依次为 `…(+904 chars)` → `…(+13 chars)` → `…(+12 chars)`，工具预览 `…(+1962 chars)` → `…(+48 chars)`。**每次快照都在改写已截断文本**——这正是 `truncate` 不幂等（S1）的可见后果。
#### I9. 固定名临时文件 + rename，并发写互相覆盖、丢更新

**位置**：`src/agy-usage.ts:207-217`（`const temp = \`${this.cachePath}.tmp\``，`:210`）、`src/agy-panel.ts:281-286`（`${path}.tmp`，`:283`）

**机制**：A 写 tmp → B 写同一 tmp 覆盖 A → A rename 把 B 的内容 rename 过去 → B rename 时 tmp 已不存在，抛 `ENOENT` 被 `:214` **静默吞掉**。缓存内容错乱且无日志。

**对比**：`src/agy-models.ts:137` 已用 `${file}.${pid}.tmp`——作者知道正确做法，只是没统一。

**修复建议**：两处统一为 `${path}.${process.pid}.${Date.now().toString(36)}.tmp`，catch 里 `rmSync(temp, {force:true})`。

#### I10. 历史副本分支失败时临时目录泄漏 —— 每次面板打开历史泄漏一份完整会话库

**位置**：`src/agy-history.ts:353-370`

**机制**：`mkdtempSync(:354)` → `copyFileSync(:356)` / `new DatabaseSync(copy)(:360)` 抛错 → 落到 `:368` catch → `return null`，**dir 与 copy 都没删**；cleanup 只在成功路径注册。这条分支只在"agy 正持写锁"时走，恰恰是最容易失败的时候（磁盘满 / 文件占用 / DB 被改写）。

**影响**：每次面板打开历史，泄漏一份完整会话历史（含用户 prompt 与模型回复）到 `%TEMP%`。

**修复建议**：把复制 + 打开包进 try，成功返回时注册 cleanup 删除 dir，失败分支 `try { rmSync(dir, {recursive:true, force:true}) } catch {}` 后再 `return null`。

### D 组 · 提示与文案

#### I11. 认证失败提示给出的修复建议在默认路径下无效（`ANTIGRAVITY_API_KEY` 会被清洗掉）

**位置**：`src/index.ts:821-824`（`authHintFor`）

```ts
return `${detail}\nHint: authenticate once by running \`agy\` interactively (agy → login), or set ANTIGRAVITY_API_KEY.`
```

**事实**：子进程环境来自 `scrubbedParentEnv()`（`src/index.ts:1053`、`:1228`、`:1424`）。宿主实现（`node_modules/@deepseek-ai/dsh-subprocess/lib/index.js:32,50-52`）的清洗规则是：

```js
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
if (value !== void 0 && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith("DSH_")) env[key] = value;
```

`ANTIGRAVITY_API_KEY` 含 `KEY` → **被清洗，agy 子进程永远看不到它**。用户照提示设置环境变量后仍然认证失败；而 README 里也没有该变量（`README.md` / `README.zh.md` 全文无 `ANTIGRAVITY_API_KEY`），只有这一条运行时提示——**唯一的排障指引是无效的**。

**修复建议**：二选一 —— ① 在 `scrubbedParentEnv()` 之后显式保留 `ANTIGRAVITY_API_KEY`（若存在）；② 把提示改成"在插件配置的 `env` 里设置 `ANTIGRAVITY_API_KEY`"（`config.env` 是显式 overlay，会覆盖清洗结果，`src/index.ts:1424`），并在 README 配置表补上 `env` 用法示例。

---

## 四、Suggestion

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| S1 | `src/agy-steps.ts:44-47` | `truncate` 不幂等：二次调用把 "(+904 chars)" 改成 "(+13 chars)"，面板显示的截断字符数错误（与 I8 同源） | 加 `const TRUNCATION_MARK = /…\(\+\d+ chars\)$/`，已截断则原样返回 |
| S2 | `src/agy-steps.ts:185`、`src/agy-history.ts:375` | 未知状态被猜成终态：`STATE_RANK[…] ?? 0`（未知永不推进）、`STEP_STATES[…] ?? 'DONE'`（未完成步骤谎报完成） | 保留原值 + `UNKNOWN` 渲染分支 |
| S3 | `src/agy-history.ts:306-310` | `looksLikeModelName` 是死导出（全仓库无调用方），逻辑在 `src/client.js:266` 复制了一份；两处正则不同步会显示不一致 | 删除服务端死代码，或由服务端下发 `bodyIsModelName` |
| S4 | `src/agy-usage.ts:90-92` | `isShortWindow` 同样是死导出 | 删除或接入 |
| S5 | `src/agy-usage.ts:220-224` | `isUsageRow` 未校验 `resetAt` → 磁盘缓存被写坏时运行期 `resetAt` 可能是 number 而类型声明是 string | 补类型校验 |
| S6 | `src/agy-usage.ts:135-141` | 缓存缺失时每次 `peek()` 都重读磁盘（`readFileSync` 抛 `ENOENT` 被吞） | 加"无缓存"记忆标志 |
| S7 | `src/agy-usage.ts:54` | `parseInt("80abc")` 也得 80 | 改严格正则 `/^(\d{1,3})\s*%?$/` |
| S8 | `src/agy-models.ts:42,45` | `FLASH_ID` 只认 `high\|medium\|low`，agy 新增 `xhigh` 等档位会被整体忽略并回退旧版本（违背"版本优先"设计意图） | 放宽为 `([a-z]+)`，未知档位默认 rank 0 |
| S9 | `src/agy-models.ts:115` | `fetchedAt` 只做 `typeof` 检查，**`NaN` 放行** → `src/index.ts:1094` 的 `Date.now()-fetchedAt < TTL` 恒 false → 缓存永不过期，一次写坏即永久钉死 `model:auto` | 加 `Number.isFinite` |
| S10 | `src/agy-models.ts:135-140` | `writeModelCatalog` rename 失败时残留 `${file}.${pid}.tmp` | catch 里清理 |
| S11 | `src/agy-history.ts:436` | 一次性拉全表并逐行 protobuf 解码，最后 `:464` 才裁剪 200 步 | 改 SQL 层 `order by idx desc limit ?` + reverse；`stepCount` 单独 `count(*)` |
| S12 | `src/agy-history.ts:440,447-460` | `gen_metadata.idx` 查出来却从不用，靠 `replyIndex` 顺序配对；任一条 `pickProse` 返回空串会导致后续回复整体错位 | 改用 idx 关联，或配对前过滤空正文 |
| S13 | `src/agy-history.ts:84` | `/^\d+(,\d+)*$/` 会把文本载荷 `"12"` 误当字节数组 | 收紧为 `/^\d+(,\d+)+$/` |
| S14 | `src/agy-history.ts:158` | `byte >= 0xc3` 一律算可打印 → 0xFF 二进制块能过 98% 阈值并被解成替换字符 | ASCII 计数 + `TextDecoder` round-trip 校验 |
| S15 | `src/agy-conversations.ts:58,66` | `MODEL_RE` 的 `\w` 含 `_`，`gemini-3-pro-preview_09` 被整段匹配，结尾 `replace(/[.-]+$/,'')` 去不掉 `_09` | 改 `/gemini-[0-9][0-9A-Za-z.-]*/g` |
| S16 | `src/agy-conversations.ts:59` | `MODEL_CACHE` 只增不减 | 加容量上限 / LRU |
| S17 | `src/agy-conversations.ts:137-146` | 去重时合并不对称：`createdAt` 更大时整体替换会丢掉旧条目的非空 model/status/preview。当前 registry 按 `createdAt` 倒序写（`src/index.ts:585`）恰好走 else 分支才正确，手工编辑成升序就会丢字段 | 两分支统一"补空" |
| S18 | `src/agy-panel.ts:95-100` | `stepsVersion` 只含长度 + 文本总长 + 最后一个 step 的 index/state → 中间 step 由 ACTIVE 变 DONE、或工具参数变化而文本不变时版本不变，客户端保留旧列表 | 把每步 `index:state` 纳入指纹 |
| S19 | `src/agy-panel.ts:250-263` | 请求体超限 / JSON 非法都返回 500 | 应为 **413** / **400** |
| S20 | `src/agy-panel.ts:315-333` | 会话列表路由每次请求都同步读盘 + 开 SQLite（客户端每 20 s 轮询一次），配合 S37 首屏明显卡顿 | summaries 加 30–60 s TTL 缓存；模型探测延后到下一拍增量补齐 |
| S21 | `src/agy-summaries.ts:97` | 只读打开 WAL 库在 agy 运行时可能整表失败（`SQLITE_CANTOPEN`）；`agy-history.ts:353-359` 有"复制 db+wal+shm"兜底而 summaries 没有 → agy 一运行面板就丢掉全部标题/时间/状态且不报错 | 复用复制兜底或 `?immutable=1` |
| S22 | `src/agy-history.ts:339-371` | 事件循环中的同步文件 IO（`mkdtempSync`/`copyFileSync`/`rmSync`），复制几十 MB 库会阻塞宿主事件循环 | 改 `node:fs/promises` |
| S23 | `src/agy-panel.ts:265-266,230,244` | 响应封装三处手写 `{ok:false,error}`，与 `ok()`/`bad()` 重复 | 统一 |
| S24 | `src/agy-usage.ts:44-66` | `parseUsage` 依赖"恰好是 TSV 或恰好两个以上空格"，filter 掉空列会让后续列左移导致百分比取错列 | 先按 tab 切、无 tab 才按空格切；按"最后一列像 ISO 时间"定位 `resetAt` |

### 另有 index.ts / client.js 侧的建议，以及两条从 Important 降级而来的条目（S37 / S38）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| S25 | `src/index.ts:1634`、`src/index.ts:701-726` | 无 `result` 事件时，兜底逐行扫描会返回 `init` 事件（因含 `conversation_id` 而命中判定），于是走进 error 分支，报出误导性的 `agy exited with code 0` | 区分"缺 result 事件"与"result 事件失败"两种错误文案（`test/run.mjs:185-194` 已锁定"不静默成功"，可顺手把消息改准） |
| S26 | `src/index.ts:721-726` | 兜底分支在纯 `json` 模式下也接受"任意含 status/response/conversation_id 的对象"，宽松匹配可能把进度行误判为回复 | 收紧为：仅当对象同时含 `status` 与 `response` 才认作 reply |
| S27 | `src/index.ts:1527` | `id: \`${…}::agy::${…}\` as unknown as SessionId` —— 品牌化类型逃逸 | 改成插件自有的 `RunId` 类型，别借用 `SessionId` |
| S28 | `src/index.ts:807` | transcript 索引只截断到 100 条，**旧 `.ndjson` 文件永不删除** → `~/.dsh/agy-transcripts` 无限增长（单文件可达 1 MB+） | 按索引窗口删除旧文件，或加总量上限 / TTL 清理 |
| S29 | `src/index.ts:323`（默认 `transcript: true`） | transcript 默认记录完整 prompt + 每次工具调用参数（含可能的密钥、路径、用户数据）到 `~/.dsh/agy-transcripts/*.ndjson` | 保持默认开启是合理取舍，但应提供清理命令 / 保留期策略，或对常见密钥模式做掩码 |
| S30 | `src/index.ts:455-457`、`:464-476` | `writeFlagCache` 直接覆盖写（非原子）；`resolveProxyUrl` 每次 spawn 都同步 `readFileSync` | 缓存用 tmp+rename；代理加内存缓存 + mtime 检查 |
| S31 | `src/index.ts:1613-1625`、工具描述 | 真实超时 = `timeoutMs + watchdogMarginMs`（默认 +60 s），但工具描述与错误信息都称"ceiling 为 timeoutMs" | 文案写明"软上限 + 60 s 看门狗余量" |
| S32 | `src/index.ts:2389` | follow-up 工具调用 `loadTaskRegistry(config)` 未传 logger，而 tasks 工具（`src/index.ts:2549`）传了 | 统一传入 `ctx.logger`，否则 registry 损坏时的告警被吞 |
| S33 | `src/index.ts:2410` | follow-up 把 `createdAt` 刷成当前时间，字段语义变成"最近活动"而非"创建时间"，而 UI/工具描述仍叫 created/最近完成 | 拆成 `createdAt` 与 `lastActivityAt` |
| S34 | `src/client.js:474` | `if (payload.loading) setTimeout(() => loadUsage(false), 2500)` 的定时器未保存引用、也无存活检查，组件卸载后仍会触发 | 保存 timer 引用并在 cleanup 里 `clearTimeout`（同文件 `496-523` 的写法是对的，可照抄） |
| S35 | `package.json:17-24`、仓库根目录 | ① `files` 只含 `lib`，发布的 npm 包**不含源码**，使用者无法审计；② 仓库根提交了 5 个 `.tgz` 产物（`0.2.0-patched.{5,9,10,11,12}`，约 250 KB） | ① 把 `src/` 加入 `files`（或至少提供 source map）；② `.tgz` 加进 `.gitignore`，只在发布时生成 |
| S36 | `CHANGELOG.md` | patched.9 条目写"7 条路由"，现在已是 8 条（history 为 patched.12 新增） | 更新文档 |
| S37 | `src/agy-conversations.ts:76` | 为找模型名把整个会话 `.db` 读进内存（`lastModelIn(readFileSync(file))` + `toString('latin1')` 全量正则）。**v1 列为 Important，实测后降级**：真实目录 **114 个 `.db` / 合计 56.8 MB**，单文件最大 3.1 MB → `modelFromDb` 2.8 ms；**冷缓存扫完 114 个 = 600 ms 同步阻塞、rss +53 MB**（二次命中缓存 12 ms）。v1 写的"首屏卡死数秒、峰值 2× 文件"**夸大了** | 只读文件头——`openSync` + `readSync(fd, buf, 0, 1<<20, 0)` + `closeSync`，只扫前 1 MB（模型 id 通常在头部）；退回全量读时加 size 上限。**收益中等**：600 ms 阻塞发生在面板首屏路径上，仍值得优化，但不是正确性问题 |
| S38 | `src/agy-panel.ts:222-248`、`:295`、`:343`、`:351` | 面板路由用 `body as { conversationId?: unknown } \| null` 断言解析请求体，"字段校验过没有"的规则散落 6 个 handler。**v1 说它"绕过 TS 检查"，定性有误**——每处断言后都紧跟 `typeof` / 可选链的运行时收窄，是**标准安全写法**；且 handler 是 **6 处**不是 7 处（第 7 处在 `readPrefs:272`，本就不处理外部 body） | 新增 `readString(body, field)` / `readBool(body, field)`（内部用 `Array.isArray` + `Record` 判定），Handler 类型改成 `(body: unknown) => …`，把"取字段"这条规则收口。**属可维护性改进，非安全缺陷** |

---

## 五、已核实并排除的疑点

审查过程中提出、经验证**不成立**的怀疑，记录在此以免重复排查：

| 疑点 | 结论 | 依据 |
|---|---|---|
| `flagCachePath: z.string()` 无 `.default()` 会导致插件启动配置校验失败 | **不成立** | 实测 schemastery：缺字段不报错、结果中该键为 `undefined` → `flagCachePath(config)`（`src/index.ts:408-411`）走默认路径；README 文档描述正确 |
| `/api-agy/history` 的 `conversationId` 可造成路径穿越 | **不成立** | `src/agy-history.ts:424` 有白名单 `/^[0-9a-fA-F-]{8,64}$/`，不匹配直接返回 `invalid conversation id`（但 `agy-conversations.ts` 侧缺同样的校验，见 I1） |
| `/api-agy/continue` 可指定任意工作目录 | **不成立** | cwd 只能来自 registry 记录（`src/agy-panel.ts:359-361`），且要求目录存在 |
| 前端把 agent 输出用 `innerHTML` 渲染导致 XSS | **不成立** | `src/client.js` 全文无 `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval` / `new Function` |
| `--output-format` 传 prompt 存在命令注入 | **不成立** | prompt 走 argv 数组，不经 shell；`--add-dir` 有绝对路径 + 存在性 + 目录性校验（`src/index.ts:886-910`） |
| 登录窗口的 PowerShell 命令可被注入 | **不成立** | `src/index.ts:1237` 对单引号做了 `''` 转义，PowerShell 单引号串内不展开变量；`exe` 由 PATH 解析/固定候选得出 |
| `~/.dsh/agy-proxy.txt` 可被任意劫持 | 缓解充分 | 文件由本地用户拥有；写入只影响子进程的 `HTTP(S)_PROXY`/`ALL_PROXY`；`NO_PROXY` 默认排除 localhost |
| npm 包与仓库 `lib/` 不同步 | **不成立** | `lib/index.js:530-537,1395,1611` 与 `src/index.ts` 的解析逻辑一致 |
| `peers.d.ts` 存在类型不安全写法 | **不成立** | 这是刻意为之的本地类型垫片，注释已解释为何不能声明 transcript、CI 用真实 peer 校验；`:26-33` 的 `any` 是"能编译即可"的临时选择，不建议加码 |
| **v1 的 C1：前台 stream-json 解析可能静默丢失 `conversation_id`，导致 follow-up 失效** | **撤回（已证伪）** | 真实 agy v1.4.8 的 stream-json 输出中，`init` **与** `result` 事件**都**携带 `conversation_id`（成功样本：`{"event":"init","conversation_id":"932c24f1-…"}` → `{"event":"result","result":{"conversation_id":"932c24f1-…","status":"SUCCESS","duration_seconds":5.008479,…}}`）。插件前台取内层 `result` 的做法是**正确的**；`test/fake-agy.mjs` 在两处都放 id 属于"冗余但无害"，不是"掩盖 bug" |
| **v1 的 I8：Go 时间戳解析过窄、无时区 → 时间全丢或偏 8 小时** | **撤回（已证伪）** | 真实 `conversation_summaries.db` 的时间戳形如 `"2026-10-22 10:52:42.098176+00:00"`（**自带 `+00:00`**），插件 `parseTime`（`replace(' ','T')` + `new Date()`）解析**完全正确**（毫秒值 1792666362098）；112 行全部读出，仅 3 条 Go 零时间 `"0001-01-01 00:00:00+00:00"` → `null`（本就应过滤）。**不存在偏 8 小时的问题** |

---

## 六、测试与构建流水线专项（scripts / rebuild.ps1 / CI / test）

### 值得称赞的设计

- `scripts/build.mjs:93-135` 在构建时**自检 web bundle**：把 `lib/client.js` 当经典脚本求值（无 `module`/`exports`/`require`）、断言它经 `window.__ModuleLoader__` 注册、断言 factory 返回 `{name, inject, apply}`。这正是 patched.9 白屏（`web boot: 1 entry did not activate`）的**回归守卫**，写得很到位。
- `scripts/pack.mjs` 手写确定性 tar：路径排序、固定 mtime（`MTIME = 499162500`）、固定 mode、每次输出 sha256 → **相同源码产出字节一致的包**，可 diff。
- `rebuild.ps1` 是四段式流水线（check → test → pack → verify），verify 会解包并检查 `package/` 前缀、开发文件泄漏、版本号、mount id、**以及"打包进去的 `lib/index.js` 与刚跑过测试的本地 `lib/index.js` sha256 一致"**（`:225-228`）——这个细节很多人会漏。
- `test/fake-agy-wrapper.mjs` 与 `test/subprocess-shim.mjs` 解决了一个非常真实的坑：Windows 下 `.cmd` 会把含换行的参数经 cmd.exe 拼成一行，导致 `--output-format` 被静默丢弃；测试因此**绕过 cmd.exe 直接 spawn node**，复刻真实 `.exe` 的无 shell 路径。

### T1 · Important — `rebuild.ps1` 只监视 `src/index.ts`，改动其它源文件会静默发布旧 `lib`

> **定性澄清（重要）**：实测当前 HEAD（`485efaf`）的 `lib/` 与 `src/` **是完全同步的**——分别按 `tsconfig.local.json` 与 `tsconfig.build.json` 重编译到临时目录后逐字节比对，8 个 `.js` + 8 个 `.d.ts` **全部一致**；解包最新 tgz，包内 `lib/index.js` 的 SHA256 = `b629e766…2b4054`，与仓库一致。所以 T1/T2 是**"缺防线"，不是"已经漂移"**。
>
> 但风险是**机制性的、可复现的**，而且**有真实命中记录**：本次最后一次构建（`lib/*.js` @ 00:47:59）恰恰是被 `src/agy-history.ts`(00:47:40) 与 `src/client.js`(00:47:52) 触发的，而 `src/index.ts` 停留在 00:37:59——**若当时依赖 `rebuild.ps1` 的自动判定，这次构建会被跳过**，发布出去的就是少两个修复的包。

**位置**：`rebuild.ps1:47-69`

```powershell
$src = Join-Path $PSScriptRoot 'src\index.ts'
$out = Join-Path $PSScriptRoot 'lib\index.js'
if ((Test-Path -LiteralPath $out) -and
    (Get-Item -LiteralPath $out).LastWriteTimeUtc -ge (Get-Item -LiteralPath $src).LastWriteTimeUtc) {
    return          # ← 跳过构建
}
```

**问题**：判定只看 `src/index.ts` 一个文件。而实际源码有 10 个：`agy-panel.ts`、`agy-history.ts`、`agy-steps.ts`、`agy-usage.ts`、`agy-conversations.ts`、`agy-models.ts`、`agy-summaries.ts`、`client.js`、`peers.d.ts`。

**失败场景**：改了 `src/agy-panel.ts` 修一个面板 bug → `src/index.ts` 的 mtime 没变 → `Build-Bundle` 直接 return → `lib/agy-panel.js` 仍是旧版 → 离线套件跑的是旧 lib、全绿 → 打包、发布。**用户拿到的是"修了 bug 的版本"，但面板 bug 原封不动。** verify 步骤的 sha256 比对（`:225-228`）也发现不了——它比的是"包里的 lib"和"本地的 lib"，两边同样陈旧（且只覆盖 `lib/index.js` 一个文件，见 T25）。

**修复建议**

```powershell
$srcNewest = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Recurse -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$libNewest = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'lib') -Recurse -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($libNewest -and $libNewest.LastWriteTimeUtc -ge $srcNewest.LastWriteTimeUtc) { return }
```

更稳妥的做法是**彻底去掉增量判定**：`rebuild.ps1` 是发布脚本，每次发布都必须无条件 `npm run build`（tsc 增量本身已足够快）。或者加一个 `pretest` 钩子（T27），让"忘记 build"在本机就立刻暴露。

### T2 · Important — CI 不校验已提交的 `lib/` 与 `src/` 同步，而 `.gitignore` 明确承诺了这件事

**位置**：`.github/workflows/ci.yml:35-46`、`.gitignore:8-11`

`.gitignore` 里的注释原文（这是关键——**维护者相信的防线并不存在**）：

> The compiled bundle is tracked on purpose … It is reproducible from `src/` with `npm run build`, and **CI rebuilds it to check the two agree.**

而 `ci.yml` 实际只有：`checkout` → `setup-node` → `npm install` → `npx tsc -p tsconfig.typecheck.json` → `node scripts/build.mjs` → `node test/run.mjs`。**没有任何 `git diff --exit-code -- lib/` 之类的比对步骤**——CI 重建了 `lib/`，但重建产物只用来跑测试，**从不与仓库里提交的 `lib/` 比对**。

**问题**：改了 `src/` 忘记提交 `lib/` → CI 全绿 → 但发布的是旧代码。这与 T1 是同一类问题的两个入口，而 `.gitignore` 的注释让维护者以为它已经被堵住了。

**修复建议**：CI 的 build 步骤后加一步：

```yaml
      - name: Verify lib/ is in sync with src/
        run: git diff --exit-code -- lib/
```

并把 `.gitignore` 的注释改成事实描述（或在补上该步骤后再保留原措辞）。

### T3 · Important — `scripts/selftest.mjs` 把"agy 版本较老、缺少某个 flag"判为**失败**，但插件本就能自适应

**位置**：`scripts/selftest.mjs:86-92`

```js
const has = (flag) => new RegExp(`--${flag}(?:\\s|=)`).test(text)
for (const flag of ['output-format', 'conversation', 'sandbox', 'prompt-file', 'print-timeout']) {
  const supported = has(flag)
  if (supported) pass(`--${flag} supported`)
  else if (flag === 'prompt-file') pass('--prompt-file absent (expected on current agy)')
  else report(`--${flag} supported`, 'flag not listed in agy help — the plugin will adapt, but verify the installed version')
}
```

**问题**：`report()` 会 `failures += 1`（`:22-25`），最终 `process.exit(1)`。但插件的设计是**显式支持旧构建**：`src/index.ts:1442` "this agy build lacks `--output-format`; running in text mode"、`src/index.ts:1446` "this agy build lacks `--sandbox`; skipping the flag"，`resolveFlagSupport` 就是为此存在的。

于是：**一个功能完全正常的老版本 agy，会让 `npm run selftest` 退出码为 1**。这在 CI 或发布脚本里会被读成"自检失败"。

**附带误判**：正则 `--flag(?:\s|=)` 要求 help 文本里 flag 后面必须跟空白或 `=`；若某个 agy 版本把 flag 排在表格里用制表符或多空格以外的格式（如 `--flag=VALUE` 之外的 `--flag  VALUE` 换行排版），会被判成"不支持"。

**修复建议**：把"flag 缺失"降级为 **warn**（打印提示但不计入 failures），只把"agy help 超时/挂起"（`:93`）当失败；或者按插件真实的降级语义分级——`output-format` 缺失是致命（无法拿 `conversation_id`），`sandbox` 缺失只是提醒。

### T4 · Suggestion — `scripts/pack.mjs` 的白名单与 `package.json` 的 `files` 不一致

**位置**：`scripts/pack.mjs:28-37` vs `package.json:17-24`

| 文件 | `scripts/pack.mjs` | `package.json` files |
|---|---|---|
| `README.i18n.yaml` | ✅ 包含（`:35`） | ❌ 未列出 |
| `src/` | ❌ | ❌ |
| `test/` `scripts/` | ❌（EXCLUDE 排除） | ❌ |

同一个包，`npm publish` 与 `scripts/pack.mjs` 产出的内容不同。`rebuild.ps1:149` 的 `$allowed` 又是第三份列表（包含 `README.i18n.yaml`）。

**建议**：抽成单一来源（一个 `files.json` 或一个共享的 `PACK_FILES` 常量），三处引用同一份。

### T5 · Suggestion — 发布流水线在 POSIX 上不可一键完成

`rebuild.ps1` 是 PowerShell-only，四段式（check/test/pack/verify）只在这里有；`scripts/build.sh` 只做"link peer + 编译"，**没有 test / pack / verify**。CI 虽然跑在 `ubuntu-latest` 上，但只跑 typecheck + build + offline suite，不打包、不校验 tarball 内容。

**建议**：要么把 verify 逻辑抽成 `scripts/verify-pack.mjs`（Node），让 `build.sh` 也能复用；要么在 CI 里加一个 `node scripts/pack.mjs` + 解包校验的步骤。

### T6 · Suggestion — CI 矩阵缺 macOS

`.github/workflows/ci.yml:18` 是 `os: [windows-latest, ubuntu-latest]`。插件的路径处理有明显的 POSIX 分支（`/^[0-9a-fA-F-]{8,64}$/` 之类与路径分隔符无关，但 `build.sh`、`/tmp` 临时目录、`~/.dsh` 路径、`spawn` 的 cwd 语义在 macOS 上与 Linux 相同、与 Windows 不同）。CI 里"Windows 不可省略"有注释说明理由（`:16-17`），但 POSIX 侧只测了 Linux。

**建议**：矩阵加 `macos-latest`（若成本可接受）。

### T7 · Suggestion — `test/subprocess-shim.mjs` 的 spill 文件重复写入已捕获的头部

**位置**：`test/subprocess-shim.mjs:45-48`

```js
if (take.length < chunk.length) {
  this.truncated = true
  if (this.spillPath !== undefined) writeFileSync(this.spillPath, chunk, { flag: 'a' })
}
```

溢出时把**整个 chunk**（含已进入 `this.chunks` 的头部）追加进 spill 文件 → spill 内容与已捕获前缀重复。插件侧读 spill 时若按"偏移 + 已读字节数"拼接，会重复一段。

**建议**：写 `chunk.subarray(take.length)`。当前没有断言依赖这个行为，属于潜在坑。

### T8 · Important — CI 只跑 `test/run.mjs`，**完全不覆盖本次出问题的那些模块**

**位置**：`.github/workflows/ci.yml:45-46`（`run: node test/run.mjs`）、`package.json:91-92`

```json
"test":      "node test/run.mjs",
"test:panel": "node test/panel-sources.mjs && node test/panel-routes.mjs && node test/panel-stream.mjs && node test/panel-client.mjs && node test/agy-models.mjs && node test/agy-summaries.mjs && node test/agy-steps.mjs && node test/agy-history.mjs"
```

**事实**：实测 `test/run.mjs` 的 import 只有 `node:fs`、`node:path`、`./harness.mjs`；全文**没有任何** `api-agy` / `panel` / `history` / `usage` / `steps` 的引用。也就是说 `src/agy-panel.ts`、`src/agy-history.ts`、`src/agy-steps.ts`、`src/agy-usage.ts`、`src/agy-models.ts`、`src/agy-summaries.ts`、`src/agy-conversations.ts` 这 7 个模块**在 CI 里一行测试都没跑**——它们只出现在 `npm run test:panel` 里，而 CI 从不执行那个 script。

**后果**：本次审查报告的 Important 条目里，**面板冻结（I2）、步骤无上限（I7）、重复归一化（I8）、整库读入内存（S37）、固定名临时文件（I9）、输入解析风格（S38）、临时目录泄漏（I10）** 以及路径穿越（I1）共 8 条落在这些文件里，而 **CI 一行都没跑**——`test/run.mjs` 全文没有任何 `api-agy|panel|history|usage|steps` 引用。CI 全绿并不能保证它们没坏。

**实测补充**：`npm run test:panel` 本地**全部通过**（8 个文件、数十条断言，含 panel-routes / panel-stream / agy-steps / agy-history 的用例）。也就是说这些模块**是有测试的**，只是 CI 从不执行它们——一个"测试写得挺好但 CI 不跑"的典型浪费，也是这批缺陷能长期潜伏的直接原因。

**修复建议**

1. CI 的离线套件改成跑全量，例如把 `package.json` 的 `test` 脚本改为先 `test:panel` 再 `test`，或直接 `node test/run.mjs && npm run test:panel`。
2. 至少把 `test/panel-routes.mjs` 与 `test/agy-history.mjs` 拉进 CI——面板路由是唯一对外暴露 HTTP 接口的地方。

### T9 · Suggestion — `test` 与 `test:panel` 两个入口应合并

`package.json` 里 `test` 与 `test:panel` 是两条独立命令，覆盖范围完全不同（见 T8），容易出现"本地跑了 `npm test` 就以为全测过了"的错觉。建议合并为一个 `test`（内部依次调用两个套件），另留 `test:panel` 作为按需子集。

### T10 · Important — `npm run pack` 这个脚本入口**根本跑不起来**

**位置**：`package.json:94`、`scripts/pack.mjs:21-25`

```json
"pack": "node scripts/pack.mjs",
```
```js
const [root, out] = process.argv.slice(2)
if (!root || !out) {
  console.error('usage: node scripts/pack.mjs <projectRoot> <outputTgz>')
  process.exit(2)
}
```

`pack.mjs` 需要两个位置参数，而 npm script 没给 → `npm run pack` 只会打印一行 usage 并以 **exit 2** 结束（实测确认）。

**定性**：真正的发布路径 `rebuild.ps1:161` 是 `& $node $packScript $root $tarball`，**参数齐全、不受影响**。所以这不是"发布流程坏了"，而是一个对外暴露的 npm script 入口是坏的——用户按 `package.json` 里的 scripts 列表找发布命令一定会撞上它。

**修复建议**：`"pack": "node scripts/pack.mjs . dist/dsh-external-dsh-subagent-antigravity.tgz"`，或让 `pack.mjs` 在缺参时默认 `<root>=cwd`、`<out>=dist/*.tgz`。

### T11 · Important — 异步断言没有被 await，测试摘要**谎报通过数**

**位置**：`test/agy-history.mjs:20-24`（`check` 是同步的）、`test/agy-history.mjs:114`（传入 async 回调）

```js
const check = (name, fn) => {
  fn()          // ← 返回的 Promise 被丢弃，从不 await
  passed += 1   // ← 立刻 +1
  console.log(`  ok  ${name}`)
}
…
check('a missing conversation yields an empty timeline instead of an error', async () => {
  const missing = await readConversationHistory('99999999-…', dir)
  assert.equal(missing.source, 'missing')   // ← 失败会变成 unhandled rejection
})
```

**后果**：`fn()` 返回的 Promise 被丢弃，`passed` 在断言**还没跑**时就 +1 并打印 `ok`。断言失败时：摘要已经打印了"9 checks passed"（**谎报**），随后进程因 unhandled rejection 退出 1。

也就是说：**退出码仍然是对的**（CI 不会真的放行），但**人类读的摘要与 `rebuild.ps1:129-131` 那种"只比两个数字"的门禁会读到错误的通过数**。叠加上 T8（CI 从不跑 `test:panel`），这类问题在流水线里完全没有信号。

**修复建议**：`check` 改成 async 并 `await fn()`，所有调用点跟着 `await`；或者在 `check` 里显式 `fn().catch((e) => { passed -= 1; console.log('  FAIL …') })` 把失败落到计数上。

### T12 · Important — 过滤器没匹配上时，测试套件**以 0/0 成功退出**

**位置**：`test/run.mjs:12`、`:27`、`:519-525`；`rebuild.ps1:129-131`

```js
const filter = process.argv[2]                     // :12
if (filter !== undefined && !name.includes(filter)) return   // :27 —— 全部跳过
…
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`)
if (failed.length > 0) { … process.exitCode = 1 }            // 0 条 → 不设 → exit 0
```

`node test/run.mjs <拼错的过滤词>` → 一个用例都不跑 → 打印 `0/0 assertions passed` → **退出码 0**。

**与发布流水线的耦合**：`rebuild.ps1:129-131` 的门禁是

```powershell
$summary = [regex]::Match($suite, '(\d+)/(\d+) assertions passed')
if ($summary.Groups[1].Value -ne $summary.Groups[2].Value) { Die … }
```

它**只比较"通过数 == 总数"**。这意味着：① 0/0 通过；② **用例被误删导致总数从 60 降到 58 也会"通过"**——这个门禁只能发现"断言失败"，发现不了"覆盖率缩水"。

**修复建议**：① `results.length === 0` 时直接 `process.exitCode = 1`；② `rebuild.ps1` 额外断言总断言数 ≥ 某个下限（如 50），把"用例丢失"变成硬失败。

### T13 · Important — 文档漂移：README 让用户安装一个**并不存在**的包名

**位置**：`README.md:16`、`:42`、`:238`；`README.zh.md:14`、`:40`；`CHANGELOG.md:10`；对照 `package.json:3`、`rebuild.ps1:154`

| 文档写的 | 实际 |
|---|---|
| `README.md:16` / `README.zh.md:14`：当前版本 `0.2.0-patched.9` | `package.json:3` = `0.2.0-patched.12` |
| `README.md:42` / `README.zh.md:40`：安装 `dsh-external-dsh-subagent-antigravity-0.2.0.tgz` | `rebuild.ps1:154` 产的是 `…-0.2.0-patched.12.tgz`（**带 `-patched.N` 后缀**） |
| `README.md:238`：`npm run test:panel` → 39 assertions | 实测 8 个文件共 **60** 条断言 |
| `CHANGELOG.md:10`：最高条目 `0.2.0-patched.11` | 缺 `patched.12` 条目 |

**影响**：用户照 README 的安装步骤走，**找不到那个文件**（仓库里 5 个 tgz 全都带 `-patched.N` 后缀），只能猜哪个是对的——而根目录同时躺着 patched.5 / .9 / .10 / .11 / .12 五个包，装错版本不会有任何提示。

**修复建议**：① README 的安装段落给出**精确文件名**或改成 `npm install <path>/dsh-external-dsh-subagent-antigravity-0.2.0-patched.12.tgz`；② 把版本号与断言数改成从 `package.json` / CI 输出自动引用，别手写；③ 补 `CHANGELOG` 的 `patched.12` 条目。

### T14 · Important — 发布的类型声明被静默降级为 `Config: any`

**位置**：`lib/types/index.d.ts:77`；成因在 `scripts/build.mjs:46-73`

```ts
export declare const Config: any;      // lib/types/index.d.ts:77
```

**成因链**：`build.mjs` 用 `peerTypesResolve()` 探测 peer 是否有**可用的**类型声明（它写得很好——会检查声明文件是否真的有内容而非 `export {}`），但**只探测 `@deepseek-ai/dsh-jobs` 一个包**：

```js
const real = peerTypesResolve()
const config = real ? 'tsconfig.build.json' : 'tsconfig.local.json'   // :67-68
```

一旦这个包缺类型（当前本机的 `node_modules` 指向一份旧安装），整个构建就**整体切到带 `src/peers.d.ts` 垫片的宽松配置**，产出的 `.d.ts` 里 `Config` 直接退化成 `any`。构建时只在 stdout 打一行 `build: peer declarations missing → tsconfig.local.json`，**不影响退出码**，所以这个降级会一路进到发布包里。

**影响**：宿主侧拿到的插件类型声明里 `Config` 是 `any` → 配置项的自动补全与静态校验失效（运行时靠 schemastery 仍然正确，所以不是功能性故障，是**类型层面的静默降级**）。

**修复建议**：① 把 `Config` 的类型从 peer 类型里解耦——`Config` 是插件自己的 schemastery schema，不依赖任何 peer，本就不该因为 peer 缺类型而变成 `any`；② 构建时若走了宽松配置就**以非零码退出**，或至少在 verify 阶段断言 `.d.ts` 里不存在 `Config: any`。

### T15 · Important — 构建不清理 `lib/`，删除源模块后旧产物会被打包

**位置**：`scripts/build.mjs:88`

```js
mkdirSync(join(root, 'lib'), { recursive: true })    // 只建目录，从不清理
```

`build.mjs` 没有任何 `rmSync` / 清空 outDir 的动作。`pack.mjs:28-37` 的 `INCLUDE` 里包含整个 `lib` → **任何被删除或重命名的 `src/*.ts` 都会在 `lib/` 里留下同名 `.js`，并被打进发布包**。

**与 T1 的关系**：T1 是"改了源码不重建"，T15 是"删了源码不清产物"——两者都会让发布包与源码不一致，且都**不会让任何测试变红**。

**修复建议**：构建前清空 `lib/`（或至少删除 `src/` 中已不存在的模块对应的产物），并在 verify 阶段断言 `lib/` 里的文件集合与 `src/` 一一对应。

### T16 · Suggestion — `test/panel-stream.mjs` 的定时器在失败时泄漏，进程会挂死而不是失败

**位置**：`test/panel-stream.mjs:33-35`、`:60`

`setInterval` 泵在 `await handle.done` **之后**才 `clearInterval`；`done` reject 时定时器不会被清 → Node 因定时器仍存活而**一直不退出**（表现为 CI 卡住而不是失败）。另外 `:60` 硬编码打印 `"4 checks passed"`，而该文件实际有 9 条断言——又一处"摘要与实际脱节"。

### T17 · Suggestion — `test/agy-summaries.mjs` 的 scratch 目录不是原子创建，清理也不在 `finally`

**位置**：`test/agy-summaries.mjs:9`、`:105`

用 `tmpdir() + pid` 拼路径而不是 `mkdtempSync` → 崩溃残留会与下一次运行**撞同一个目录**（`create table` 报"表已存在"）；`:105` 的 `rmSync` 不在 `finally` 里 → 失败即泄漏目录。

### T18 · Suggestion — `test/e2e-real.mjs` 硬编码本机绝对路径

**位置**：`test/e2e-real.mjs:18`、`:68`

`:18` 把 `AGY_BIN` 写成本机绝对路径 → 换机器即失效；`:68` 的 `process.env.TEMP ?? '.'` 在 Linux 上没有 `TEMP` 变量 → 落到 CWD，把临时文件写进仓库。

### T19 · Suggestion — `test/history-real.mjs` 是零断言、无 npm script 入口的"孤儿文件"

**位置**：`test/history-real.mjs:1-31`

没有任何断言、没有对应的 npm script、`package.json:91-96` 里也没有它的入口；`:8-9` 直接 `readFileSync` 而不检查存在性 → registry 不存在时以 ENOENT 崩溃。它既不能被 CI 用，也没被任何人跑。

### T20 · Suggestion — 两个 fixture 文件全仓库零引用

**位置**：`test/fixtures/ndjson/simple-text.txt`、`test/fixtures/ndjson/permission-denied.txt`

`grep` 全仓库无引用 → 死 fixture。要么接进用例，要么删掉。

### T21 · Suggestion — `test/harness.mjs` 用 `Date.now()` 做 import cache-buster

**位置**：`test/harness.mjs:68`

同一毫秒内两次 `bootPlugin` 会拿到**同一个模块实例** → 模块级状态（缓存、计数器）在用例间互相污染。建议改用 `randomUUID()`。

### T22 · Suggestion — 失败用例被重复计数，摘要分母虚高

**位置**：`test/run.mjs:46-48`

```js
} catch (error) {
  console.log(`  FAIL ${name}: …`)
  results.push({ name: `${name} (case)`, ok: false, detail: String(error) })
}
```

`check()` 在失败时已经 push 了一条失败记录（`:17`），catch 里又 push 一条 → **同一个失败被计两次**（用例级 + 断言级），摘要里的分母因此虚高。

### T23 · Suggestion — fake agy 不拒绝未知旗标，拼写错误只能靠真实 e2e 暴露

**位置**：`test/fake-agy.mjs`

假 CLI 接受任意 `--flag`。若插件把 `--output-format` 拼错，**离线套件照样全绿**——只有真实 e2e 能发现，而真实 e2e 既不在 CI 里（T8）又需要真机 + 登录态。

**建议**：给 fake-agy 加一个"已知旗标白名单"，遇到未知 `--flag` 直接以非零码退出（并在测试里断言插件只使用白名单内的旗标）。

### T24 · Important — 全部测试打的是 `lib/`（已编译产物）而不是 `src/`——**测的东西可能不是要发的东西**

**位置**：`test/harness.mjs:22`、`:67-68`；`test/panel-routes.mjs:14-15`；`test/panel-sources.mjs:14-15`；`test/agy-{models,steps,history,summaries}.mjs`；**例外**：`test/panel-client.mjs:21-22`

```js
const PLUGIN_ENTRY = resolve(HERE, '..', 'lib', 'index.js')        // harness.mjs:22
const mod = await import(`${pathToFileURL(PLUGIN_ENTRY).href}?t=${Date.now()}`)   // :67-68
```

**问题**：这套测试验证的是"**已提交的 `lib/`** 行为正确"，不是"**`src/` 源码**行为正确"。若维护者改了 `src/agy-panel.ts` 却忘了 `npm run build`，`lib/agy-panel.js` 仍是旧行为 → **93/93 全绿、60 checks 全绿、CI 全绿**，而发布出去的是旧面板。这正是 T1 + T2 叠加出的静默假绿的**第三个环节**——前两个是"没触发重建"和"没校验产物"，这个是"测的是旧产物还全绿"。

**附带的口径分裂**：唯一的例外 `test/panel-client.mjs:21-22` 读的是 `src/client.js` 与 `src/agy-panel.ts` 的**源码文本**——它验证的文件和实际发布的 `lib/client.js`（`build.mjs:86-91` 的复制品）**不是同一个文件**。两处口径相反，且没有任何一处覆盖"提交的 `lib/client.js` == `src/client.js`"。

**修复建议**：① `scripts/build.mjs` 在复制 `src/client.js → lib/client.js` 之后立刻断言两者字节一致；② 新增 `test/lib-sync.mjs`：把 `src/` 编译到临时目录并与 `lib/` 比对，把 T2 的机器校验同时落到本地测试里；③ 或者更彻底——让测试直接跑 `src/`（CI 里先 build 再测），让"测的"和"发的"永远是同一份。

### T25 · Suggestion — 发布前的 SHA 校验只覆盖 `lib/index.js` 一个文件

**位置**：`rebuild.ps1:224-228`

```powershell
$localHash   = (Get-FileHash -LiteralPath (Join-Path $root    'lib/index.js') -Algorithm SHA256).Hash
$shippedHash = (Get-FileHash -LiteralPath (Join-Path $pkgRoot 'lib/index.js') -Algorithm SHA256).Hash
if ($localHash -ne $shippedHash) { Die 'shipped lib/index.js differs from the tested one' }
```

`lib/` 下实际有 9 个 `.js`（`index` / `client` / `agy-panel` / `agy-history` / `agy-steps` / `agy-usage` / `agy-conversations` / `agy-models` / `agy-summaries`）+ 9 个 `.d.ts`。只校验 `index.js` 意味着 **`agy-panel.js`、`client.js` 这些与用户实际使用强相关的模块未被校验**——而"最后一道闸门"本该覆盖全部产物。

**建议**：改为对 `lib/` 下全部文件逐个计算 SHA256 比对（或比对文件清单 + 全部哈希）。

### T26 · Important — `node:sqlite` 的版本下限没有声明，`package.json` 缺 `engines`

**位置**：`test/agy-history.mjs:15`、`test/agy-summaries.mjs`（`import { DatabaseSync } from 'node:sqlite'`）；`package.json`（无 `engines` 字段）；`.github/workflows/ci.yml:19`

`node:sqlite` 的可用性随 Node 版本变化：**22.5 – 22.12 需要 `--experimental-sqlite` 旗标**，否则 `import` 直接失败；**22.13+ 无需旗标**（只打 `ExperimentalWarning`）。

CI 的矩阵是 `node: [22, 24]`（`ci.yml:19`），`setup-node@v5` 装的是 22 的**最新 patch**（≥22.13）——所以**当前侥幸通过**。但 `package.json` 没有 `engines`，CI 也没有 `--experimental-sqlite` 兜底：任何人把矩阵降到 `22.0`、或在旧 22.x 上跑 `npm run test:panel`，都会直接崩。

**建议**：`package.json` 加 `"engines": { "node": ">=22.13" }`；`rebuild.ps1:76-84` 的 `Resolve-Node` 也应校验 Node 主版本（见 T30）。

### T27 · Suggestion — 缺 `pretest` 钩子，"忘记 build" 在本机也不会暴露

`package.json:87-97` 的 scripts 没有 `pretest`。开发者跑 `npm test` 时不会先编译，如果本地 `lib/` 是旧的，测试照样跑旧产物并全绿。

**建议**：加 `"pretest": "node scripts/build.mjs"`；或在 `test/run.mjs` 顶部断言 `lib/` 比 `src/` 新。这是把 T1/T2/T24 的"缺防线"变成"本地即暴露"的**最低成本**一招。

### T28 · Suggestion — 注释与实现漂移：`test/panel-routes.mjs` 说 "six JSON routes"，实际 8 条

**位置**：`test/panel-routes.mjs:3`（文件头注释）vs `:86-95`（`assert.deepEqual` 精确断言 8 条路由）

注释写的是 "the panel's **six** JSON routes"，实际注册了 8 条（`history` 是 `patched.12` 新增的）。断言本身是对的（用的是集合相等），只有注释过期了。同一类漂移还有 `CHANGELOG.md:21` / `README.md:238` 的 "39 assertions"（实测 60）。

### T29 · Suggestion — 手写 tar 的两处边界未处理

**位置**：`scripts/pack.mjs:91-94`、`:43`、`:111-112`

- `:91-94` 只检查 ustar 的 **100 字节名长上限**，**未检查 `prefix` 字段**（ustar 支持用 155 字节前缀拆分长路径）。当前路径不深所以无碍，但既然是手写 tar，建议加一条"路径 > 100 字节且无法用 prefix 表达 → exit 1"的显式断言。
- `:111-112` 用 `gzipSync(level 9)` —— gzip 头含 **mtime 字段**，虽默认写 0（可复现），建议显式 `{ level: 9, mtime: 0 }`，以免 Node 版本行为变化导致"字节一致的包"不再一致。

### T30 · Suggestion — `rebuild.ps1` 解析 Node 运行时时不校验版本

**位置**：`rebuild.ps1:76-84`

`Resolve-Node` 依次尝试 `$env:DSH_NODE` → `%USERPROFILE%\.dsh\dsh-runtimes\…` → PATH。若 `DSH_NODE` 指向的 Node 过旧（如 < 22.13），`node:sqlite` 相关测试会失败且报错难懂。建议校验 Node 主版本并给出明确提示（与 T26 配套）。

### T31 · Suggestion — `test/panel-client.mjs` 用正则抽路径 + 文本断言，口径偏松

**位置**：`test/panel-client.mjs:21-22`、`:117-123`

- `:117` 用 `/post\('(\/[a-z-]+)'/g` 从**源码文本**里抽取客户端请求路径——**只认小写 + 连字符**，含大写或下划线的路径会被漏掉；`:119` 只断言 `clientPaths.length >= 6`（**下限**，宽松）。
- `:21-22` 读源码文本做正则比对，属于"文本断言"而非"行为断言"——源码里改个空格可能假失败，换个写法可能假绿。

**建议**：改为运行时注册路由后取真实路径集合，与客户端实际请求的端点做**集合相等**断言。

### T32 · Suggestion — 每个用例固定等待 150 ms，约 3.6 s 的纯开销

**位置**：`test/run.mjs:58`

```js
await new Promise((r) => setTimeout(r, 150))   // 每个用例的 finally 里
```

24 个用例 ≈ 3.6 s 固定等待。改成"只在确有子进程存活的用例里等待"可以省掉这 3.6 s。

---

## 七、实证复审记录

v1 是**纯静态审查**。v2 在本机做了三件事：**跑真实 agy 二进制**、**读真实会话数据库**、**读宿主 DSH webserver 的真实源码**，并让一个**独立的对抗式复核者**对 21 条结论逐条给出 CONFIRMED / REFUTED / UNVERIFIABLE 判定。

### 1. 复现方法

在 `scratch/` 下写了一个临时 Node 脚本（已删除；`scratch/` 本就被 gitignore），直接 `import` 仓库里**已提交的** `lib/*.js`：

- **面板路由**：假 `ctx`（`inject(names, cb) → cb({ webServer: { register(route){} } })`）+ 假 `req`（async iterator 吐 JSON body）+ 假 `res`（`writeHead` / `end`）驱动**真实的** `/api-agy/*` handler。
- **步骤表**：直接调用 `mergeStepInto` / `snapshotSteps`。
- **会话库**：直接调用 `modelFromDb` / `readConversationSummaries`，喂**真实**的 `%USERPROFILE%\.gemini\antigravity-cli\` 数据。

### 2. 实测数据（V1–V6）

| 编号 | 检验 | 结果 |
|---|---|---|
| V1 | 面板输出冻结（I2） | **成立**。注入 500 000 字符 → 第 1 次轮询 `text` 长度 409600 / `cursor` 409600 / `reset=false`；第 2 次 `since=409600` → `text` 长度 **0**、`reset=false`；再注入 100 000 字符，第 3 次仍是 **0** → 新输出**永远送不到客户端** |
| V2 | 步骤表无上限（I7） | **成立**。`mergeStepInto` 合并 2000 步 → `steps.length === 2000`（`MAX_STEPS = 200`）；常驻 ≈ **1.35 MB**、耗时 **53.6 ms**；`snapshotSteps` 只裁返回值 |
| V3 | 重复归一化改写数据（I8 / S1） | **成立**。同一 step 连拍三次，正文尾部依次为 `…(+904 chars)` → `…(+13 chars)` → `…(+12 chars)`；工具预览 `…(+1962 chars)` → `…(+48 chars)`。**每次快照都在改写已截断文本** |
| V4 | 整库读入内存（S37） | **代码属实，但影响被夸大**。真实目录 **114 个 `.db` / 合计 56.8 MB**，单文件最大 **3.1 MB** → `modelFromDb` **2.8 ms**、rss Δ 6.07 MB；**冷缓存扫完 114 个 = 599.7 ms 同步阻塞、rss Δ +53.11 MB**；二次（命中 `MODEL_CACHE`）12.2 ms |
| V5 | Go 时间戳解析（v1 I8） | **不成立**。真实时间戳 `"2026-10-22 10:52:42.098176+00:00"`，插件 `parseTime`（`replace(' ','T')` + `new Date()`）解析**完全正确**（毫秒值 1792666362098）；**自带 `+00:00` 时区**，不存在偏 8 小时；112 行全部读出，仅 3 条 Go 零时间 `"0001-01-01 00:00:00+00:00"` → `null`（本就应过滤）；readOnly 打开成功 |
| V6 | 会话 id 穿越（I1） | **可达性窄于描述**。真实 id 是 UUID（`052cd09e-16eb-40e4-a97d-da8c9ff93423`），匹配 `agy-history.ts:424` 的白名单；`modelFromDb('..\\..\\..\\..\\AppData\\Local\\agy\\bin\\agy')` 返回 `null` —— 目标名必须以 `.db` 结尾才落地。仍缺统一校验，但属**纵深防御**缺口 |

### 3. 宿主 webserver 源码核验（决定 C1 的定性）

解包后的宿主文件：`artifacts/asar/_asar_out/dsh__node_modules__@deepseek-ai__dsh-host-webserver__lib__index.js`（21 436 B）。

- 对 `origin|csrf|sec-fetch|referer|x-forwarded|authorization` 做大小写不敏感检索，**只命中 5 处**：一条注释、`@returns the origin` 注释、`getOrigin()`、一处 `throw`、`register(route)` —— **没有任何鉴权或 Origin 校验**。
- 请求分发（`:378-394`）：

  ```js
  const rawPath = new URL(req.url ?? "/", "http://x").pathname;
  const route = this.match(rawPath);
  if (route !== void 0) { await route.handler(req, res); return; }
  ```

  → **纯按路径匹配**；socket 到插件 handler 之间只有 gzip 中间件。
- `register(route)`（`:326-333`）只做路径去重与重名抛错。
- 但宿主的 `Config`（`:251-266`）**拒绝绑定通配地址**（注释原文：*"binding every interface would expose remote code execution to the network"*）→ 默认只绑 `127.0.0.1`。这是 C1 的重要边界条件。

**结论**：C1 的服务端前提完全成立 —— **插件侧与宿主侧都没有防护**，且插件默认以 `--dangerously-skip-permissions` 启动、不加 `--sandbox`。

### 4. 真实 agy 协议样本

本机 agy **未登录**，因此直接跑 `agy --print "…" --output-format stream-json --print-timeout 120s` 得到的是**认证失败**形状：

```json
{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
```

stderr：`Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?…` → `Waiting for authentication (timeout 60s)...` → `Error: authentication timed out.`

独立复核者另外取得了一份**真实成功运行**（agy v1.4.8）的 stream-json 输出：

```json
{"event":"init","conversation_id":"932c24f1-…", …}
{"event":"result","result":{"conversation_id":"932c24f1-…","status":"SUCCESS","response":"…","duration_seconds":5.008479, …}}
```

→ **`init` 与 `result` 事件都携带 `conversation_id`**，插件前台从内层 `result` 取 id 是正确的。**v1 的 C1 被证伪。**

另：`agy --help` 的子命令列表为 `agent / agents / changelog / help / install / mcp / mic-serve / models / plugin / plugins / remote-control / update` —— **没有 `login`**，也**没有任何 API key 开关**。

### 5. 独立对抗式复核的结果（21 条）

| 判定 | 条目 |
|---|---|
| **REFUTED（3）** | v1 C1（真实协议证伪）、v1 I8（真实时间戳证伪）、v1 I13（定性错误：标准安全收窄，不是绕过类型检查；且是 6 处不是 7 处） |
| **CONFIRMED 但影响夸大（1）** | v1 I11（见 V4） |
| **CONFIRMED（17）** | v1 I1、I3、I4、I5、I6、I7、I9、I10、I12、I14、I15、T1、T2、T10、T11、T12、T24 |
| **新发现** | `src/index.ts:100` 的未锚定相对路径；`src/client.js:514` 的 reset 分支是死代码 |

---

## 八、修复优先级建议

| 优先级 | 条目 | 理由 |
|---|---|---|
| **P0** | C1、I1、I2 | C1 是唯一真正的安全问题（跨站 → 本机 agent 等价命令执行，**插件与宿主两端都无防护**）；I1 是路径穿越的纵深防御缺口；I2 让长任务在 400 KB 后完全不可用。三条改动量都很小，收益最大。 |
| **P1** | I3、I4、I5、I7、I8、I9、T1、T2、T11、T12、T24 | 影响证据留存（I3）、并发正确性（I4）、协议一致性（I5）、资源上界（I7 / I8）、缓存正确性（I9）；T1 / T2 / T24 是"改完源码发不出去"的三环；T11 / T12 是测试自身的假绿。 |
| **P2** | I6、I10、I11、T3、T8、T10、T13、T14、T15、T26 | 跨平台可用性（I6）、临时目录泄漏（I10）、无效提示（I11）、自检误报（T3）、CI 覆盖面（T8）、发布入口可用性（T10）、文档漂移（T13）、类型降级（T14）、产物残留（T15）、Node 版本下限（T26）。 |
| **P3** | S1–S38 + T4 / T5 / T6 / T7 / T9 / T16–T23 / T25 / T27–T32 | 一致性与文档层面，可择机清理。**其中 S37（会话列表冷扫 600 ms）与 S19（请求体超限应返 413 / 400）性价比略高，可以插队**。 |

**如果只做三件事**（改动都很小，收益最大）：

1. **给面板路由补上跨站防护** —— `readJsonBody` 校验 `Content-Type` 必须为 `application/json`（否则 415）、`jsonRoute` 校验 `Origin` 必须是本机（否则 403），并把 `src/agy-panel.ts:5-8` 那句"JSON content type 让跨站表单进不来"的注释改成与实现一致。这一条直接消除 C1（**成本最低、收益最高**）。
2. **收口信任边界** —— 新增 `isSafeConversationId()` 统一校验（消掉 I1），并把面板路由的 body 一律当 `unknown`、用统一的 `readString` / `readBool` 取值（消掉 S38）。两处都是"一次性加一个工具函数"，风险低。
3. **修面板输出冻结 + 步骤归一化连环 bug** —— 服务端加 `textResetPending`（I2）、`snapshotSteps` 去掉重复 `normalizeStep`（I8）、`truncate` 改幂等（S1）。改动约 10 行，直接决定长任务能不能用。

**再多做一件事（投入产出比最高）**：在 `package.json` 加 `"pretest": "node scripts/build.mjs"`（T27）。这一行同时缓解 T1、T2、T24 三条——"忘记 build"从"静默发错版本"变成"本机立刻报错"。

> 说明：v1 把"follow-up 可能静默失效"（v1 C1）列为 P0，实测已证伪，已从 P0 移除；原 P0 里的"跨站"（v1 I1）升级为 C1 重新进入 P0。

---

## 九、正面结论

这份报告列出 23 条 Important，但**通篇没有发现"偷工减料"式的实现**。以下是可以明确称为优秀的地方：

### 架构与安全

- **安全基线扎实**：argv 传参不经 shell；子进程环境由宿主 `scrubbedParentEnv()` 统一清洗；`--add-dir` 强校验（绝对路径 + 存在性 + 目录性）；面板不能指定任意工作目录；registry 原子写 + 损坏自愈（`.corrupt` 备份 + mtime 守卫）；SQL 全部常量、无注入面；`scripts/pack.mjs` 的 `EXCLUDE` 明确排除 `node_modules|test|scripts|.git` 与所有 `.js.map`（实测最新 tgz 清单干净，无开发文件泄漏）。
- **注释即文档**：大量非显然决策都写明了"为什么"和历史回归（例如 `init` 事件的解析修复、`Cannot access 'transcriptPath' before initialization` 的 TDZ 回归、第 9 版白屏 `module is not defined`）。这是本次审查能快速定位到 C1 根因的直接原因——`src/index.ts:696-698` 的注释原文就是最强证据。

### 测试

- **断言强度高**：逐条检查 93 + 60 条断言，**没有发现"只断言非空 / 只断言 truthy"的敷衍写法**。全部是精确值、正则、集合相等或状态码断言（例如 job id 匹配 `/^antigravity-[0-9a-f]{16}$/`、`--print-timeout` 形如 `/^\d+(ms|s|m|h)$/`、错误信息匹配 `/result|finished|exited/i`）。
- **失败路径被认真测了**：无 result 事件不得静默成功、exit 1 必须抛、鉴权错误文案、挂死必须超时且 `elapsed < 25s`、取消必须报告为 cancel、schema 越界字段必须被拒——这些是最容易漏测也最会出事的路径。
- **边界条件真实**：多字节字符被从中间切开、最后一行没有换行、上游下发未知事件——都是真实协议里会遇到的情况。
- **用例隔离干净**：每例独立 `mkdtempSync` workdir + transcriptDir、`FAKE_AGY_SCENARIO` 保存/还原、registry 与 flag cache 都钉在 workdir 内（`harness.mjs:75-81` 注释明确说明"否则会泄漏进开发者真实的 DSH home"）、`finally` 里 dispose + 等待 + `terminateAll()` + cleanup。
- **基础设施可信**：`test/harness.mjs:91-101` 的 jobs service 桩忠实还原了 `@deepseek-ai/dsh-jobs-local` 的契约（id 形状、`done` 解析、`kill → hooks.cancel`、字节偏移语义），且 `:196-207` 还特意在 settle 前 drain `readOutput` 到 ring 并注释"这曾是该 stub 的失败模式"——**有教训沉淀的测试基础设施**。
- `test/harness.mjs:363-403` 的 `assertOutputSchema` 手写 JSON Schema 子集校验器，**方言与插件自身完全一致**；`callTool`（`:407-421`）在 `execute` 之后强制校验——抓的是"直接调 `execute()` 完全看不到"的失败模式。

### 构建与发布

- **`scripts/build.mjs:93-135` 的客户端 bundle 自检写得非常到位** —— 用 `node:vm` `runInNewContext` 以**经典脚本**方式求值 `lib/client.js`，断言它经 `window.__ModuleLoader__` 注册、`id === pkg.name`、factory 返回 `{name, inject, apply}`、且只允许 `require('react')`。这正是 `patched.9` 白屏事故（`web boot: 1 entry did not activate`）的**精准回归守卫**，而且让构建期就 fail fast，而不是等用户启动 DSH 才发现。
- **`scripts/build.mjs:46-65` 的 `peerTypesResolve()` 探针考虑非常周全**：同时对付"package.json 谎报 types"和"`.d.ts` 是 11 字节 `export {}` 空洞"两种伪装，用 `MIN_USEFUL_BYTES = 32` 区分。
- **`scripts/pack.mjs` 是本仓库最扎实的部分**：手写确定性 tar —— 路径排序 + 目录先于内容、固定 mtime（`499162500`）、ustar magic 与 checksum、512 字节对齐 padding 与双零块结尾、100 字节名长显式检查并 exit 1、输出 sha256。**相同源码产出字节一致的包**，可 diff。
- **`rebuild.ps1` 的脚本安全性合格**：`ErrorActionPreference='Stop'` + `Set-StrictMode -Version Latest`；`$OutDir` 经 `Resolve-Path` 规范化；覆盖前用 `Remove-Item -LiteralPath`（非通配符）；临时目录用 `guid8` 避免冲突；`-OutDir` 默认是**父目录**而非插件目录本身，删除操作不会触及仓库内容。
- **CI 的矩阵选择有依据**：`.github/workflows/ci.yml:16-17` 的注释解释了 Windows 不可省的原因（插件经 `cmd.exe` 启动 agy、进程树终止路径是 Windows 特有的），不是随手抄的。

### 可维护性

- **纯函数与 IO 分离好**：`parseUsage` / `parseModels` / `pickDeepestFlash` / `parseStepUpdate` 都能脱离 agy 单测。
- **错误处理普遍做到"不抛出、返回可渲染状态"**——面板任何一条数据源挂了都能降级显示而不是让宿主崩掉。
- **文档完整**：中英双语 README + 配置表与实现基本一致（本次仅发现 `ANTIGRAVITY_API_KEY`、安装包名、版本号三处漂移，见 I11 与 T13）。

> 备注：本报告为**只读审查**，未修改任何插件文件；`AUDIT-report.md` 为本次新增的未跟踪文件。
