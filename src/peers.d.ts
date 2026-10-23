// Local-only ambient declarations for building against a DSH install whose
// packages ship no `.d.ts` files.
//
// DSH 0.2.1-rc.2 declares `"types": "lib/types/index.d.ts"` in each peer's
// package.json but publishes no declaration files, so TypeScript reports
// TS7016 for every peer import and refuses module augmentation of them.
// This file is NOT used in CI: there the real peers resolve their own
// declarations (see tsconfig.typecheck.json), which is the check that actually
// validates the seam. These are deliberately loose — enough to compile and to
// keep the augmentation legal, not a substitute for the real types.

declare module '@deepseek-ai/dsh-subagent' {
  export interface SubagentResult {
    readonly output: ContentBlock[]
    readonly structured?: unknown
    readonly diagnostic?: string
    readonly stopReason: string
    // NOTE: intentionally does NOT declare `transcript`. src/index.ts augments
    // this interface to add that field, and TypeScript errors with TS2665/TS2664
    // ("Invalid module name in augmentation") when the shim is present but the
    // module cannot be augmented — while declaring the field here too would make
    // the augmentation a redundant re-declaration. Leaving it out keeps the shim
    // a plain untyped stand-in and lets the single real augmentation in
    // src/index.ts remain the only place `transcript` is introduced.
  }
  export type SubagentStartRequest = any
  export type ResolvedSubagentStartRequest = any
  export type SubagentProvider = any
  export type SubagentRun = any
  export const NO_START_CAPABILITIES: any
  export function assertPositiveFinite(prefix: string, field: string, value: number): void
  export function settleRunResult(parts: any): Promise<SubagentResult>
  export function subprocessRunHandle(parts: any): SubagentRun
}

declare module '@deepseek-ai/dsh-jobs' {
  export interface JobKindMap {
    antigravity: 'antigravity'
  }
}
