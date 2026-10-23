/**
 * A real executable wrapper around fake-agy.mjs, generated per test run.
 *
 * The plugin's `command` config is ONE executable resolved through the
 * subprocess seam, so a test cannot pass `node fake-agy.mjs` there. This
 * writes a shim that stands in for `agy.exe` and forwards the argument vector
 * untouched to the bundled Node runtime running fake-agy.mjs, so the plugin's
 * flag construction is reproducible byte for byte.
 *
 * On Windows the shim is a `.cmd`, but the subprocess shim must NOT route it
 * through cmd.exe: cmd joins its arguments into one command line, and the
 * prompts the plugin builds contain newlines, so everything after the first
 * line break (including `--output-format`) was silently dropped. Real agy is
 * an `.exe` started through CreateProcess, which has no such limit. The shim
 * therefore parses this file back and re-spawns Node directly, exercising the
 * same no-shell path the real binary takes.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Marker so the subprocess shim can recognise and unwrap a fake-agy launcher. */
const LAUNCHER_MARKER = 'dsh-fake-agy-launcher:'

/** Quote one argument for a PowerShell command line. */
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`

/**
 * Write the wrapper into `dir` and return its absolute path.
 * @param dir directory to create the wrapper in
 * @param fakeScript absolute path to fake-agy.mjs
 * @param nodeBin absolute path to the node executable
 */
export function writeFakeAgyWrapper(dir, fakeScript, nodeBin) {
  if (process.platform === 'win32') {
    const path = join(dir, 'fake-agy.cmd')
    // `%*` is only a fallback for a human running the file by hand; the shim
    // recognises the marker and spawns Node with the argv it already has.
    writeFileSync(path, `@echo off\r\nrem ${LAUNCHER_MARKER}${nodeBin}|${fakeScript}\r\n"${nodeBin}" "${fakeScript}" %*\r\n`, 'utf8')
    return path
  }
  const path = join(dir, 'fake-agy.sh')
  writeFileSync(path, `#!/bin/sh\nexec "${nodeBin}" "${fakeScript}" "$@"\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

/**
 * Read a generated launcher's marker.
 * @param command absolute path to a possible launcher
 * @returns `{ node, script }` for a fake-agy launcher, else undefined.
 */
export function readLauncher(command) {
  if (!/\.(cmd|bat)$/i.test(command)) return undefined
  let head
  try {
    head = readFileSync(command, 'utf8').slice(0, 1024)
  } catch {
    return undefined
  }
  const at = head.indexOf(LAUNCHER_MARKER)
  if (at === -1) return undefined
  const line = head.slice(at + LAUNCHER_MARKER.length).split(/\r?\n/, 1)[0]
  const bar = line.indexOf('|')
  if (bar === -1) return undefined
  return { node: line.slice(0, bar), script: line.slice(bar + 1) }
}

export { psQuote }
