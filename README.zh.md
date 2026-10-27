# @dsh-external/dsh-subagent-antigravity

[![ci](https://github.com/mojingjing-git/dsh-subagent-agy/actions/workflows/ci.yml/badge.svg)](https://github.com/mojingjing-git/dsh-subagent-agy/actions/workflows/ci.yml)

把任务直接委托给本机的 **Google Antigravity CLI（`agy`）**——一个独立的
Gemini 编程智能体——从 DeepSeek Harness 里直接使用。**不需要任何 API key**：
agy 使用你的 Antigravity 登录态（系统凭据 / Google 登录）完成认证。

> English version: [README.md](README.md) · 源码: [github.com/mojingjing-git/dsh-subagent-agy](https://github.com/mojingjing-git/dsh-subagent-agy)
>
> **本项目是 fork。** 上游是 ZEM17 的 [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy)
> （`@dsh-external/dsh-subagent-antigravity@0.2.0`，MIT）。本 fork 增加了 DSH
> 0.2.1-rc.2 兼容、每次运行的完整轨迹、agy 1.4.x 支持、侧边栏面板，以及下方描述的
> 测试套件——全部改动及原因见 [PATCH.md](PATCH.md)。当前版本 `0.2.0-patched.9`。

---

## 安装

### 前置要求

1. **安装 `agy`**：`irm https://antigravity.google/cli/install.ps1 | iex`
   （Windows）。插件会自动定位它（PATH → `AGY_BIN` → `%LOCALAPPDATA%\agy\bin`
   → `~/.local/bin` → `~/.gemini/bin` → `~/go/bin`）。
2. **登录一次 `agy`**：在终端运行 `agy` 完成登录。之后如果遇到
   "authentication required"，插件会自动弹出交互式登录窗口。
3. **DeepSeek Harness**：标准 web profile 即可（自带 `dsh-subagent`、
   `dsh-subprocess`、`dsh-tools`、`dsh-jobs`）。

### 安装插件

**从 GitHub 安装**（推荐）：

```bash
dsh plugin --profile web add github:mojingjing-git/dsh-subagent-agy
```

**从安装包安装**：到
[Releases 页面](https://github.com/mojingjing-git/dsh-subagent-agy/releases) 下载
`dsh-external-dsh-subagent-antigravity-0.2.0.tgz`，然后：

```bash
dsh plugin --profile web add /path/to/dsh-external-dsh-subagent-antigravity-0.1.0.tgz
```

工具装完即用（任何会话里的模型都能调用 `antigravity` 系列）。**侧边栏面板是
web client 扩展，需要重启一次 DSH 才会出现**；升级安装包后同样要重启，
因为旧版本的 client bundle 已被加载进页面。

---

## 使用方法

你只需要提需求，模型会自动调用工具；也可以明确指定：

| 用途 | 工具 | 说明 |
|---|---|---|
| 新任务 | `antigravity` | 把独立任务委托给 agy（新对话）；返回 `task` 键 |
| 续聊 | `antigravity_followup` | 通过 `task` 键继续之前的 agy 对话——上下文完整延续 |
| 任务列表 | `antigravity_tasks` | 列出运行中 + 最近完成的任务；`task` 键在 DSH 重启后仍然有效 |
| 取消任务 | `antigravity_cancel` | 用 `task` 键停止一个运行中的任务（终止 agy 进程树） |
| 登录 | `antigravity_login` | 弹出 agy 交互式登录窗口（认证失败时也会自动弹出） |

示例：

> "用 agy 把 `D:\projects\my-project` 的 README 重写一遍，列出改动。"
>
> "用 antigravity 优化这个项目的页面"

### 识图

agy 的模型是多模态的——把图片路径写进 prompt，它就能描述/分析图片：

> "用 antigravity 识别这张图片：`C:\projects\screenshots\ui.png`"
>
> "Use agy to describe this image: `C:\projects\design\mockup.png`"

工作区内的图片直接可用；工作区之外的图片，需要把图片所在目录传给工具的
`dirs` 参数（或配置 `addDirs`）。

- **任务目标在会话工作区之外**时，需要把目标目录传给工具的 `dirs` 参数
  （你把路径告诉模型，它会自动带上）。
- **长任务**：模型会自动用 `background: true` 后台运行——期间向你实时汇报
  进度，完成后给出最终结果。
- **继续之前的任务**：告诉模型用上次返回的 `task` 键续聊。
- **找回任务键**：`antigravity_tasks` 列出运行中和最近完成的任务——任务键
  记录在 `~/.dsh/agy-conversations.json`，DSH 重启后依然存在，随时可以找回
  用于续聊。
- **停止任务**：用运行中任务的键调用 `antigravity_cancel`（后台任务也可用
  `job_kill`）。

### 侧边栏面板

侧边栏底部有一个 **Antigravity Manager** 按钮：`●N` 是正在运行的任务数，右侧百分比是**当前配置
模型所属族**的五小时剩余额度（悬停可看重置时间）。点击它会在右栏打开 **Antigravity
Manager** 标签页：

- **四张额度卡**：直接取 `agy --print "/usage"` 的输出，按「Gemini Models /
  Claude and GPT models」× 「五小时 / 每周」排列，带重置时间。一次查询约 10 秒，
  所以结果缓存 5 分钟（单飞，多个面板不会各拉起一个 agy）；卡片上的「刷新额度」
  可强制刷新。
- **会话列表**：只列**经本插件跑过**的对话（`~/.dsh/agy-conversations.json`），
  显示标题、时间、目录、模型与运行状态；插件自己的测试记录会被过滤掉。
- **接着跑**：点某一行的「接着跑」，在行内输入新指令并发送，输出显示在面板**底部
  的独立输出区**（不挤占列表），逐字流式追加；可随时「停止」。同一会话的续跑是
  串行的，不会两条指令同时打进一个 agy 对话。
- **步骤时间线**：点开会话后，列表上方显示这个会话**具体做了什么**——谁说了什么、
  模型调了哪个工具、传了什么参数、哪一步失败了。数据来自 agy 自己的
  `~/.gemini/antigravity-cli/conversations/<id>.db`（`steps` 表按 `idx` 排序，
  `gen_metadata` 存回复正文），所以**已经跑完**的会话也看得到步骤，不只是正在跑的
  那些。agy 并非对每个会话都保存回复正文：工具调用和用户输入始终有，回复正文只
  在部分会话里有，缺失时时间线会如实标注「该会话没有保存回复正文」，而不是显示
  一个空气泡。

面板读取的是本地注册表，所以 DSH 重启后历史会话仍可继续；agy 未安装或未登录时，
额度区会显示空态而不是报错。

---

## 配置

所有字段都可选，默认值见下表。通过插件的设置区配置（如
`$DSH_HOME/settings.yaml`）：

```yaml
dsh-subagent-antigravity:
  model: auto                  # auto = 自动选最新的 Gemini Flash 最高档；留空 = agy 默认
  effort: high                 # low | medium | high | xhigh | max
  printTimeoutMs: 300000       # 前台任务上限（5 分钟）
  backgroundTimeoutMs: 3600000 # 后台任务上限（1 小时）
  skipPermissions: true        # 自动批准 agy 的工具调用（无头模式必需）
  addDirs: []                  # 加入 agy 工作区的绝对路径（--add-dir）
  proxy: ""                    # 代理 URL；回退到 AGY_PROXY 环境变量，再回退 ~/.dsh/agy-proxy.txt
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `antigravity` | `ctx.subagents` 注册名 |
| `toolName` | `antigravity` | 新任务工具名 |
| `followupToolName` | `antigravity_followup` | 续聊工具名 |
| `loginToolName` | `antigravity_login` | 登录窗口工具名 |
| `tasksToolName` | `antigravity_tasks` | 任务列表工具名 |
| `cancelToolName` | `antigravity_cancel` | 取消任务工具名 |
| `command` | `agy` | 可执行文件（PATH 名或绝对路径） |
| `model` | `''` | `--model <slug>`（见 `agy models`）；`auto` = 探测 `agy models`，取最新 Gemini Flash 的最高思考档（24h 缓存）；留空 = agy 默认 |
| `effort` | `''` | `--effort low\|medium\|high\|xhigh\|max`；留空 = 不传 |
| `agent` | `''` | `--agent <name>`；留空 = 不传 |
| `printTimeoutMs` | `300000` | 前台任务上限（`--print-timeout`；插件会探测本机 agy 是否要求带单位） |
| `backgroundTimeoutMs` | `3600000` | 后台任务上限（1 小时） |
| `watchdogMarginMs` | `60000` | agy 卡死时、超时上限之外强制终止的余量 |
| `skipPermissions` | `true` | `--dangerously-skip-permissions`（自动批准 agy 工具调用） |
| `sandbox` | `false` | `--sandbox`（agy 终端沙箱限制） |
| `avoidBrowser` | `true` | 在 prompt 中追加"不要用浏览器工具"说明（部分机器上无头浏览器会卡死） |
| `avoidLargeReads` | `true` | 在 prompt 中追加"超过 1 MB 的文件用 grep/sed 读取"说明（agy 读取工具有 4 MB 上限） |
| `transcript` | `true` | 每次运行把 agy 完整事件流（提示词 + 每次工具调用 + 最终结果）写入 `transcriptDir` |
| `transcriptDir` | `''` | 轨迹目录；留空 = `~/.dsh/agy-transcripts` |
| `flagCachePath` | `''` | `agy help` 参数探测结果的缓存位置；不配 = `~/.dsh/agy-flag-cache.json`，显式传空串则关闭缓存 |
| `outputFormat` | `json` | 输出格式（`json` 或 `text`）；后台模式自动优先 `stream-json` |
| `extraArgs` | `[]` | 追加在生成参数之后的原始 argv |
| `cwd` | `''` | 工作目录覆盖；留空 = 会话工作区 |
| `addDirs` | `[]` | 加入 agy 工作区的绝对路径（`--add-dir`）——目标在会话工作区之外时必需 |
| `env` | `{}` | 环境变量覆盖（在 Harness 凭据清理之后合并） |
| `proxy` | `''` | 代理 URL；回退 `AGY_PROXY`，再回退 `~/.dsh/agy-proxy.txt`（每次调用重读） |
| `registryPath` | `''` | 续聊注册表文件；留空 = `~/.dsh/agy-conversations.json` |
| `disposeGraceMs` | `5000` | 进程树终止宽限（SIGTERM → SIGKILL） |
| `autoLoginWindow` | `true` | 认证失败时自动弹出交互式登录窗口 |
| `loginWindowMinimized` | `true` | 登录窗口最小化启动（只在任务栏显示图标） |

---

## 工作原理（简述）

每次任务都会在会话工作区里拉起一个全新的 `agy -p <任务>` 进程，返回最终
回答。运行使用 `--output-format json`，其回复携带 agy 的
`conversation_id`；插件把它记入持久化注册表（`~/.dsh/agy-conversations.json`），
`antigravity_followup` 通过 `--conversation <id>` 恢复同一对话。后台运行
使用 `stream-json` 提供实时进度，并接入 DSH 的任务系统（`job_output` /
`job_kill`）。本地看门狗会终止卡死的运行——**任何情况下都不会无限等待**。

`antigravity_tasks` 展示持久注册表（重启安全）和实时运行中的任务，
`antigravity_cancel` 可以停止某个运行中的任务。注册表自带自愈：损坏的
文件会先备份一次（`*.corrupt`）再重置，绝不会被静默覆盖；所有注册表
写入都是串行化的，并发运行不会互相丢失记录。

侧边栏面板由两部分组成：host 侧在 `webServer` 可用后注册 `/api-agy/*` 的 JSON
路由（额度、会话、运行中任务、续跑、停止），client 侧是一个独立的
`lib/client.js`（通过 `exports["./client"]` + `dsh.client` 声明）。面板里的
「接着跑」复用了插件的后台运行通道：`--output-format stream-json` 的
`text_delta` 事件被逐行解析后供前端轮询追加，因此面板关掉、页面刷新都不会
丢输出——真正在跑的是 host 侧的 agy 进程。

---

## 故障排查

| 现象 | 解决办法 |
|---|---|
| `authentication required` | 在自动弹出的登录窗口里完成登录（或调用 `antigravity_login`），然后重试 |
| `User location is not supported` | 配置代理（`proxy` 或 `~/.dsh/agy-proxy.txt`） |
| `timeout waiting for response` | 调大 `printTimeoutMs` / `backgroundTimeoutMs`，或改用 `background: true` |
| `agy exited 0 but produced no stdout` | 已知的 agy 非 TTY 输出丢失 bug；默认的 `--output-format json` 可规避——仍出现就升级 agy |
| `cannot resolve "agy"` | 设置 `AGY_BIN` 指向 agy 可执行文件 |
| 任务卡在浏览器工具上 | `avoidBrowser`（默认开启）已阻止；确实需要浏览器预览时才设 `false` |
| `file size (…) exceeds limit` | agy 读取工具上限 4 MB；`avoidLargeReads`（默认开启）已让 agy 改用 grep/sed——或瘦身该文件 |
| 注册表损坏 | 插件会把损坏的文件备份一次到 `*.corrupt` 再重置注册表——历史记录绝不会被静默覆盖 |
| 侧边栏没有 **Antigravity Manager** 按钮 | client 扩展只在启动时加载：重启 DSH；仍没有就确认安装的包里含 `lib/client.js`（`patched.9` 起） |
| 面板里额度一直「读取中」 | 首次探测 `agy /usage` 约 10 秒；超过 30 秒检查 `agy` 是否可执行、是否已登录 |
| 面板会话列表为空 | 列表只含本插件跑过的会话；先用 `antigravity` 工具跑一次（注册表在 `~/.dsh/agy-conversations.json`） |

---

## 开发

```bash
npm run build        # tsc 编译 src/ → lib/，并复制、校验 client bundle
npm test             # 93 条离线断言（模拟 agy）
npm run test:panel   # 39 条：数据源、host 路由、流式续跑、client 契约、model: auto
npm run test:e2e     # 真实双轮对话（需要已登录 agy）
npm run pack         # 打 tgz，供 `dsh plugin add`
```

本地 DSH 开发流程（超级模组注入器）：`dev_build_plugin`（构建+打包）→
`dev_inject_plugin`（免重启运行时注入）；日常迭代用 `dev_build_plugin` →
`dev_reload_package`。
