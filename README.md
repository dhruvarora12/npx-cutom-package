# stack-doctor

> Static + live analysis of Redis caching and queuing in Node.js backends.

[![npm version](https://img.shields.io/npm/v/stack-doctor)](https://www.npmjs.com/package/stack-doctor)
[![license](https://img.shields.io/npm/l/stack-doctor)](LICENSE)
[![node](https://img.shields.io/node/v/stack-doctor)](package.json)


https://www.npmjs.com/package/stack-doctor
## What it does

stack-doctor scans your Node.js backend and produces a health report for your Redis setup — what caching and queuing libraries you use, what's misconfigured, and what's happening in your live Redis instance right now.

It works in two modes: **static analysis** (reads your source code, no network connection needed) and **live inspection** (`--live`, connects read-only to your Redis instance). Both modes produce a graded report with a prioritised action plan.

## Install

```bash
# One-off (no install required)
npx stack-doctor ./my-app

# Global install
npm install -g stack-doctor
stack-doctor ./my-app
```

## Quick start

```bash
# Basic static scan
stack-doctor ./my-app

# With live Redis inspection
stack-doctor ./my-app --live --redis-url redis://localhost:6379

# CI — exit 1 if any error-severity findings
stack-doctor ./my-app --fail-on error
```

## Supported libraries

**Cache clients:** `ioredis`, `redis`, `@redis/client`, `@redis/*`

**Queue libraries:** `bullmq`, `bull`, `bee-queue` (detected; deep analysis planned for v2)

## What it detects

### Static analysis

| Rule | Severity | Description |
|------|----------|-------------|
| `setnx-no-expiry` | error | `SETNX` / `set(..., 'NX')` without an expiry — permanent lock if process crashes |
| `zero-ttl` | error | TTL value of `0` — treated as no expiry by Redis |
| `negative-ttl` | error | Negative TTL — causes an error or immediate expiry depending on the command |
| `missing-ttl` | warn | `SET` calls with no expiry — keys grow unbounded over time |
| `queue-missing-attempts` | warn | No retry limit — failed jobs are permanently lost on first failure |
| `queue-no-remove-on-complete` | warn | Completed jobs accumulate in Redis indefinitely |
| `queue-no-remove-on-fail` | warn | Failed jobs accumulate in Redis indefinitely |
| `queue-missing-timeout` | warn | Jobs with no timeout can hang forever, stalling workers |
| `queue-default-concurrency` | warn | Worker concurrency not set — defaults to 1, underutilises resources |
| `queue-missing-stalled-interval` | warn | No stalled job detection — crashed jobs are silently lost |

### Live inspection (`--live`)

- **Memory:** usage %, configured limit, eviction policy, fragmentation ratio
- **Key sampling:** TTL coverage, idle keys (beyond `--idle-threshold`), oversized keys, top namespaces by key count
- **Queue health:** waiting / active / failed / delayed job counts per queue, stalled queue detection
- **Cross-mode:** live data confirms or contradicts static findings (e.g. `missing-ttl` confirmed when production keys have no TTL)

## Output formats

| Mode | How to invoke | Notes |
|------|---------------|-------|
| Auto-save *(default)* | No `--output` flag | Saves `stack-doctor-report-YYYY-MM-DD.md` in the target directory |
| Text | `--output text` | Coloured output to stdout |
| JSON | `--output json` | Machine-readable; suitable for custom CI scripting |
| Markdown | `--output markdown` | Prints markdown to stdout |

## All flags

| Flag | Description | Default |
|------|-------------|---------|
| `[path]` | Target project directory | current directory |
| `-o, --output <format>` | Output format: `text`, `json`, `markdown` | auto-save markdown |
| `-v, --verbose` | Enable verbose output | `false` |
| `--no-color` | Disable coloured output | — |
| `--skip-cache` | Skip cache static analysis | `false` |
| `--skip-queues` | Skip queue static analysis | `false` |
| `--live` | Run live Redis inspection | `false` |
| `--redis-url <url>` | Redis connection URL (requires `--live`) | — |
| `-y, --yes` | Skip safety countdown for CI use | `false` |
| `--sample-size <n>` | Number of keys to sample in live mode | `1000` |
| `--idle-threshold <days>` | Days before a key is considered idle | `30` |
| `--fail-on <level>` | Exit 1 when findings at or above this severity: `error`, `warn`, `any` | — (always exit 0) |

## `.stack-doctorrc` config file

Place `.stack-doctorrc` in your project root (or the directory you're scanning). All fields are optional. CLI flags always override config file values.

```json
{
  "output": "text",
  "failOn": "error",
  "skipCache": false,
  "skipQueues": false,
  "redisUrl": "redis://localhost:6379",
  "sampleSize": 1000,
  "idleThreshold": 30,
  "ignore": [
    "dist/**",
    "coverage/**",
    "**/*.test.ts"
  ]
}
```

## CI/CD integration

Use `--fail-on` to gate your pipeline on static findings. Live advisories never trigger `--fail-on` — only static findings count, keeping CI deterministic.

```yaml
# .github/workflows/stack-doctor.yml
name: stack-doctor

on:
  push:
    branches: [main]
  pull_request:

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run stack-doctor
        run: npx stack-doctor@latest . --fail-on error --output json
```

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Clean — no findings at or above the `--fail-on` threshold |
| `1` | Findings at or above the `--fail-on` threshold |
| `2` | Tool error (bad flags, connection failure, unexpected error) |
| `3` | Invalid `.stack-doctorrc` config |

## Grading scale

Grades are computed from **static findings only**. Live inspection data appears separately in the report and action plan.

| Grade | Condition |
|-------|-----------|
| **A** | No findings |
| **B** | Warnings only (1–3) |
| **C** | 1–2 errors, or 4+ warnings |
| **D** | 3–5 errors |
| **F** | 6 or more errors |

## Requirements

- Node.js ≥ 20
- Redis 4+ for live memory inspection (`MEMORY USAGE`, `OBJECT IDLETIME`)
- Read-only Redis access is sufficient — no write commands are ever issued in `--live` mode

## License

MIT © Dhruv Arora
