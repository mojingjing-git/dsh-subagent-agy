#!/usr/bin/env node
/**
 * `model: auto` checks:
 *
 *   node test/agy-models.mjs
 *
 * The selection rule must survive agy renaming its catalogue, so these checks
 * pin the parsing and ranking down without a real install — plus one end-to-end
 * pass through `startPanelRun()` proving the resolved slug reaches argv.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agy-models-'))
process.env.DSH_HOME = home

const {
  parseModels,
  pickDeepestFlash,
  readModelCatalog,
  writeModelCatalog,
  MODEL_CACHE_TTL_MS,
} = await import('../lib/agy-models.js')
const { bootPlugin } = await import('./harness.mjs')

let passed = 0
const check = (name, fn) => {
  const out = fn()
  if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
    throw new Error(`async assertion passed to sync check() (unawaited): ${name}`)
  }
  passed += 1
  console.log(`  ok  ${name}`)
}

try {
  check('parseModels tolerates the fetching header, tabs and CRLF', () => {
    const text = [
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      '',
    ].join('\r\n')
    const models = parseModels(text)
    assert.deepEqual(models.map((m) => m.id), [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'claude-sonnet-4-6',
    ])
    assert.equal(models[0].name, 'Gemini 3.8 Flash (High)')
  })

  check('parseModels drops duplicates and malformed rows', () => {
    const models = parseModels(
      [
        'gemini-3.8-flash-high\tA',
        'gemini-3.8-flash-high\tA again',
        '\tno id',
        'has space\tnot a slug',
        'gpt-oss-120b-medium\tGPT-OSS',
      ].join('\n'),
    )
    assert.deepEqual(models.map((m) => m.id), ['gemini-3.8-flash-high', 'gpt-oss-120b-medium'])
  })

  check('pickDeepestFlash prefers the newest version, then the deepest level', () => {
    const models = [
      { id: 'gemini-3.8-flash-medium', name: '' },
      { id: 'gemini-3.8-flash-high', name: '' },
      { id: 'gemini-3.7-flash-high', name: '' },
      { id: 'gemini-3.10-flash-low', name: '' },
      { id: 'gemini-3.9-flash-high', name: '' },
      { id: 'claude-opus-4-6-thinking', name: '' },
    ]
    assert.equal(pickDeepestFlash(models), 'gemini-3.10-flash-low')
    assert.equal(
      pickDeepestFlash(models.filter((m) => m.id.startsWith('gemini-3.8'))),
      'gemini-3.8-flash-high',
    )
    assert.equal(
      pickDeepestFlash([{ id: 'gemini-4.0-flash-low', name: '' }, { id: 'gemini-3.8-flash-high', name: '' }]),
      'gemini-4.0-flash-low',
    )
  })

  check('pickDeepestFlash returns empty when no flash slug exists', () => {
    assert.equal(pickDeepestFlash([{ id: 'claude-sonnet-4-6', name: '' }]), '')
    assert.equal(pickDeepestFlash([]), '')
  })

  check('the catalogue cache round-trips and ignores corruption', () => {
    const file = join(home, 'agy-models.json')
    const catalog = { fetchedAt: 1234, chosen: 'gemini-3.8-flash-high', models: [{ id: 'x', name: 'X' }] }
    writeModelCatalog(file, catalog)
    assert.deepEqual(readModelCatalog(file), catalog)
    assert.ok(MODEL_CACHE_TTL_MS > 0)
    writeFileSync(file, '{not json', 'utf8')
    assert.equal(readModelCatalog(file), undefined)
    assert.equal(readModelCatalog(join(home, 'missing.json')), undefined)
  })

  // ── integration: model: auto resolves through the fake `agy models` ────────
  process.env.FAKE_AGY_SCENARIO = 'success'
  const boot = await bootPlugin({ model: 'auto' }, {})
  try {
    const provider = boot.provider()
    assert.ok(provider, 'provider registered')
    await provider.warmModelCatalog()

    const cacheFile = join(home, 'agy-models.json')
    assert.ok(existsSync(cacheFile), 'catalogue cached under DSH_HOME')
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
    assert.equal(cached.chosen, 'gemini-3.8-flash-high', JSON.stringify(cached))

    // A warm cache must satisfy the next boot without shelling out again.
    const probes = boot.subprocess.spawned.filter((h) => h.argv.includes('models'))
    assert.equal(probes.length, 1, 'exactly one models probe')

    const handle = await provider.startPanelRun({
      sessionId: 'panel:agy',
      baseCwd: boot.workdir,
      label: '自动选型',
      prompt: 'hello',
      conversationId: 'fake-conversation-0001',
      cwd: boot.workdir,
    })
    await handle.done
    const spawn = boot.subprocess.spawned.filter((h) => h.argv.includes('--conversation')).pop()
    const modelAt = spawn.argv.indexOf('--model')
    assert.ok(modelAt >= 0, `argv: ${spawn.argv.join(' ')}`)
    assert.equal(spawn.argv[modelAt + 1], 'gemini-3.8-flash-high')
    assert.equal(Object.values(boot.taskRegistry())[0].model, 'gemini-3.8-flash-high')

    passed += 1
    console.log('  ok  model: auto resolves to the deepest flash slug in argv')
  } finally {
    boot.dispose()
    boot.cleanup()
  }

  console.log(`\n${passed} checks passed`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
