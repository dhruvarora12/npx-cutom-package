# stack-doctor — Progress

## Phase Status

| Phase | Track | Description | Status |
|-------|-------|-------------|--------|
| 1 | Foundation | Scaffolding, CLI flags, project detection | ✅ Done |
| 2 | Static | File scanner — walk source files, map imports | ⬜ Pending |
| 3 | Static | Cache analysis — missing TTLs, stampede risk, over/under-caching | ⬜ Pending |
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
