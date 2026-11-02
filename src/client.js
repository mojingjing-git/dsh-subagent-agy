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

    // ── token totals ──────────────────────────────────────────────────────────
    /** 12_345_678 → "12.3M" — these numbers run to nine digits in a day. */
    const compactTokens = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(Math.round(value))
    }
    const dayLabel = (day) => (typeof day === 'string' && day.length === 10 ? day.slice(5) : '')
    /** 7_200_000 → "2 小时"; the quota estimate is only as good as its span. */
    const durationText = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      const minutes = Math.round(ms / 60000)
      if (minutes < 60) return `${minutes} 分钟`
      const hours = Math.round(minutes / 60)
      if (hours < 48) return `${hours} 小时`
      return `${Math.round(hours / 24)} 天`
    }
    /** Why the conversion has no number yet — never just "攒数据中". */
    const quotaHint = (quota) => {
      const rows = Array.isArray(quota) ? quota : []
      if (rows.length === 0) return '攒数据中：额度快照每 5 分钟记一次，同一重置窗口内攒到两次才谈得上换算'
      const short = rows.filter((row) => row && row.reason === 'short-span')
      if (short.length > 0) {
        const spans = short.map((row) => durationText(row.spanMs)).join(' / ')
        return `样本太短（${spans}）：百分比是整数，几分钟掉 1 点只是取整噪声，攒够 2 小时才算`
      }
      return '攒数据中：同一重置窗口内至少两次快照才能算出「1 点值多少 token」'
    }

    /**
     * What the account has spent. `total` counts cache reads: they are the bulk
     * of the volume, and leaving them out is what makes a "token count" look
     * harmless while the quota drains.
     */
    function TokenCard({ tokens }) {
      const window = tokens && tokens.window ? tokens.window : null
      const all = tokens && tokens.allTime ? tokens.allTime : null
      const days = tokens && Array.isArray(tokens.days) ? tokens.days : []
      const peak = days.reduce((max, day) => Math.max(max, day.total || 0), 0)
      const title = 'agy 的每次运行都会在 transcript 里留下 input/output/cache 计数；这里把 CLI 与 IDE 两个会话库加在一起'
      return h(
        'div',
        { title, style: { padding: '10px 12px 10px', borderBottom: `1px solid ${C.border}` } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, 'Token 消耗'),
          tokens && tokens.allTime ? h('span', { style: { fontSize: 10, color: C.dimmer } }, `近 ${tokens.windowDays} 天`) : null,
          tokens && tokens.files > 0
            ? h('span', { style: { marginLeft: 'auto', fontSize: 10, color: C.dimmer } }, `${tokens.files} 个会话`)
            : null,
        ),
        tokens && tokens.error
          ? h('div', { style: { fontSize: 10, color: C.danger } }, `读取失败：${tokens.error}`)
          : !window
            ? h('div', { style: { fontSize: 11, color: C.dimmer, padding: '4px 0' } }, '统计中…')
            : h(
              'div',
              null,
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', { style: { fontSize: 22, fontWeight: 600, color: C.text, lineHeight: 1.2 } }, compactTokens(window.total)),
                h('span', { style: { fontSize: 11, color: C.dim } }, '总消耗（含缓存）'),
              ),
              h(
                'div',
                { style: { fontSize: 10, color: C.dim, marginTop: 2 } },
                `输入 ${compactTokens(window.input)} · 输出 ${compactTokens(window.output)} · 缓存读 ${compactTokens(window.cacheRead)}`,
              ),
              days.length > 0
                ? h(
                  'div',
                  { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 34, margin: '8px 0 2px' } },
                  days.map((day) => h('div', {
                    key: day.day,
                    title: `${day.day} · ${compactTokens(day.total)}（入 ${compactTokens(day.input)} / 出 ${compactTokens(day.output)} / 缓存 ${compactTokens(day.cacheRead)}）`,
                    style: {
                      flex: 1,
                      height: `${peak > 0 ? Math.max(2, Math.round((day.total / peak) * 32)) : 2}px`,
                      background: day.total > 0 ? C.accent : C.border,
                      borderRadius: 2,
                      opacity: day.total > 0 ? 0.85 : 0.5,
                    },
                  })),
                )
                : null,
              days.length > 0
                ? h(
                  'div',
                  { style: { display: 'flex', gap: 3, fontSize: 9, color: C.dimmer } },
                  days.map((day) => h('span', { key: day.day, style: { flex: 1, textAlign: 'center' } }, dayLabel(day.day))),
                )
                : null,
            ),
        all
          ? h(
            'div',
            { style: { fontSize: 10, color: C.dimmer, marginTop: 6 } },
            `本地总计 ${compactTokens(all.total)}（入 ${compactTokens(all.input)} / 出 ${compactTokens(all.output)} / 缓存 ${compactTokens(all.cacheRead)}）${all.from ? ` · 自 ${all.from}` : ''}`,
          )
          : null,
        h(
          'div',
          { style: { marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${C.border}` } },
          h('div', { style: { fontSize: 10, color: C.dim, marginBottom: 2 } }, '额度换算（近似）'),
          (tokens && Array.isArray(tokens.quota) ? tokens.quota : []).filter((row) => row && row.tokensPerPoint).length > 0
            ? (tokens.quota || [])
              .filter((row) => row && row.tokensPerPoint)
              .map((row) => h(
                'div',
                { key: `${row.family}|${row.window}`, style: { fontSize: 10, color: C.dimmer, lineHeight: 1.5 } },
                `${familyLabel(row.family)} · ${windowLabel(row.window)}：近 ${durationText(row.spanMs)} 掉 ${row.usedPoints} 点 ≈ ${compactTokens(row.tokens)} tokens → 100% ≈ ${compactTokens(row.capacity)}`,
              ))
            : h('div', { style: { fontSize: 10, color: C.dimmer } }, quotaHint(tokens && tokens.quota)),
        ),
      )
    }

    // ── history timeline ──────────────────────────────────────────────────────
    const MONO = 'ui-monospace, SFMono-Regular, Consolas, monospace'

    /**
     * Split one run of text into React nodes, handling only the two inline
     * forms agy actually emits: `code` and **bold**.
     *
     * Deliberately tiny. This file is loaded as a classic script with no build
     * step and no unit tests of its own, so a full markdown parser would be a
     * white-screen risk for no benefit. Nothing here ever builds an HTML
     * string — every value stays a React child, so agy's output cannot inject.
     */
    const inlineNodes = (text, keyPrefix) => {
      const nodes = []
      let rest = text
      let n = 0
      while (rest.length > 0) {
        const bold = /\*\*([^*]+)\*\*/.exec(rest)
        const code = /`([^`\n]+)`/.exec(rest)
        const hits = [bold, code].filter((hit) => hit !== null)
        if (hits.length === 0) {
          nodes.push(rest)
          break
        }
        hits.sort((a, b) => a.index - b.index)
        const next = hits[0]
        if (next.index > 0) nodes.push(rest.slice(0, next.index))
        nodes.push(
          next === bold
            ? h('strong', { key: `${keyPrefix}-b${n}` }, next[1])
            : h('code', {
              key: `${keyPrefix}-c${n}`,
              style: { fontFamily: MONO, background: C.field, borderRadius: 3, padding: '0 3px', fontSize: '0.95em' },
            }, next[1]),
        )
        n += 1
        rest = rest.slice(next.index + next[0].length)
      }
      return nodes
    }

    /**
     * Render prose with fenced code blocks. Everything else keeps its natural
     * newlines via `pre-wrap`, which is what already worked — only the code
     * fences and the two inline forms get special treatment.
     */
    const markdownNodes = (text, keyPrefix) => {
      const out = []
      const lines = String(text).split('\n')
      let para = []
      const flush = () => {
        if (para.length === 0) return
        const index = out.length
        out.push(
          h('div', {
            key: `${keyPrefix}-p${index}`,
            style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
          }, inlineNodes(para.join('\n'), `${keyPrefix}-p${index}`)),
        )
        para = []
      }
      let i = 0
      while (i < lines.length) {
        const fence = /^\s*```(.*)$/.exec(lines[i])
        if (fence !== null) {
          flush()
          i += 1
          const body = []
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
            body.push(lines[i])
            i += 1
          }
          i += 1 // closing fence (or past the end of an unclosed block)
          out.push(
            h('pre', {
              key: `${keyPrefix}-code${out.length}`,
              style: {
                margin: '4px 0',
                padding: '6px 8px',
                background: C.field,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                fontFamily: MONO,
                fontSize: 10.5,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowX: 'auto',
              },
            }, body.join('\n')),
          )
          continue
        }
        para.push(lines[i])
        i += 1
      }
      flush()
      return out
    }

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

    /** 65000 → "1m 5s" */
    const formatDuration = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
      const total = Math.round(ms / 1000)
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
    }

    /** The wall clock of a step, as agy recorded it. */
    const clockOf = (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return null
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** One step of the timeline. */
    function StepRow({ step, primary }) {
      const label = STEP_LABEL[step.type] || step.type || '步骤'
      // agy does not keep the body of every reply; where it only kept the
      // model name, that name is not the answer.
      const body =
        step.type === 'agent_response' && looksLikeModelName(step.text) ? '' : step.text
      const hasText = typeof body === 'string' && body.trim().length > 0
      // A long interim thought collapses to one line; only the final response
      // stays expanded. Without this the reasoning text alone (measured p50
      // ≈ 440 chars, max ≈ 4k) dominates the panel the way tool arguments did.
      if (hasText && primary !== true && step.type === 'agent_response' && body.trim().length > 300) {
        const firstLine = body.trim().split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
        return h(
          Disclosure,
          {
            summary: h('span', { style: { fontSize: 10, color: C.dim } },
              `${label} · ${body.trim().length} 字 · ${firstLine.slice(0, 60)}${firstLine.length > 60 ? '…' : ''}`),
          },
          h('div', { style: { fontSize: 11, lineHeight: 1.55, color: C.text } }, markdownNodes(body, `s${step.index}`)),
        )
      }
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
                  lineHeight: 1.55,
                  color: C.text,
                },
              },
              // The answer is prose: render its code fences and inline forms
              // instead of dumping raw markdown at the reader.
              markdownNodes(body, `s${step.index}`),
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
     * One collapsible block, built on native <details> so there is no state to
     * get wrong and no re-render can swallow a user's expand.
     *
     * `forceOpen` is passed only while a tool is running or has failed: React
     * then pins the block open, and once the step settles the prop is dropped
     * so the user gets control back. Passing `open: false` here would instead
     * collapse the block again on every poll.
     */
    function Disclosure({ summary, children, forceOpen }) {
      return h(
        'details',
        forceOpen === true ? { open: true } : {},
        h('summary', {
          style: { cursor: 'pointer', fontSize: 10, padding: '2px 0', userSelect: 'none' },
        }, summary),
        h('div', { style: { marginLeft: 10, marginTop: 2 } }, children),
      )
    }

    /**
     * Collapse a run's steps into renderable blocks.
     *
     * agy's real stream alternates tool → agent_response → tool, and most of
     * those responses carry no text at all. Grouping only *consecutive* tools
     * therefore merged nothing — measured on real sessions: 125 steps rendered
     * as 125 blocks. So the rules are:
     *   - a tool joins the open tool group, crossing empty responses;
     *   - a response with no text is dropped (it has nothing to show);
     *   - a response with text closes the group and stands alone;
     *   - the last response is marked `primary` so it is never collapsed.
     */
    /**
     * Fold the grouped timeline into three sections: the opening request, one
     * collapsed "执行过程" run covering every tool call and every interim
     * thought, and the final answer.
     *
     * Measured on real sessions, `groupSteps` alone still left a pattern like
     * `S S T S T S T…`: an interim thought (median ≈ 400 chars) sat between
     * every pair of tool groups, so a run with 46 tool calls still occupied
     * ~40 rows. Those interim thoughts are the model narrating itself — the
     * user asked for exactly that to stop taking up space — so they move inside
     * the same collapsible block as the tools. Nothing is hidden: expanding the
     * block shows the original timeline, tools still collapsed one line each.
     */
    function sectionize(groups) {
      let finalIndex = -1
      for (let i = groups.length - 1; i >= 0; i -= 1) {
        const group = groups[i]
        if (group.kind === 'step' && group.step.type === 'agent_response') {
          finalIndex = i
          break
        }
      }
      if (finalIndex < 0) return groups.map((group) => ({ kind: 'block', group }))
      // A leading user_input / system_message is context, not process: it stays
      // visible above the fold.
      const head = []
      let i = 0
      while (i < finalIndex && groups[i].kind === 'step' && groups[i].step.type !== 'agent_response') {
        head.push({ kind: 'block', group: groups[i] })
        i += 1
      }
      const middle = groups.slice(i, finalIndex)
      const out = head
      if (middle.length > 0) out.push({ kind: 'process', groups: middle })
      out.push({ kind: 'block', group: groups[finalIndex] })
      return out
    }

    /** The one-line summary of a collapsed process section. */
    function processSummary(groups) {
      let tools = 0
      let thoughts = 0
      for (const group of groups) {
        if (group.kind === 'tools') tools += group.steps.length
        else if (group.kind === 'step') thoughts += 1
      }
      const parts = []
      if (tools > 0) parts.push(`${tools} 次工具调用`)
      if (thoughts > 0) parts.push(`${thoughts} 段过程思考`)
      return parts.length > 0 ? parts.join(' · ') : `${groups.length} 个步骤`
    }

    function groupSteps(steps) {
      const groups = []
      let open = null
      const flush = () => {
        if (open !== null && open.steps.length > 0) groups.push(open)
        open = null
      }
      for (const step of steps) {
        if (step.type === 'tool') {
          if (open === null || open.round !== step.round) {
            flush()
            open = { kind: 'tools', round: step.round, steps: [] }
          }
          open.steps.push(step)
          continue
        }
        if (step.type === 'agent_response' && String(step.text || '').trim().length === 0) continue
        flush()
        groups.push({ kind: 'step', step })
      }
      flush()
      if (groups.length > 0) {
        const last = groups[groups.length - 1]
        if (last.kind === 'step' && last.step.type === 'agent_response') last.primary = true
      }
      return groups
    }

    /** One tool call, collapsed to a single line unless it is running or failed. */
    function ToolRow({ step }) {
      const tool = step.tool
      const name = (tool && tool.name) || '工具'
      const path = tool && typeof tool.targetPath === 'string' ? tool.targetPath : ''
      const failed = step.state === 'ERROR'
      const active = step.state === 'ACTIVE'
      const label = `${failed ? '✕ ' : active ? '▸ ' : ''}${name}${path.length > 0 ? ` · ${path}` : ''}`
      return h(
        Disclosure,
        {
          forceOpen: failed,
          summary: h('span', {
            style: { fontFamily: MONO, color: failed ? C.danger : active ? C.success : C.dim },
          }, label),
        },
        h(ToolDetail, { tool }),
      )
    }

    /** A run of consecutive tool calls, folded into one summary line. */
    function ToolGroup({ steps }) {
      const active = steps.some((step) => step.state === 'ACTIVE')
      const failed = steps.some((step) => step.state === 'ERROR')
      const names = steps.map((step) => (step.tool && step.tool.name) || '工具')
      const unique = names.filter((name, index) => names.indexOf(name) === index)
      const head = unique.slice(0, 3).join(' · ') + (unique.length > 3 ? ' …' : '')
      const summary = active ? `执行中 · ${head}` : `${steps.length} 次工具调用 · ${head}`
      return h(
        Disclosure,
        {
          // A running group must stay visible: collapsing it would hide exactly
          // what the user opened the panel to watch.
          forceOpen: active || failed,
          summary: h('span', {
            style: { color: failed ? C.danger : active ? C.success : C.dim, fontWeight: 500 },
          }, summary),
        },
        steps.map((step) => h(ToolRow, { key: step.index, step })),
      )
    }

    /**
     * The step timeline of the selected conversation.
     *
     * What the model actually did — which prompt it got, which tools it
     * called, what it replied.
     */
    function HistoryTimeline({ history, loading, error, onRefresh }) {
      const steps = history && Array.isArray(history.steps) ? history.steps : []
      // Consecutive tool calls collapse into one block, so a long run reads as
      // thought → tools → answer instead of one row per call.
      const groups = groupSteps(steps)
      // …and everything between the request and the answer collapses again into
      // a single 执行过程 section, which is what keeps a 46-tool-call run from
      // occupying 40 rows.
      const sections = sectionize(groups)
      const roundOfGroup = (group) => (group.kind === 'tools' ? group.round : group.step.round)
      const sectionRound = (section) => (section.kind === 'process'
        ? (section.groups.length > 0 ? roundOfGroup(section.groups[0]) : undefined)
        : roundOfGroup(section.group))
      const renderGroup = (group, key) => (group.kind === 'tools'
        ? h(ToolGroup, { key, steps: group.steps })
        : h(StepRow, { key, step: group.step, primary: group.primary }))
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
        sections.map((section, position) => {
          if (section.kind === 'process') {
            return h(
              'div',
              { key: `process-${position}`, style: { margin: '6px 0' } },
              h(
                Disclosure,
                {
                  summary: h('span', { style: { fontSize: 10, color: C.dim, fontWeight: 500 } },
                    `执行过程 · ${processSummary(section.groups)}`),
                },
                section.groups.map((group, index) => renderGroup(group, `pi-${position}-${index}`)),
              ),
            )
          }
          // agy keeps every run of a conversation in one transcript and
          // restarts its step numbers, so a new run shows up as a new round.
          const group = section.group
          const round = roundOfGroup(group)
          const previous = position === 0 ? null : sectionRound(sections[position - 1])
          const newRound = typeof round === 'number' && (previous === null || previous !== round)
          return h(
            React.Fragment,
            { key: group.kind === 'tools' ? `g-${group.steps[0].index}` : `s-${group.step.index}` },
            newRound
              ? h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      margin: '8px 0 4px',
                      fontSize: 9,
                      color: C.dimmer,
                    },
                  },
                  h('span', { style: { flex: 1, height: '1px', background: C.border } }),
                  h('span', null, `第 ${round + 1} 轮`),
                  h('span', { style: { flex: 1, height: '1px', background: C.border } }),
                )
              : null,
            renderGroup(group),
          )
        }),
      )
    }

    function ConversationRow({ item, selected, running, onSelect, onToggleHidden }) {
      const hidden = item.hidden === true
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'stretch',
            borderLeft: `2px solid ${selected ? C.accent : 'transparent'}`,
            background: selected ? C.hover : 'transparent',
            opacity: hidden ? 0.55 : 1,
            color: C.text,
          },
        },
        h(
          'div',
          {
            // A div with a role, not a <button>: the row carries its own hide
            // button, and a button may not nest inside another one.
            role: 'button',
            tabIndex: 0,
            onClick: () => onSelect(item.conversationId),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(item.conversationId)
            },
            style: { flex: 1, minWidth: 0, padding: '7px 4px 7px 10px', cursor: 'pointer', textAlign: 'left' },
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
        ),
        h('button', {
          type: 'button',
          title: hidden ? '恢复显示这个会话' : '隐藏这个会话',
          onClick: (event) => {
            event.stopPropagation()
            onToggleHidden(item.conversationId, !hidden)
          },
          style: {
            flex: 'none',
            background: 'transparent',
            border: 'none',
            color: C.dimmer,
            cursor: 'pointer',
            fontSize: 11,
            padding: '0 8px',
          },
        }, hidden ? '↺' : '⊘'),
      )
    }

    function AgyPanel() {
      const [items, setItems] = useState([])
      const [hiddenCount, setHiddenCount] = useState(0)
      const [includeHidden, setIncludeHidden] = useState(false)
      const [listError, setListError] = useState(null)
      const [usage, setUsage] = useState(null)
      const [tokens, setTokens] = useState(null)
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
        post('/conversations', includeHidden ? { includeHidden: true } : {})
          .then((payload) => {
            setItems(payload.items || [])
            setHiddenCount(typeof payload.hiddenCount === 'number' ? payload.hiddenCount : 0)
            setListError(null)
          })
          .catch((error) => setListError(error.message))
      }, [includeHidden])

      /** Hide or restore one conversation, then reload so the count stays right. */
      const toggleHidden = useCallback((conversationId, hide) => {
        post('/prefs', hide ? { hide: conversationId } : { show: conversationId })
          .then(() => loadConversations())
          .catch((error) => setListError(error.message))
      }, [loadConversations])

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

      const loadTokens = useCallback(() => {
        post('/token-usage', {})
          .then((payload) => setTokens(payload))
          .catch(() => {})
      }, [])

      useEffect(() => {
        loadConversations()
        loadUsage(false)
        loadTokens()
        const conversations = setInterval(loadConversations, 20000)
        const usageTimer = setInterval(() => loadUsage(false), 30000)
        const tokenTimer = setInterval(loadTokens, 60000)
        return () => { clearInterval(conversations); clearInterval(usageTimer); clearInterval(tokenTimer) }
      }, [loadConversations, loadUsage, loadTokens])

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
                  // The live timeline is the same StepEvent[] shape /history
                  // returns, so it renders through the same components. It is
                  // replaced wholesale (never delta-merged): a step arrives again
                  // when it advances from ACTIVE to DONE.
                  steps: Array.isArray(payload.steps) ? payload.steps : prev.steps,
                  elapsedMs: typeof payload.elapsedMs === 'number' ? payload.elapsedMs : prev.elapsedMs,
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
            setRun({ id: payload.runId, text: '', status: 'running', tool: null, error: undefined, steps: [], elapsedMs: 0 })
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

      const elapsedText = run !== null && typeof run.elapsedMs === 'number' && run.elapsedMs > 0
        ? ` · 已运行 ${formatDuration(run.elapsedMs)}`
        : ''
      const statusText = run === null
        ? ''
        : run.status === 'running'
          ? (run.tool ? `正在调用 ${run.tool}` : '运行中…') + elapsedText
          : run.status === 'done'
            ? '完成'
            : run.status === 'cancelled'
              ? '已停止'
              : '失败'

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.text } },
        h(UsageCards, { usage, refreshing, onRefresh: () => loadUsage(true) }),
        h(TokenCard, { tokens }),
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
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 6px' } },
              h('span', { style: { fontSize: 9, color: C.dimmer, flex: 1 } }, `${items.length} 个会话`),
              includeHidden || hiddenCount > 0
                ? h('button', {
                  type: 'button',
                  onClick: () => setIncludeHidden((value) => !value),
                  style: {
                    border: `1px solid ${C.border}`,
                    background: 'transparent',
                    color: C.dim,
                    borderRadius: 6,
                    fontSize: 9,
                    padding: '1px 6px',
                    cursor: 'pointer',
                  },
                }, includeHidden ? '收起已隐藏' : `显示已隐藏（${hiddenCount}）`)
                : null,
            ),
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
                  onToggleHidden: toggleHidden,
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

          run !== null && Array.isArray(run.steps) && run.steps.length > 0
            ? h(
              'div',
              {
                style: {
                  flex: 1,
                  minHeight: 60,
                  maxHeight: 220,
                  overflowY: 'auto',
                  background: C.field,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: '6px 8px',
                },
              },
              // Live view: only the tail. The whole run is collapsed into one
              // section in the history view, but while it runs you want to see
              // what it is doing *now*, so keep the last few blocks visible.
              (() => {
                const all = groupSteps(run.steps)
                const recent = all.slice(-6)
                const skipped = all.length - recent.length
                return [
                  skipped > 0
                    ? h('div', { key: 'older', style: { fontSize: 9, color: C.dimmer, marginBottom: 4 } },
                      `更早的 ${skipped} 段已折叠，完成后可在历史里展开查看`)
                    : null,
                  ...recent.map((group, position) => (group.kind === 'tools'
                    ? h(ToolGroup, { key: `rg-${position}`, steps: group.steps })
                    : h(StepRow, { key: `rs-${position}`, step: group.step, primary: group.primary }))),
                ]
              })(),
            )
            : null,

          run !== null
            ? (Array.isArray(run.steps) && run.steps.length > 0
              // The timeline is the primary view; the raw stream stays one click
              // away because it carries whatever the step parser dropped
              // (stderr notes, protocol lines, crash diagnostics).
              ? h(
                Disclosure,
                { summary: `原始输出 · ${run.text.length} 字符` },
                h('pre', {
                  ref: outputRef,
                  style: {
                    margin: 0,
                    maxHeight: 200,
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 10.5,
                    lineHeight: 1.45,
                    color: C.dim,
                    fontFamily: MONO,
                  },
                }, run.text.length > 0 ? run.text : (busy ? '等待 agy 输出…' : '（无输出）')),
              )
              : h('pre', {
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
                  fontFamily: MONO,
                },
              }, run.text.length > 0 ? run.text : (busy ? '等待 agy 输出…' : '（无输出）')))
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
        // footer button only.
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
