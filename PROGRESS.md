# stack-doctor — Progress

## Phase Status

| Phase | Track | Description | Status |
|-------|-------|-------------|--------|
| 1 | Foundation | Scaffolding, CLI flags, project detection | ✅ Done |
| 2 | Static | File scanner — walk source files, map imports | ✅ Done |
| 3 | Static | Cache analysis — missing TTLs, stampede risk, over/under-caching | ✅ Done |
| 4 | Static | Queue analysis — retry policy, DLQ, concurrency, stalled job config | ⬜ Pending |
| 5 | Static | Report generation — text / JSON / markdown, recommendations engine | ⬜ Pending |
| 6 | Live | Redis connection layer — safety banner, auth, timeout, env file | ⬜ Pending |
| 7 | Live | Live cache inspection — INFO, SCAN, TTL, OBJECT IDLETIME, MEMORY USAGE | ⬜ Pending |
| 8 | Live | Live queue inspection — BullMQ/Bull key patterns, depths, failed/stalled counts | ⬜ Pending |
| 9 | Live | Cross-mode analysis — static intent vs. live reality | ⬜ Pending |
| 10 | Live | Recommendations engine — prioritized, actionable, with fix snippets | ⬜ Pending |
| 11 | Integration | CI/CD — exit codes, --fail-on, .stack-doctorrc config file | ⬜ Pending |
| 12 | Polish | DX — progress indicators, --watch mode, interactive terminal | ⬜ Pending |
| 13 | Publish | README, npm publish, GitHub Actions, changelog | ⬜ Pending |

## Phase 1 — Done

**Completed:** 2026-05-19

### What was built
- `package.json` — ESM, Node ≥ 20, single runtime dep (commander)
- `tsconfig.json` — strict mode, NodeNext module resolution
- `tsup.config.ts` — dual entry (CLI binary + programmatic API), shebang on CLI
- `src/types/index.ts` — `DetectedClient`, `DetectionResult`, `CliOptions`
- `src/core/detect.ts` — `detectProject()` scans root `package.json` for Redis/queue libs
- `src/cli/index.ts` — full v1 flag interface, validation, static report (text/json/markdown)
- `src/index.ts` — programmatic API re-exports

### Deferred from Phase 1
- AST/import-level detection → Phase 3
- Anti-pattern analysis → Phases 3–4
- Live Redis connection → Phase 6
- Monorepo workspace scanning → v1 end or v2

## Phase 2 — Done

**Completed:** 2026-05-20

### What was built
- `src/config/constants.ts` — `SCAN_EXTENSIONS`, `SCAN_IGNORE_DIRS`, `SCAN_FILE_SIZE_LIMIT_BYTES`, `SCAN_FILE_COUNT_WARNING`, `SCAN_FILE_COUNT_HARD_LIMIT`, `BABEL_PARSER_PLUGINS`
- `src/types/scan.ts` — `ImportStyle`, `ImportRecord`, `SkippedFile`, `ScannedFile`, `ScanStats`, `ScanResult`
- `src/core/walker.ts` — `walkSourceFiles()` using fdir + ignore; respects `.gitignore`; hard-coded ignore dirs; no symlink follow; file-count warning + hard stop
- `src/core/parser.ts` — `parseFile()` with size cap (500 KB), binary detection (null-byte scan), Babel parse with `decorators-legacy`/`typescript`/`jsx`/`importMeta`/`dynamicImport` plugins; structured `SkippedFile` on any failure
- `src/core/mapper.ts` — `mapImports()` walks Babel AST; handles all 7 import styles: ESM default/named/namespace, dynamic import, CJS require, destructured require, unbound require
- `src/core/scanner.ts` — `scanFiles()` orchestrator; sequential parse; ASTs cached in `ScannedFile.ast` for Phase 3; `getAst()` helper
- `src/types/index.ts` — re-exports all scan types
- `src/index.ts` — re-exports `scanFiles` and `getAst`
- `src/cli/index.ts` — wired up scanner; text/JSON/markdown all show `"Scanned N files — found imports in M files."`; skipped-file summary in default mode; detailed stats + per-file reasons in `--verbose`

### New runtime deps added
- `fdir` (~50 KB, 0 transitive deps)
- `ignore` (~30 KB, 0 transitive deps)
- `@babel/parser` (~1.5 MB, 3 transitive deps: @babel/types, @babel/helper-validator-identifier, @nicolo-ribaudo/chm-shim)

### Deferred from Phase 2
- Re-export tracking (`export { default } from 'lib'`) → Phase 3
- Variable flow / alias tracking within a file → Phase 3
- Vue/Svelte script-block extraction → v2
- Symlink following → v2 (`--follow-symlinks`)

## Phase 3 — Done

**Completed:** 2026-05-20

### What was built
- `src/types/findings.ts` — `FindingSeverity`, `FindingRule`, `Finding`, `CacheAnalysisResult`
- `src/core/analyze-cache.ts` — `analyzeCache(scanResult)` — walks cached Babel ASTs, resolves client variable bindings (one level deep), detects 4 rules across ioredis and redis v4 / @redis/client
- Modified `src/types/scan.ts` — added `source: string` to `ScannedFile` for snippet extraction
- Modified `src/core/parser.ts` — threads source string through `ParseOutcome`
- Modified `src/core/scanner.ts` — stores `source` in `ScannedFile`
- Updated `src/config/constants.ts` — added `FINDINGS_DISCLAIMER`
- Updated CLI — findings printed in text/JSON/markdown; `--skip-cache` suppresses analysis

### Rules implemented
| Rule | Severity | Trigger |
|------|----------|---------|
| `missing-ttl` | warn | `set()` with no EX/PX/EXAT/PXAT/KEEPTTL |
| `setnx-no-expiry` | error | `setnx()`, `setNX()`, or `set(…NX)` without expiry |
| `zero-ttl` | error | TTL argument is literal `0` |
| `negative-ttl` | error | TTL argument is a negative literal |

### Deferred from Phase 3
- Stampede risk, hard-coded keys, missing error handling → Phase 5 / v2
- Variable tracing beyond one level → deferred indefinitely
- `// stack-doctor: ignore` suppression → Phase 11
