/**
 * A faithful stand-in for `ctx.subprocess` used by the offline suite.
 *
 * `@deepseek-ai/dsh-subprocess-local` is not part of the plugin's peer set, so
 * the suite provides its own service. Only the surface the plugin actually
 * touches is implemented, with the documented semantics:
 *   - `spawn(spec)` returns a live handle synchronously
 *   - `handle.stdout` is a raw piped stream when stdio.stdout === 'pipe'
 *   - `handle.collected.<stream>.readFrom(offset)` is offset-based and
 *     non-consuming, and reports spill metadata for lossy reads
 *   - `handle.done` resolves with `{ exitCode, signal }` (never rejects for a
 *     non-zero exit; rejects only for spawn failures)
 *   - `handle.terminate()` kills the whole managed tree
 *   - `handle.waitForExit()` resolves true once the tree is gone
 *   - aborting `spec.signal` terminates like `terminate()`
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLauncher } from './fake-agy-wrapper.mjs'

/** Bounded capture buffer matching the service's collect-mode semantics. */
class Collected {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.chunks = []
    this.bytes = 0
    this.truncated = false
    this.spillPath = undefined
  }

  push(chunk) {
    const room = this.maxBytes - this.bytes
    if (room <= 0 && this.spillPath === undefined && this.spill) {
      this.spillPath = join(this.spill.dir, 'spill.bin')
      writeFileSync(this.spillPath, '')
    }
    const take = room > 0 ? chunk.subarray(0, Math.min(room, chunk.length)) : Buffer.alloc(0)
    if (take.length > 0) {
      this.chunks.push(take)
      this.bytes += take.length
    }
    if (take.length < chunk.length) {
      this.truncated = true
      if (this.spillPath !== undefined) writeFileSync(this.spillPath, chunk, { flag: 'a' })
    }
  }

  readFrom(offset = 0) {
    const buffer = Buffer.concat(this.chunks)
    const slice = buffer.subarray(Math.max(0, Math.min(offset, buffer.length)))
    return {
      text: slice.toString('utf8'),
      nextOffset: buffer.length,
      truncated: this.truncated,
      spillPath: this.spillPath,
    }
  }
}

/** One live spawn: handle fields plus the exit facts `done` resolves with. */
function makeHandle(spec) {
  const argv = Array.isArray(spec.argv) ? [...spec.argv] : []
  const [command, ...args] = argv
  const stdoutSpec = spec.stdio?.stdout ?? 'ignore'
  const stderrSpec = spec.stdio?.stderr ?? 'ignore'
  const collectFor = (streamSpec) => (typeof streamSpec === 'object' ? streamSpec.maxBytes ?? 1 << 20 : undefined)

  // Real agy is an .exe started through CreateProcess: argv reaches it
  // byte-for-byte, newlines and all. A `.cmd` launcher cannot reproduce that
  // through cmd.exe — cmd joins its arguments into ONE command line, so a
  // prompt containing a newline truncates everything after it (the plugin's
  // prompts always do, which silently dropped `--output-format`). Instead the
  // fake-agy launcher is unwrapped and Node is spawned directly with the
  // original argv, giving the same no-shell path the real binary takes.
  const launch = process.platform === 'win32' ? readLauncher(command) : undefined
  const spawnCommand = launch?.node ?? command
  const spawnArgs = launch === undefined ? args : [launch.script, ...args]
  const child = nodeSpawn(spawnCommand, spawnArgs, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: [
      spec.stdio?.stdin === 'pipe' ? 'pipe' : 'ignore',
      'pipe',
      'pipe',
      spec.stdio?.extra ?? 'ignore',
    ],
    windowsHide: true,
  })

  const stdoutCollected = stdoutSpec === 'pipe' ? undefined : new Collected(collectFor(stdoutSpec) ?? 1 << 20)
  if (stdoutCollected && typeof stdoutSpec === 'object' && stdoutSpec.spill) {
    stdoutCollected.spill = {
      dir: spec.spillDir ?? mkdtempSync(join(tmpdir(), 'dsh-spill-')),
    }
  }
  const stderrCollected = stderrSpec === 'pipe' ? undefined : new Collected(collectFor(stderrSpec) ?? 64 << 10)

  const stdoutStream = new EventEmitter()
  let exitFacts
  let exited = false
  const exitWaiters = []
  const settleExit = (facts) => {
    if (exited) return
    exited = true
    exitFacts = facts
    for (const waiter of exitWaiters.splice(0)) waiter(facts)
  }

  child.stdout?.on('data', (chunk) => {
    stdoutCollected?.push(chunk)
    if (stdoutSpec === 'pipe') stdoutStream.emit('data', chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderrCollected?.push(chunk)
  })
  child.stdout?.on('end', () => {
    if (stdoutSpec === 'pipe') stdoutStream.emit('end')
  })
  child.on('error', (error) => {
    settleExit({ exitCode: null, signal: null, spawnError: error })
    if (stdoutSpec === 'pipe') stdoutStream.emit('end')
  })
  child.on('close', (code, signal) => {
    settleExit({ exitCode: code, signal: signal ?? null })
  })

  const handle = {
    argv,
    pid: child.pid,
    stdout: stdoutSpec === 'pipe' ? stdoutStream : undefined,
    collected: { stdout: stdoutCollected, stderr: stderrCollected },
    get closed() {
      return exited
    },
    done: new Promise((resolve) => {
      if (exited) resolve(exitFacts)
      else exitWaiters.push(resolve)
    }),
    terminate() {
      if (exited) return
      // Real agy runs as one process; the fake CLI reproduces that, but a
      // scenario may still fork. On Windows a bare SIGTERM does not reliably
      // end a Node child that holds the stdout pipe, which would leave `done`
      // unsettled forever (the timeout case hung on exactly this). Take the
      // whole tree with taskkill /T, exactly as a managed range must.
      if (process.platform === 'win32') {
        try {
          nodeSpawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            windowsHide: true,
            stdio: 'ignore',
          }).unref()
        } catch {
          /* fall through to the direct kill below */
        }
      }
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 2000)
      force.unref?.()
    },
    waitForExit() {
      return new Promise((resolve) => {
        if (exited) resolve(true)
        else exitWaiters.push(() => resolve(true))
      })
    },
    writeStdin(data) {
      child.stdin?.write(data)
    },
  }

  if (spec.signal !== undefined) {
    if (spec.signal.aborted) handle.terminate()
    else spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
  }

  return handle
}

/** Replace the plugin's `ctx.subprocess` with this service. */
export function createSubprocessShim() {
  const spawned = []
  return {
    spawned,
    spawn(spec) {
      const handle = makeHandle(spec)
      spawned.push(handle)
      return handle
    },
    async resolveExecutable(command) {
      return command
    },
    terminateAll() {
      for (const handle of spawned) handle.terminate()
    },
  }
}

/** Read a whole file for assertions; undefined when absent. */
export function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
