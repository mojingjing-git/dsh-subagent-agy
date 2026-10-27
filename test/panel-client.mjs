/**
 * Contract test for the browser bundle (`src/client.js`).
 *
 * No React and no browser needed: the factory only touches React inside the
 * component bodies, so a stub is enough to verify the pieces that actually
 * cause the white-screen failure mode — the loader id, the module shape, the
 * `sidebarRightTabs` registration, and the two `slots.inject` registrations.
 *
 * It also cross-checks that every endpoint the client posts to exists in the
 * host panel routes, which is the other half of a silent "panel does nothing".
 *
 * Usage: node test/panel-client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
const host = readFileSync(join(root, 'src', 'agy-panel.ts'), 'utf8')

const checks = []
const check = (name, fn) => {
  fn()
  checks.push(name)
}

let captured = null
const fakeWindow = { __ModuleLoader__: { load: (module) => { captured = module } } }

const fakeReact = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
}

// DSH's web loader evaluates the bundle as a classic script: `window` and
// `fetch` exist, `module`/`exports`/`require` do NOT. Evaluating in a bare VM
// context reproduces that exactly — the patched.9 white screen was `module is not
// defined`, which this test could not see while it injected a fake `module`.
runInNewContext(
  source,
  {
    window: fakeWindow,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    console,
  },
  { filename: 'client.js' },
)

check('bundle registers through __ModuleLoader__ with the package id', () => {
  assert.notEqual(captured, null)
  assert.equal(captured.id, '@dsh-external/dsh-subagent-antigravity')
  assert.equal(typeof captured.factory, 'function')
})

// The factory builds and returns its own `module.exports` shell, exactly as it
// does inside the browser loader.
const mod = captured.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
})

check('module exports name/inject/apply', () => {
  assert.equal(mod.name, '@dsh-external/dsh-subagent-antigravity')
  // Spread first: the bundle's array lives in the VM realm and has that realm's
  // Array.prototype, which deepStrictEqual compares by identity.
  assert.deepEqual([...mod.inject], ['slots', 'sidebarRightTabs'])
  assert.equal(typeof mod.apply, 'function')
})

const calls = { tabs: [], slots: [], injected: [], opened: null }
const ctx = {
  get(name) {
    if (name === 'sidebarRightTabs') return { register: (definition) => calls.tabs.push(definition) }
    if (name === 'sidebarRight') return { openTab: (kind) => { calls.opened = kind } }
    return undefined
  },
  effect(fn) { return fn() },
  slots: {
    inject(name, fn) { calls.injected.push(name); return fn() },
    register(options, component) { calls.slots.push({ options, component }); return { dispose() {} } },
  },
}

mod.apply(ctx)

check('tab type registered as agy, without a guide capsule', () => {
  assert.equal(calls.tabs.length, 1)
  assert.equal(calls.tabs[0].id, 'agy')
  assert.equal(calls.tabs[0].kind, 'agy')
  // Decision 5 of the plan: no guide entry, so the right bar's default page
  // rule is untouched; the tab opens from the footer button only.
  assert.equal(calls.tabs[0].guide, undefined)
})

check('both slots registered through slots.inject (never bare register)', () => {
  assert.deepEqual(calls.injected, ['sidebar.right.pane.tab', 'sidebar.footer.action'])
  assert.equal(calls.slots.length, 2)
  const pane = calls.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const footer = calls.slots.find((entry) => entry.options.name === 'sidebar.footer.action')
  assert.equal(pane.options.key, 'agy')
  assert.equal(footer.options.id, 'agy')
  assert.equal(typeof pane.component, 'function')
  assert.equal(typeof footer.component, 'function')
})

check('every client endpoint exists on the host', () => {
  const clientPaths = [...source.matchAll(/post\('(\/[a-z-]+)'/g)].map((match) => `/api-agy${match[1]}`)
  assert.ok(clientPaths.length >= 6, `only found ${clientPaths.length} endpoints`)
  for (const path of new Set(clientPaths)) {
    assert.ok(host.includes(`jsonRoute('${path}'`), `host is missing ${path}`)
  }
})

check('selecting a conversation loads its step timeline', () => {
  // The panel used to show nothing but the title: the client never asked for
  // the history and never rendered a timeline.
  assert.ok(source.includes("post('/history'"), 'the client never reads /history')
  assert.ok(source.includes('HistoryTimeline'), 'the timeline component is missing')
  assert.ok(source.includes('loadHistory(id)'), 'selecting a conversation does not load its history')
  // The steps the timeline shows come from the history route.
  assert.ok(host.includes("jsonRoute('/api-agy/history'"), 'the host has no history route')
})

for (const name of checks) console.log(`ok ${name}`)
console.log(`\n${checks.length} checks passed`)
