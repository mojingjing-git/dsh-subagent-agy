/* global window, fetch, setInterval, clearInterval, setTimeout, clearTimeout */
/**
 * lib/client.js — the AGY sidebar entry and panel.
 *
 * Plain bundle (no build step beyond a copy) in the same UMD shape DSH's web
 * loader expects: `window.__ModuleLoader__.load({ id, factory })`, React via
 * `require("react")`.
 *
 * Two slots, both registered through `ctx.slots.inject` — a bare
 * `slots.register` races the shell's slot declaration and blanks the renderer:
 *
 *   sidebar.footer.action  → AGY button with the running count + quota badge
 *   sidebar.right.pane.tab → the panel itself (keyed by the `agy` tab type)
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-subagent-antigravity',
  factory: (require) => {
    // DSH 的 web loader 在浏览器环境里执行这个 factory，没有 CommonJS 全局变量。
    // 这三行是 DSH web bundle 约定的 UMD 外壳，缺少它 factory 会抛
    // "ReferenceError: module is not defined"，插件条目无法激活，web boot 失败。
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const TAB_TYPE = 'agy'
    const API = '/api-agy'

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      dimmer: 'var(--dsw-alias-label-tertiary)',
      card: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
      field: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l2)',
      accent: 'var(--dsw-alias-brand-primary)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
      danger: 'var(--dsw-alias-state-error-primary, #ef4444)',
    }

    async function post(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        /* non-JSON error page */
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${response.status}`)
      }
      return payload
    }

    const familyLabel = (family) => {
      if (typeof family !== 'string') return '—'
      if (family.indexOf('Gemini') >= 0) return 'Gemini'
      if (family.indexOf('Claude') >= 0) return 'Claude / GPT'
      return family
    }
    const windowLabel = (window) => {
      if (typeof window !== 'string') return '—'
      if (window.indexOf('Weekly') >= 0) return '周额度'
      if (window.indexOf('Five') >= 0) return '5 小时'
      return window
    }
    const percentColor = (percent) => {
      if (typeof percent !== 'number') return C.dimmer
      if (percent <= 10) return C.danger
      if (percent <= 30) return 'var(--dsw-alias-state-warning-primary, #f59e0b)'
      return C.success
    }
    const resetText = (value) => {
      if (typeof value !== 'string' || value.length === 0) return ''
      const at = new Date(value)
      return Number.isNaN(at.getTime()) ? value : at.toLocaleString()
    }
    const shortCwd = (cwd) => {
      if (typeof cwd !== 'string' || cwd.length === 0) return '—'
      const parts = cwd.split(/[\\/]/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : cwd
    }
    const shortTime = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      const now = new Date()
      const sameDay = date.toDateString() === now.toDateString()
      return sameDay
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
    }
    /** When the quota numbers were read — the probe itself takes about ten seconds. */
    const fetchedText = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString()
    }

    /** Module-level opener, re-resolved on every click (HMR may swap the service). */
    let openTab = () => false

    // ── footer ────────────────────────────────────────────────────────────────
    function AgyFooterButton() {
      const [running, setRunning] = useState(0)
      const [usage, setUsage] = useState(null)

      useEffect(() => {
        let alive = true
        const tick = () => {
          post('/running', {})
            .then((payload) => { if (alive) setRunning(payload.count) })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      useEffect(() => {
        let alive = true
        let timer
        const tick = () => {
          post('/usage', {})
            .then((payload) => {
              if (!alive) return
              setUsage(payload)
              // First probe of a cold cache takes ~10 s; the route answers with
              // `loading: true` and the poll picks the snapshot up when it lands.
              if (payload.loading) timer = setTimeout(tick, 2000)
            })
            .catch(() => {})
        }
        tick()
        const interval = setInterval(tick, 30000)
        return () => { alive = false; clearInterval(interval); clearTimeout(timer) }
      }, [])

      const badge = usage && usage.badge ? `${usage.badge.percent}%` : '—'
      const fetched = usage ? fetchedText(usage.fetchedAt) : null
      const title = usage && usage.badge
        ? `Antigravity Manager · ${usage.badge.family} · ${usage.badge.window} 剩余 ${usage.badge.percent}%${usage.badge.resetAt ? ` · 重置 ${resetText(usage.badge.resetAt)}` : ''}${fetched ? ` · 更新于 ${fetched}` : ''}${usage.stale ? '（缓存）' : ''}`
        : 'Antigravity Manager · 点击打开面板'

      return h(
        'button',
        {
          type: 'button',
          title,
          onClick: () => { openTab() },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            padding: '6px 8px',
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: C.text,
            cursor: 'pointer',
            fontSize: 12,
            textAlign: 'left',
          },
          onMouseEnter: (event) => { event.currentTarget.style.background = C.hover },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
        },
        h('span', { style: { fontWeight: 600, letterSpacing: '0.04em' } }, 'Antigravity Manager'),
        running > 0
          ? h('span', { style: { color: C.success, fontSize: 11 } }, `●${running}`)
          : null,
        h('span', { style: { marginLeft: 'auto', color: C.dim, fontSize: 11 } }, badge),
      )
    }

    // ── panel ─────────────────────────────────────────────────────────────────
    function UsageCards({ usage, onRefresh, refreshing }) {
      const rows = usage && Array.isArray(usage.rows) ? usage.rows : []
      return h(
        'div',
        { style: { padding: '10px 12px 8px', borderBottom: `1px solid ${C.border}` } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, '额度'),
          usage && usage.stale ? h('span', { style: { fontSize: 10, color: C.dimmer } }, '缓存') : null,
          usage && usage.loading ? h('span', { style: { fontSize: 10, color: C.dimmer } }, '读取中…') : null,
          usage && fetchedText(usage.fetchedAt)
            ? h('span', { style: { fontSize: 10, color: C.dimmer } }, `更新于 ${fetchedText(usage.fetchedAt)}`)
            : null,
          h('button', {
            type: 'button',
            title: '刷新额度',
            onClick: onRefresh,
            disabled: refreshing,
            style: { marginLeft: 'auto', border: 'none', background: 'transparent', color: C.dim, cursor: 'pointer', fontSize: 11 },
          }, refreshing ? '刷新中…' : '刷新'),
        ),
        usage && usage.error
          ? h('div', { style: { fontSize: 10, color: C.danger, marginBottom: 6 } }, `读取失败：${usage.error}`)
          : null,
        rows.length === 0
          ? h('div', { style: { fontSize: 11, color: C.dimmer, padding: '6px 0' } }, usage && usage.loading ? '首次读取约需 10 秒…' : '暂无额度数据')
          : h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
            rows.map((row) => h(
              'div',
              {
                key: `${row.family}|${row.window}`,
                style: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 8px' },
              },
              h('div', { style: { fontSize: 10, color: C.dim } }, `${familyLabel(row.family)} · ${windowLabel(row.window)}`),
              h('div', { style: { fontSize: 18, fontWeight: 600, color: percentColor(row.percent), lineHeight: 1.2 } }, `${row.percent}%`),
              row.resetAt ? h('div', { style: { fontSize: 9, color: C.dimmer } }, `重置 ${resetText(row.resetAt)}`) : null,
            )),
          ),
      )
    }

    // ── history timeline ──────────────────────────────────────────────────────
    const STEP_LABEL = {
      user_input: '你',
      agent_response: '模型',
      tool: '工具',
      system_message: '系统',
    }

    const stepAccent = (step) => {
      if (step.state === 'ERROR') return C.danger
      if (step.type === 'tool') return 'var(--dsw-alias-state-warning-primary, #f59e0b)'
      if (step.type === 'agent_response') return C.accent
      return C.dim
    }

    /** The arguments of a tool call, one per line. */
    function ToolDetail({ tool }) {
      if (!tool) return null
      const parameters = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : null
      const entries = parameters ? Object.entries(parameters) : []
      return h(
        'div',
        { style: { marginTop: 3, fontSize: 10, color: C.dim } },
        h('div', { style: { fontWeight: 600 } }, tool.name || '未知工具'),
        tool.error ? h('div', { style: { color: C.danger } }, tool.error) : null,
        entries.length > 0
          ? h(
              'pre',
              {
                style: {
                  margin: '3px 0 0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 10,
                  lineHeight: 1.4,
                  color: C.dim,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                },
              },
              entries
                .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
                .join('\n'),
            )
          : null,
      )
    }

    /** Is this only the name of the model that answered? */
    const MODEL_NAME_ONLY = /^(gemini|claude|gpt|qwen|deepseek|o[34])[\w .()+-]{0,48}$/i
    const looksLikeModelName = (text) => {
      const clean = typeof text === 'string' ? text.trim() : ''
      if (clean.length === 0) return true
      return MODEL_NAME_ONLY.test(clean)
    }

    /** 12345 → "12.3k" */
    const formatTokens = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
      return String(value)
    }

    /** The wall clock of a step, as agy recorded it. */
    const clockOf = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return null
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** One step of the timeline. */
    function StepRow({ step }) {
      const label = STEP_LABEL[step.type] || step.type || '步骤'
      // agy does not keep the body of every reply; where it only kept the
      // model name, that name is not the answer.
      const body =
        step.type === 'agent_response' && looksLikeModelName(step.text) ? '' : step.text
      const hasText = typeof body === 'string' && body.trim().length > 0
      const clock = clockOf(step.at)
      const usage = step.usage && typeof step.usage === 'object' ? step.usage : null
      const tokenText = usage
        ? `入 ${formatTokens(usage.input_tokens)} · 出 ${formatTokens(usage.output_tokens)}`
        : null
      const thinking =
        typeof step.thinking === 'string' && step.thinking.trim().length > 0 && step.thinking !== body
          ? step.thinking
          : null
      const truncated =
        Array.isArray(step.truncated) && step.truncated.length > 0 ? step.truncated : null
      return h(
        'div',
        { style: { padding: '6px 0', borderBottom: `1px solid ${C.border}` } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          clock ? h('span', { style: { fontSize: 9, color: C.dimmer } }, clock) : null,
          h('span', { style: { fontSize: 10, fontWeight: 600, color: stepAccent(step) } }, label),
          h('span', { style: { fontSize: 9, color: C.dimmer } }, `#${step.index}`),
          step.state === 'ERROR' ? h('span', { style: { fontSize: 9, color: C.danger } }, '失败') : null,
          step.state === 'ACTIVE' ? h('span', { style: { fontSize: 9, color: C.success } }, '进行中') : null,
          tokenText
            ? h('span', { style: { marginLeft: 'auto', fontSize: 9, color: C.dimmer } }, tokenText)
            : null,
        ),
        hasText
          ? h(
              'div',
              {
                style: {
                  marginTop: 2,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: C.text,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              body,
            )
          : step.type === 'agent_response'
            ? h(
                'div',
                { style: { marginTop: 2, fontSize: 10, color: C.dimmer, fontStyle: 'italic' } },
                '（agy 没有保存这条回复的正文）',
              )
            : null,
        truncated
          ? h(
              'div',
              { style: { marginTop: 2, fontSize: 9, color: C.dimmer } },
              `（agy 截断了：${truncated.join('、')}）`,
            )
          : null,
        thinking
          ? h(
              'div',
              {
                style: {
                  marginTop: 2,
                  fontSize: 10,
                  lineHeight: 1.5,
                  color: C.dim,
                  fontStyle: 'italic',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              `思考：${thinking}`,
            )
          : null,
        h(ToolDetail, { tool: step.tool }),
      )
    }

    /**
     * The step timeline of the selected conversation.
     *
     * It answers the question the panel used to leave open: what did the model
     * actually do — which prompt it got, which tools it called, what it replied.
     */
    function HistoryTimeline({ history, loading, error, onRefresh }) {
      const steps = history && Array.isArray(history.steps) ? history.steps : []
      const hidden = history && typeof history.stepCount === 'number' ? history.stepCount - steps.length : 0
      return h(
        'div',
        { style: { fontSize: 11 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, '步骤时间线'),
          history
            ? h('span', { style: { fontSize: 10, color: C.dim } }, `${steps.length} 步${hidden > 0 ? `（另有 ${hidden} 步未显示）` : ''}`)
            : null,
          h(
            'button',
            {
              type: 'button',
              title: '重新读取历史步骤',
              onClick: onRefresh,
              disabled: loading,
              style: {
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                color: C.dim,
                cursor: loading ? 'default' : 'pointer',
                fontSize: 10,
                opacity: loading ? 0.5 : 1,
              },
            },
            loading ? '读取中…' : '刷新',
          ),
        ),
        error !== null ? h('div', { style: { color: C.danger, fontSize: 10 } }, `读取失败：${error}`) : null,
        history && history.totals
          ? h(
              'div',
              { style: { marginBottom: 5, fontSize: 10, color: C.dim } },
              `token 用量 · 输入 ${formatTokens(history.totals.inputTokens)} · 输出 ${formatTokens(history.totals.outputTokens)} · 缓存读 ${formatTokens(history.totals.cacheReadTokens)}`,
              h('span', { style: { color: C.dimmer } }, '（缓存读按折扣计费，不计入输入）'),
            )
          : null,
        loading && steps.length === 0
          ? h('div', { style: { color: C.dimmer, fontSize: 11 } }, '正在读取历史步骤…')
          : null,
        !loading && steps.length === 0 && error === null
          ? h(
              'div',
              { style: { color: C.dimmer, fontSize: 11 } },
              history && history.source === 'missing'
                ? '这个会话没有可读的数据库。'
                : '这个会话没有记录步骤。',
            )
          : null,
        steps.map((step) => h(StepRow, { key: step.index, step })),
      )
    }

    function ConversationRow({ item, selected, running, onSelect }) {
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onSelect(item.conversationId),
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            border: 'none',
            borderLeft: `2px solid ${selected ? C.accent : 'transparent'}`,
            background: selected ? C.hover : 'transparent',
            padding: '7px 10px',
            cursor: 'pointer',
            color: C.text,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          running ? h('span', { style: { color: C.success, fontSize: 9 } }, '●') : null,
          h('span', {
            style: { fontSize: 12, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: item.preview || item.label || '',
          }, item.label || item.conversationId.slice(0, 8)),
          h('span', { style: { fontSize: 10, color: C.dimmer, flex: 'none' } }, shortTime(item.lastActivityAt || item.createdAt)),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 } },
          h('span', {
            style: { fontSize: 10, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
            title: item.cwd,
          }, item.cwdExists ? shortCwd(item.cwd) : `${shortCwd(item.cwd)}（目录不存在）`),
          item.stepCount > 0
            ? h('span', { style: { fontSize: 9, color: C.dimmer, flex: 'none' } }, `${item.stepCount} 步`)
            : null,
          item.model
            ? h('span', {
              style: {
                fontSize: 9,
                color: C.dim,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                padding: '0 4px',
                flex: 'none',
              },
            }, item.model)
            : null,
        ),
      )
    }

    function AgyPanel() {
      const [items, setItems] = useState([])
      const [listError, setListError] = useState(null)
      const [usage, setUsage] = useState(null)
      const [refreshing, setRefreshing] = useState(false)
      const [active, setActive] = useState([])
      const [selected, setSelected] = useState(null)
      const [prompt, setPrompt] = useState('')
      const [run, setRun] = useState(null)
      const [sendError, setSendError] = useState(null)
      const [history, setHistory] = useState(null)
      const [historyLoading, setHistoryLoading] = useState(false)
      const [historyError, setHistoryError] = useState(null)
      const cursorRef = useRef(0)
      const outputRef = useRef(null)

      const loadConversations = useCallback(() => {
        post('/conversations', {})
          .then((payload) => { setItems(payload.items || []); setListError(null) })
          .catch((error) => setListError(error.message))
      }, [])

      /** Read the step timeline of one conversation back from agy's database. */
      const loadHistory = useCallback((conversationId) => {
        setHistoryLoading(true)
        setHistoryError(null)
        post('/history', { conversationId })
          .then((payload) => {
            setHistory({
              conversationId,
              steps: Array.isArray(payload.steps) ? payload.steps : [],
              stepCount: typeof payload.stepCount === 'number' ? payload.stepCount : 0,
              source: payload.source,
              totals: payload.totals && typeof payload.totals === 'object' ? payload.totals : null,
            })
          })
          .catch((error) => {
            setHistory(null)
            setHistoryError(error.message)
          })
          .finally(() => setHistoryLoading(false))
      }, [])

      const loadUsage = useCallback((force) => {
        setRefreshing(true)
        post('/usage', force ? { force: true } : {})
          .then((payload) => {
            setUsage(payload)
            if (payload.loading) setTimeout(() => loadUsage(false), 2500)
          })
          .catch(() => {})
          .finally(() => setRefreshing(false))
      }, [])

      useEffect(() => {
        loadConversations()
        loadUsage(false)
        const conversations = setInterval(loadConversations, 20000)
        const usageTimer = setInterval(() => loadUsage(false), 30000)
        return () => { clearInterval(conversations); clearInterval(usageTimer) }
      }, [loadConversations, loadUsage])

      useEffect(() => {
        let alive = true
        const tick = () => {
          post('/running', {})
            .then((payload) => { if (alive) setActive(payload.runs || []) })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      // One poller per run; the cursor lives in a ref so the interval is not
      // torn down and rebuilt on every delta.
      useEffect(() => {
        if (run === null || run.status !== 'running') return undefined
        const runId = run.id
        let alive = true
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
            .catch(() => {})
        }, 400)
        return () => { alive = false; clearInterval(timer) }
      }, [run === null ? null : run.id, run === null ? null : run.status])

      useEffect(() => {
        const node = outputRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [run === null ? '' : run.text])

      // A finished run wrote new steps into agy's database — pull them in so
      // the timeline shows what the run just did.
      useEffect(() => {
        if (run === null || run.status === 'running' || selected === null) return
        loadHistory(selected)
      }, [run === null ? null : run.status, selected, loadHistory])

      const busy = run !== null && run.status === 'running'
      const selectedItem = useMemo(
        () => items.find((item) => item.conversationId === selected) || null,
        [items, selected],
      )
      const runningLabels = useMemo(() => {
        const keys = new Set()
        for (const info of active) keys.add(`${info.cwd}|${info.label}`)
        return keys
      }, [active])

      const send = useCallback(() => {
        const text = prompt.trim()
        if (text.length === 0 || selected === null || busy) return
        setSendError(null)
        cursorRef.current = 0
        post('/continue', { conversationId: selected, prompt: text })
          .then((payload) => {
            setRun({ id: payload.runId, text: '', status: 'running', tool: null, error: undefined })
            setPrompt('')
            loadConversations()
          })
          .catch((error) => setSendError(error.message))
      }, [prompt, selected, busy, loadConversations])

      const stop = useCallback(() => {
        if (run === null) return
        post('/cancel', { runId: run.id }).catch(() => {})
        setRun((prev) => (prev === null ? prev : { ...prev, status: 'cancelled' }))
      }, [run])

      const statusText = run === null
        ? ''
        : run.status === 'running'
          ? (run.tool ? `正在调用 ${run.tool}` : '运行中…')
          : run.status === 'done'
            ? '完成'
            : run.status === 'cancelled'
              ? '已停止'
              : '失败'

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.text } },
        h(UsageCards, { usage, refreshing, onRefresh: () => loadUsage(true) }),

        h(
          'div',
          { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          selected === null
            ? null
            : h(
                'div',
                { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 4px' } },
                h(HistoryTimeline, {
                  history: history !== null && history.conversationId === selected ? history : null,
                  loading: historyLoading,
                  error: historyError,
                  onRefresh: () => loadHistory(selected),
                }),
              ),
          h(
            'div',
            {
              style: {
                flex: selected === null ? 1 : 'none',
                minHeight: 0,
                maxHeight: selected === null ? undefined : 168,
                overflowY: 'auto',
                padding: '6px 0',
                borderTop: selected === null ? 'none' : `1px solid ${C.border}`,
              },
            },
            listError !== null
              ? h('div', { style: { padding: 12, fontSize: 11, color: C.danger } }, `会话列表读取失败：${listError}`)
              : items.length === 0
                ? h('div', { style: { padding: 12, fontSize: 11, color: C.dimmer } }, '还没有经本插件运行过的会话。')
                : items.map((item) => h(ConversationRow, {
                  key: item.conversationId,
                  item,
                  selected: item.conversationId === selected,
                  running: runningLabels.has(`${item.cwd}|${item.label}`),
                  onSelect: (id) => {
                    setSelected(id)
                    setRun(null)
                    setSendError(null)
                    loadHistory(id)
                  },
                })),
          ),
        ),

        h(
          'div',
          {
            style: {
              borderTop: `1px solid ${C.border}`,
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: '52%',
              minHeight: 140,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', {
              style: { fontSize: 11, color: C.dim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, selectedItem === null ? '未选择会话' : `接着跑：${selectedItem.label}`),
            run !== null ? h('span', { style: { fontSize: 10, color: run.status === 'failed' ? C.danger : C.dimmer } }, statusText) : null,
            busy
              ? h('button', {
                type: 'button',
                onClick: stop,
                style: { border: `1px solid ${C.border}`, background: 'transparent', color: C.danger, borderRadius: 6, fontSize: 10, padding: '2px 6px', cursor: 'pointer' },
              }, '停止')
              : null,
          ),

          run !== null
            ? h('pre', {
              ref: outputRef,
              style: {
                margin: 0,
                flex: 1,
                minHeight: 60,
                maxHeight: 220,
                overflowY: 'auto',
                background: C.field,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: '6px 8px',
                fontSize: 11,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: C.text,
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              },
            }, run.text.length > 0 ? run.text : (busy ? '等待 agy 输出…' : '（无输出）'))
            : null,

          sendError !== null ? h('div', { style: { fontSize: 10, color: C.danger } }, sendError) : null,

          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'flex-end' } },
            h('textarea', {
              value: prompt,
              placeholder: selected === null ? '先选择一个会话' : '输入要继续的内容，Ctrl+Enter 发送',
              disabled: selected === null || busy,
              rows: 2,
              onChange: (event) => setPrompt(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  send()
                }
              },
              style: {
                flex: 1,
                resize: 'vertical',
                minHeight: 40,
                maxHeight: 120,
                background: C.field,
                color: C.text,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: '6px 8px',
                fontSize: 12,
                fontFamily: 'inherit',
              },
            }),
            h('button', {
              type: 'button',
              onClick: send,
              disabled: selected === null || busy || prompt.trim().length === 0,
              style: {
                flex: 'none',
                padding: '8px 12px',
                borderRadius: 8,
                border: 'none',
                background: C.accent,
                color: 'var(--dsw-alias-label-primary-foreground, #fff)',
                fontSize: 12,
                cursor: selected === null || busy ? 'default' : 'pointer',
                opacity: selected === null || busy || prompt.trim().length === 0 ? 0.55 : 1,
              },
            }, busy ? '运行中' : '接着跑'),
          ),
        ),
      )
    }

    const name = '@dsh-external/dsh-subagent-antigravity'
    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      const tabs = ctx.get('sidebarRightTabs')
      ctx.effect(() => tabs.register({
        id: TAB_TYPE,
        kind: TAB_TYPE,
        title: () => 'Antigravity Manager',
        // No guide entry on purpose: a guide capsule changes the right bar's
        // default-page rule, and this panel is meant to be opened from its
        // footer button only (PLAN-sidebar-panel.md decision 5).
      }), 'dsh-subagent-antigravity: sidebar tab type')

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_TYPE },
        AgyPanel,
      ))

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'agy', order: 30 },
        AgyFooterButton,
      ))

      openTab = () => {
        try {
          const face = ctx.get('sidebarRight')
          if (!face || typeof face.openTab !== 'function') return false
          face.openTab(TAB_TYPE)
          return true
        } catch {
          return false
        }
      }
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
