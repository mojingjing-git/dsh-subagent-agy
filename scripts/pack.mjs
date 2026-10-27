/**
 * Build a deterministic npm-style tarball.
 *
 * `npm pack` would run lifecycle hooks, consult the network for the package
 * name, and stamp files with the current time. For a plugin that ships as a
 * hand-patched bundle we want the opposite: a byte-identical archive whenever
 * the sources are unchanged, so a rebuild can be diffed.
 *
 * Layout: every entry is written as `package/<relative path>`, which is what
 * pnpm and `npm install <tarball>` expect. Paths are sorted, directories are
 * emitted before their contents, and every header carries a fixed mtime and
 * mode.
 *
 * Usage: node scripts/pack.mjs [<projectRoot> [<outputTgz>]]
 *
 * Both arguments are optional: the root defaults to the repository this script
 * lives in, and the output defaults to dist/<tarball name>.tgz so a bare
 * `node scripts/pack.mjs` produces the artifact instead of a usage error.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url))
if (!existsSync(join(root, 'package.json'))) {
  console.error(`usage: node scripts/pack.mjs [<projectRoot> [<outputTgz>]] — no package.json under ${root}`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const out = process.argv[3] ?? join(root, 'dist', `dsh-external-dsh-subagent-antigravity-${pkg.version}.tgz`)
mkdirSync(join(out, '..'), { recursive: true })

/** Files and directories to ship, matching package.json "files". */
const INCLUDE = [
  'package.json',
  'lib',
  'cordis.patch.yml',
  'PATCH.md',
  'README.md',
  'README.zh.md',
  'README.i18n.yaml',
  'LICENSE',
]

/** Never ship these even if nested inside an included directory. */
const EXCLUDE = /(^|[\\/])(node_modules|test|scripts|\.git|\.DS_Store)([\\/]|$)|\.[mc]?js\.map$|\/index\.js\.map$/

/** A fixed timestamp: 1985-10-26T08:15:00Z, the tar epoch npm uses. */
const MTIME = 499162500

/** Convert a path to the forward-slash form tar requires. */
const posix = (p) => p.split(sep).join('/')

/** Collect `{name, type, body?}` entries for one included path. */
function collect(abs, name, entries) {
  const stat = statSync(abs)
  if (stat.isDirectory()) {
    entries.push({ name: name + '/', type: '5' })
    const children = readdirSync(abs).sort()
    for (const child of children) {
      const childAbs = join(abs, child)
      const childName = name + '/' + child
      if (EXCLUDE.test(posix(relative(root, childAbs)))) continue
      collect(childAbs, childName, entries)
    }
    return
  }
  entries.push({ name, type: '0', body: readFileSync(abs) })
}

const entries = []
for (const item of INCLUDE) {
  const abs = join(root, item)
  collect(abs, 'package/' + posix(item), entries)
}

/** Write one 512-byte ustar header. */
function header(name, type, size) {
  const buf = Buffer.alloc(512, 0)
  const put = (offset, length, value) => Buffer.from(value, 'utf8').copy(buf, offset, 0, length)

  put(0, 100, name)
  put(100, 8, '0000644\0')            // mode 0644
  put(108, 8, '0000000\0')            // uid 0
  put(116, 8, '0000000\0')            // gid 0
  put(124, 12, size.toString(8).padStart(11, '0') + '\0')
  put(136, 12, MTIME.toString(8).padStart(11, '0') + '\0')
  buf.write('        ', 148, 8, 'utf8') // the checksum field is spaces while summing
  buf.write(type, 156, 1, 'utf8')
  put(257, 6, 'ustar\0')
  put(263, 2, '00')

  let sum = 0
  for (const byte of buf) sum += byte
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ')

  if (Buffer.byteLength(name, 'utf8') > 100) {
    console.error(`pack: path longer than the 100-byte ustar limit: ${name}`)
    process.exit(1)
  }
  return buf
}

const chunks = []
for (const entry of entries) {
  const body = entry.body ?? Buffer.alloc(0)
  chunks.push(header(entry.name, entry.type, body.length))
  if (body.length > 0) {
    chunks.push(body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
  }
}
// Two zero blocks terminate the archive.
chunks.push(Buffer.alloc(1024, 0))

const raw = Buffer.concat(chunks)
writeFileSync(out, gzipSync(raw, { level: 9 }))

// Report what went in, so a caller can eyeball the manifest.
const files = entries.filter((e) => e.type === '0')
const total = files.reduce((n, e) => n + e.body.length, 0)
console.log(`packed ${files.length} file(s), ${total} bytes uncompressed`)
for (const entry of files) console.log(`  ${entry.name} (${entry.body.length})`)
console.log(`sha256 ${createHash('sha256').update(readFileSync(out)).digest('hex')}`)
