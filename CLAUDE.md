# stack-doctor — Working Agreement

A Node.js CLI (TypeScript) that scans a backend project's codebase and inspects
a live Redis instance, reporting on caching and queuing usage: libraries detected,
anti-patterns, health, capacity, dead data, and concrete recommendations. Published to npm.

## Locked-in decisions (Phase 1)

- **Package name:** `stack-doctor` (verified available on npm)
- **Scope v1:** Everything that touches Redis — caching (`ioredis`, `redis`,
  `@redis/client`, `@redis/*`) and queuing (`bullmq`, `bull`, `bee-queue`).
  Broader caching techniques (Memcached, in-memory, framework caches) deferred to v2.
- **Build tool:** tsup, ESM only, Node ≥ 20
- **CLI parser:** commander v12 (0 transitive deps)
- **Runtime deps:** commander only
- **Two modes:** static (default) + live (`--live`, Phase 6+)
- **Live mode is read-only:** `SCAN` not `KEYS *`, no mutating commands ever,
  confirmation banner before connecting, 5s connection timeout
- **Detection strategy Phase 1:** `package.json` scan only. AST/import-level in Phase 3.
- **Monorepo:** shallow (root `package.json` only) for v1

## v1 CLI interface (established in Phase 1, no breaking changes after this)

```
stack-doctor [path]
  -o, --output <text|json|markdown>     (default: text)
  -v, --verbose
  --no-color
  --skip-cache
  --skip-queues
  --live                                (Phase 6+)
  --redis-url <url>                     (Phase 6+, requires --live)
  --env-file <path>                     (Phase 6+, default: .env)
  --sample-size <n>                     (Phase 8+, default: 1000)
  --idle-threshold <days>               (Phase 9+, default: 30)
```

## Deferred to v2+

Memcached, in-memory caches (lru-cache, node-cache), framework caches
(NestJS CacheModule, Next.js), HTTP/CDN cache headers, RabbitMQ, Kafka,
AWS SQS, library-API-based queue inspection.

## Collaboration rules

These rules govern how Claude works with me on this project. They apply to every session.

### File writes require explicit approval
- **Never create or modify a file until I say "go" for that specific file.**
- Show proposed content in chat first, wait for approval, then write.
- "Go" approves one file. It does not generalize to other files in the same task.

### Clarify before proposing
- For each task, ask **3–5 clarifying questions** about preferences and constraints first.
- Do not propose solutions until I answer.

### Options before recommendations
- After my answers, present **2–3 options with tradeoffs**.
- Then recommend one — but make it something I can redirect.

### Minimal working version first
- Start with the smallest thing that works.
- No extra features, no speculative abstractions, no "we might need this later".
- No dependencies we don't need yet.

### One task at a time
- After each task, **stop and wait for me to test** before moving to the next.
- Do not chain tasks together.

### Dependency disclosure
- When suggesting a dependency, report:
  - Install size (bundlephobia)
  - Number of transitive deps
- If you can't verify these, say so — don't guess.

### TypeScript standards
- `strict` mode enabled.
- No `any`.
- Explicit return types on exported functions.
