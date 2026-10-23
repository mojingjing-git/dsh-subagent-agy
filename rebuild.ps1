<#
.SYNOPSIS
    Rebuild @dsh-external/dsh-subagent-antigravity into an installable tarball.

.DESCRIPTION
    One command for the whole release loop the plan asks for:

      1. check   — syntax of every shipped source file plus a load smoke test
      2. test    — the offline suite (simulated agy); fails the build on any
                   assertion failure
      3. pack    — `npm pack`-equivalent tarball with a standard `package/`
                   prefix, excluding node_modules
      4. verify  — unpack the tarball and confirm its contents match the
                   allowlist, that the version and mount id are intact, and
                   that no development file leaked in

    The real-agy end-to-end suite is NOT part of the build: it spends live
    quota and takes minutes. Run it separately with `-IncludeReal` (or
    `npm run test:real`).

.PARAMETER IncludeReal
    Also run test/e2e-real.mjs against the installed agy before packing.

.PARAMETER OutDir
    Where to write the tarball. Defaults to the plugin's parent directory.

.PARAMETER Keep
    Keep the verification scratch directory (for debugging a failed verify).

.EXAMPLE
    pwsh -File rebuild.ps1
    pwsh -File rebuild.ps1 -IncludeReal
#>
[CmdletBinding()]
param(
    [switch]$IncludeReal,
    [string]$OutDir,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = $PSScriptRoot
if (-not $OutDir) { $OutDir = Split-Path $root -Parent }
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

# Resolve the bundled node that DSH itself uses (a bare `node` may not be on PATH).
function Resolve-Node {
    if ($env:DSH_NODE) { return $env:DSH_NODE }
    $runtime = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $runtime) { return $runtime }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'node not found: set DSH_NODE or add node to PATH'
}
$node = Resolve-Node

function Step($name) { Write-Host "`n== $name ==" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  ok   $msg" -ForegroundColor Green }
function Die($msg)  { Write-Host "  FAIL $msg" -ForegroundColor Red; exit 1 }

# ── 1. check ────────────────────────────────────────────────────────────────
Step 'check'

$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
Ok "version $version ($($pkg.name))"

foreach ($file in @('lib/index.js', 'lib/types/index.d.ts')) {
    $path = Join-Path $root $file
    if (-not (Test-Path -LiteralPath $path)) { Die "missing $file" }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'lib') -Recurse -Filter '*.js') {
    & $node --check $file.FullName 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Die "syntax error in $($file.Name): $_" } }
}
Ok 'lib/*.js syntax'

# The mount id must survive every rebuild: it is the key existing profiles use.
$patch = Get-Content -LiteralPath (Join-Path $root 'cordis.patch.yml') -Raw
if ($patch -notmatch 'id:\s*dsh-subagent-antigravity') { Die 'cordis.patch.yml lost the mount id dsh-subagent-antigravity' }
if ($patch -notmatch [regex]::Escape($pkg.name)) { Die "cordis.patch.yml does not name $($pkg.name)" }
Ok 'mount id dsh-subagent-antigravity preserved'

# A load smoke test: the module must import and expose the documented surface.
$smoke = & $node -e @"
import('file:///' + process.argv[1].replace(/\\/g, '/')).then((m) => {
  const need = ['Config', 'apply', 'inject', 'name',
    'loadTaskRegistry', 'saveTaskRegistry', 'updateTaskRegistry', 'registryFilePath']
  const missing = need.filter((k) => m[k] === undefined)
  if (missing.length > 0) { console.error('missing exports: ' + missing.join(', ')); process.exit(1) }
  console.log('exports ok')
}).catch((e) => { console.error(String(e && e.stack || e)); process.exit(1) })
"@ (Join-Path $root 'lib/index.js') 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $smoke -notmatch 'exports ok') { Die "module load failed: $smoke" }
Ok 'module loads and exports the documented surface'

# ── 2. test ─────────────────────────────────────────────────────────────────
Step 'test (offline suite)'
$suite = & $node (Join-Path $root 'test/run.mjs') 2>&1 | Out-String
Write-Host $suite.TrimEnd()
$summary = [regex]::Match($suite, '(\d+)/(\d+) assertions passed')
if (-not $summary.Success) { Die 'offline suite produced no summary line' }
if ($summary.Groups[1].Value -ne $summary.Groups[2].Value) { Die "offline suite failed ($($summary.Groups[1].Value)/$($summary.Groups[2].Value))" }
Ok "offline suite $($summary.Groups[1].Value)/$($summary.Groups[2].Value)"

if ($IncludeReal) {
    Step 'test (real agy)'
    $real = & $node (Join-Path $root 'test/e2e-real.mjs') 2>&1 | Out-String
    Write-Host $real.TrimEnd()
    $rs = [regex]::Match($real, '(\d+)/(\d+) assertions passed')
    if (-not $rs.Success) { Die 'real suite produced no summary line' }
    if ($rs.Groups[1].Value -ne $rs.Groups[2].Value) { Die "real suite failed ($($rs.Groups[1].Value)/$($rs.Groups[2].Value))" }
    Ok "real suite $($rs.Groups[1].Value)/$($rs.Groups[2].Value)"
} else {
    Write-Host '  (real-agy suite skipped; pass -IncludeReal to run it)' -ForegroundColor DarkGray
}

# ── 3. pack ─────────────────────────────────────────────────────────────────
Step 'pack'

$allowed = @('package.json', 'lib', 'cordis.patch.yml', 'PATCH.md', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE')
foreach ($entry in $allowed) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $entry))) { Die "allowlisted entry missing: $entry" }
}

$tarball = Join-Path $OutDir ("dsh-external-dsh-subagent-antigravity-{0}.tgz" -f $version)
if (Test-Path -LiteralPath $tarball) { Remove-Item -LiteralPath $tarball -Force }

# Write a deterministic tar by hand: a standard `package/` prefix, sorted paths,
# and fixed mtimes so two builds of identical sources are byte-identical.
$packScript = Join-Path $root 'scripts/pack.mjs'
if (-not (Test-Path -LiteralPath $packScript)) { Die "missing scripts/pack.mjs" }
& $node $packScript $root $tarball
if ($LASTEXITCODE -ne 0) { Die 'packaging failed' }
$size = (Get-Item -LiteralPath $tarball).Length
Ok "$([System.IO.Path]::GetFileName($tarball)) ($size bytes)"

# ── 4. verify ───────────────────────────────────────────────────────────────
Step 'verify'

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-verify-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    # Expand via the bundled node (tar.exe is not guaranteed present).
    & $node -e @"
import('node:fs').then(async (fs) => {
  const zlib = await import('node:zlib')
  const path = await import('node:path')
  const [src, dest] = process.argv.slice(1)
  const buf = zlib.gunzipSync(fs.readFileSync(src))
  let off = 0, count = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim()
    const size = parseInt(sizeField, 8) || 0
    const type = String.fromCharCode(header[156])
    const target = path.join(dest, name)
    if (type === '5') { fs.mkdirSync(target, { recursive: true }) }
    else if (type === '0' || type === '\0' || type === '') {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buf.subarray(off + 512, off + 512 + size))
    } else { console.error('unexpected entry type ' + type + ' for ' + name); process.exit(1) }
    count += 1
    off += 512 + Math.ceil(size / 512) * 512
  }
  if (count === 0) { console.error('tarball is empty'); process.exit(1) }
  console.log('extracted ' + count + ' entries')
})
"@ $tarball $scratch 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Write-Host "  $($_.TrimEnd())" } }

    $pkgRoot = Join-Path $scratch 'package'
    if (-not (Test-Path -LiteralPath $pkgRoot)) { Die 'tarball has no standard package/ prefix' }
    Ok 'standard package/ prefix'

    $leaks = Get-ChildItem -LiteralPath $pkgRoot -Recurse -Force | Where-Object {
        $_.FullName.Substring($pkgRoot.Length + 1) -match '(^|[\\/])(node_modules|test|scripts|\.git)([\\/]|$)'
    }
    if ($leaks) { Die "development files leaked into the tarball: $($leaks[0].FullName.Substring($pkgRoot.Length + 1))" }
    Ok 'no node_modules/test/scripts leakage'

    $shipped = Get-Content -LiteralPath (Join-Path $pkgRoot 'package.json') -Raw | ConvertFrom-Json
    if ($shipped.version -ne $version) { Die "tarball version $($shipped.version) != $version" }
    Ok "tarball manifest reports $($shipped.version)"

    $shippedPatch = Get-Content -LiteralPath (Join-Path $pkgRoot 'cordis.patch.yml') -Raw
    if ($shippedPatch -notmatch 'id:\s*dsh-subagent-antigravity') { Die 'tarball patch lost the mount id' }
    Ok 'tarball patch keeps the mount id'

    foreach ($entry in @('lib/index.js', 'lib/types/index.d.ts', 'PATCH.md', 'README.md', 'README.zh.md', 'LICENSE')) {
        if (-not (Test-Path -LiteralPath (Join-Path $pkgRoot $entry))) { Die "tarball is missing $entry" }
    }
    Ok 'documentation and types included'

    # The shipped bundle must be the one that just passed the suite.
    $localHash = (Get-FileHash -LiteralPath (Join-Path $root 'lib/index.js') -Algorithm SHA256).Hash
    $shippedHash = (Get-FileHash -LiteralPath (Join-Path $pkgRoot 'lib/index.js') -Algorithm SHA256).Hash
    if ($localHash -ne $shippedHash) { Die 'shipped lib/index.js differs from the tested one' }
    Ok "shipped bundle matches the tested one (sha256 $($localHash.Substring(0,12))...)"
}
finally {
    if (-not $Keep) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Host "  (scratch kept at $scratch)" -ForegroundColor DarkGray }
}

Write-Host "`nBUILD OK — $tarball" -ForegroundColor Green
