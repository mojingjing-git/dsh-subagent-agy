#!/usr/bin/env node
// Pick the build config that matches THIS machine and run tsc with it.
//
// There are two genuinely different situations and they cannot share one
// config, because `src/peers.d.ts` turns from essential into harmful depending
// on whether the real @deepseek-ai/* declarations resolve:
//
//   - A local DSH install (F:/Agent/DSH) ships no .d.ts files for its peers even
//     though each package.json advertises `types`, so every peer import degrades
//     to `any` and module augmentation is illegal (TS2664/TS2665). The shim in
//     src/peers.d.ts is required here.
//   - A clean clone with the peers installed from the registry has real types.
//     There the shim's `declare module '@deepseek-ai/dsh-jobs'` is an ambient
//     declaration that SHADOWS the real module, so the augmentation in
//     src/index.ts widens the shim's JobKindMap and `jobs.start({ kind:
//     'antigravity' })` fails to typecheck. The shim must be out of the program.
//
// So: probe for a real peer declaration, then build accordingly. Same output
// either way — the shim only adds type information, it emits nothing.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))

/**
 * Does the installed @deepseek-ai/dsh-jobs actually ship USABLE declarations?
 *
 * Two different deceptions to survive, both observed on DSH 0.2.1-rc.2:
 *
 *   1. Every peer package.json advertises `"types": "lib/types/index.d.ts"`
 *      and then does not publish that file. Trusting the field reports "types
 *      present" on an install that has none.
 *   2. This checkout's node_modules contains real stub directories alongside
 *      the junctions (dsh-jobs, dsh-code-runtime, dsh-invariants, ...) whose
 *      `lib/types/index.d.ts` is literally `export {}` — 11 bytes. The file
 *      exists, is non-empty, and declares nothing, so an existsSync check
 *      passes while the module is still untyped and cannot be augmented.
 *
 * So: require a declaration file that actually exports something.
 */
function peerTypesResolve() {
  const MIN_USEFUL_BYTES = 32 // `export {}` + newline is 11
  const candidates = ['lib/types/index.d.ts', 'lib/index.d.ts', 'index.d.ts', 'lib/index.d.mts']
  try {
    const pkgPath = require.resolve('@deepseek-ai/dsh-jobs/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const types = typeof pkg.types === 'string' ? [pkg.types] : []
    for (const candidate of [...types, ...candidates]) {
      const file = join(dirname(pkgPath), candidate)
      try {
        if (readFileSync(file, 'utf8').trim().length >= MIN_USEFUL_BYTES) return true
      } catch {
        // missing — try the next candidate
      }
    }
    return false
  } catch {
    return false
  }
}

const real = peerTypesResolve()
const config = real ? 'tsconfig.build.json' : 'tsconfig.local.json'
process.stdout.write(
  `build: peer declarations ${real ? 'present' : 'missing'} → ${config}` +
    (real ? ' (no shim)' : ' (with src/peers.d.ts shim)') +
    '\n',
)

// Prefer the repo's own typescript so the version is pinned, like the build did.
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(process.execPath, [tscBin, '-p', config], {
  cwd: root,
  stdio: 'inherit',
})
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

// The web bundle (`dsh.client` → `exports["./client"]`) is hand-written plain
// JS in the loader's UMD shape — nothing to compile, but it must land in lib/
// so the published tarball carries it.
const clientSrc = join(root, 'src', 'client.js')
if (existsSync(clientSrc)) {
  mkdirSync(join(root, 'lib'), { recursive: true })
  const clientOut = join(root, 'lib', 'client.js')
  copyFileSync(clientSrc, clientOut)
  process.stdout.write('build: copied src/client.js → lib/client.js\n')

  // Evaluate the copied bundle the way the web loader does: as a classic script,
  // with no `module` / `exports` / `require`. A bundle missing its CommonJS
  // shell must fail here, not on the next DSH boot — patched.9 shipped exactly
  // that white screen (`web boot: 1 entry did not activate`).
  let captured
  try {
    runInNewContext(
      readFileSync(clientOut, 'utf8'),
      {
        window: { __ModuleLoader__: { load: (module) => { captured = module } } },
        fetch: () => Promise.reject(new Error('no network during build')),
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        console,
      },
      { filename: clientOut },
    )
  } catch (error) {
    process.stderr.write(`build: lib/client.js does not evaluate as a classic script: ${String(error)}\n`)
    process.exit(1)
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (captured === undefined || captured.id !== pkg.name || typeof captured.factory !== 'function') {
    process.stderr.write('build: lib/client.js did not register through window.__ModuleLoader__\n')
    process.exit(1)
  }
  let clientExports
  try {
    clientExports = captured.factory((id) => {
      if (id === 'react') return {}
      throw new Error(`unexpected require: ${id}`)
    })
  } catch (error) {
    process.stderr.write(`build: lib/client.js factory threw: ${String(error)}\n`)
    process.exit(1)
  }
  if (clientExports === null || typeof clientExports !== 'object' || typeof clientExports.apply !== 'function') {
    process.stderr.write('build: lib/client.js factory did not return { name, inject, apply }\n')
    process.exit(1)
  }
  process.stdout.write('build: lib/client.js loads as a classic script with a CommonJS shell\n')
}
process.exit(0)
