# Development

Build, test, and release for this plugin.

## Layout

```
src/          source — index.ts plus one module per data source, and client.js
lib/          build output (committed on purpose — see below)
test/         suites; run.mjs is the main one, panel-*.mjs the panel specifics
scripts/      build.mjs, pack.mjs, selftest.mjs
docs/         everything in [docs/README.md](README.md)
```

`lib/` is **tracked in git** even though it is generated. Users install this
plugin from GitHub, so `lib/index.js` must work without a build step. CI rebuilds
it and fails if it differs from what is committed — that catches the "source
changed, rebuild forgotten" case where tests pass against stale output.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile `src/` → `lib/`, then copy and verify the client bundle |
| `npm test` | Build, then run the main offline suite against a simulated agy |
| `npm run test:panel` | Build, then run the twelve panel/data-source suites |
| `npm run typecheck` | Type-check without emitting |
| `npm run pack` | Produce a deterministic tarball for `dsh plugin add` |
| `npm run test:e2e` | Real two-turn conversation against a logged-in agy |
| `npm run selftest` | Check the local agy installation |

`test:e2e` spends real quota and is the only suite that touches the network.
Run it deliberately.

## Build: choosing a tsconfig

The build must work in two genuinely different environments, and they cannot
share one config.

- **A local DSH install** may ship no `.d.ts` for its peers even though each
  `package.json` advertises a `types` field. Every peer import degrades to `any`,
  and module augmentation becomes illegal. The local shim supplies declarations.
- **A clean clone** installs peers with real types. There the shim would *shadow*
  the real module and break the augmentation — which is how this plugin registers
  its job kind.

So the build probes for real peer declarations and picks the matching tsconfig.
The check is stricter than "file exists": some installs contain 11-byte
`export {}` stubs that exist, are non-empty, and declare nothing. A declaration
must be substantial to count.

`lib/` is deleted before every compile, because tsc never removes stale output —
rename a module and its old artifacts would otherwise ship.

### The client load guard

The browser bundle is hand-written plain JS, not compiled. Nobody type-checks it,
and the failure mode is severe: if it fails to evaluate, DSH reports
`web boot: 1 entry did not activate` and the sidebar renders blank, with nothing
pointing at this plugin.

The build therefore evaluates the copied bundle the way the web loader does — a
**classic script**, with `window` and `fetch` but no `module`, `exports`, or
`require` — and asserts that it registers itself and returns `{name, inject,
apply}`. A bundle missing its CommonJS shell fails the build rather than the next
DSH boot.

## Testing

No third-party framework. Each suite is a script that collects named checks and
prints a tally; failures list their names and details.

The main suite runs the **real compiled plugin** against fakes:

- a fake Cordis context providing `subagents`, `subprocess`, `tools`, and `jobs`
- a subprocess shim backed by genuine child processes, exercising collect-mode
  output, offset reads, and tree termination
- a fake `agy` binary reproducing many protocol scenarios — including one that
  needs a wrapper script, because Windows mangles multi-line arguments on a bare
  command line

Each case gets an isolated scratch directory for its registry and probe cache, so
nothing leaks into the developer's real `~/.dsh` and no case can see another's
task keys.

The panel suites are narrower and faster: sources and routes, streaming behavior,
the client bundle contract, then one suite per data-source module.

**Every endpoint the client posts to must exist in the host routes.** That
cross-check lives in the client contract suite — a mismatch produces a panel that
silently does nothing.

## Deterministic packaging

`scripts/pack.mjs` writes a tar by hand rather than using `npm pack`, which would
run lifecycle hooks and stamp files with the current time. Entries are sorted,
carry a fixed mtime, and are gzipped deterministically, so **two builds of
identical sources are byte-identical** and can be diffed.

`rebuild.ps1` chains the whole release path — build, test, pack, then unpack into
a scratch directory to verify nothing unwanted (tests, scripts, dependencies)
leaked into the archive.

Both reference the same file allowlist. **Adding a shipped file means updating
`package.json` `files`, the pack allowlist, and the rebuild verification.**

## Consuming the package

`cordis.patch.yml` mounts the plugin under its id. That id is load-bearing: it is
the key existing profiles use, so it must not change even if the package name
does.
