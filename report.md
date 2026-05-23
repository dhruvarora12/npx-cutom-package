# Stack Doctor Report

_Generated: 2026-05-22_

Grade: B   3 warnings · 1 file affected


## Action Plan

### Priority 2 — Fix Soon

**[LOW] Enable removeOnComplete on queues**  
Why: Completed jobs accumulate in Redis indefinitely, consuming memory and slowing queue operations.  
Fix: `Add to defaultJobOptions: { removeOnComplete: { count: 100 } }`

**[LOW] Enable removeOnFail on queues**  
Why: Failed jobs accumulate in Redis indefinitely. Without a cap, the failed set grows unbounded.  
Fix: `Add to defaultJobOptions: { removeOnFail: { count: 50 } }`

**[LOW] Set job timeout on queues**  
Why: Jobs without a timeout can hang forever, blocking workers and causing the queue to stall.  
Fix: `Add to defaultJobOptions: { timeout: 30000 } (adjust to your expected max job duration)`

## Detected Libraries

- **bullmq** `^5.76.10` — redis-queue

## Source Files

Scanned 2 files — found Redis/queue imports in 2 files.

### `C:\Users\arora\AppData\Local\Temp\bullmq-test\src\queue.ts`
- `bullmq` as `Queue` (named, line 1)
### `C:\Users\arora\AppData\Local\Temp\bullmq-test\src\worker.ts`
- `bullmq` as `Worker` (named, line 1)

_Cache: no issues found ✓_

## Queue Analysis

3 warnings in 2 files analysed.

### `C:\Users\arora\AppData\Local\Temp\bullmq-test\src\queue.ts`

#### WARN — `queue-no-remove-on-complete`
**C:\Users\arora\AppData\Local\Temp\bullmq-test\src\queue.ts:2**  
removeOnComplete not configured — completed jobs will accumulate in Redis indefinitely.  
```
const emailQueue = new Queue('email', {
```
> Fix: defaultJobOptions: { removeOnComplete: { count: 100 } }

#### WARN — `queue-no-remove-on-fail`
**C:\Users\arora\AppData\Local\Temp\bullmq-test\src\queue.ts:2**  
removeOnFail not configured — failed jobs will accumulate in Redis indefinitely.  
```
const emailQueue = new Queue('email', {
```
> Fix: defaultJobOptions: { removeOnFail: { count: 50 } }

#### WARN — `queue-missing-timeout`
**C:\Users\arora\AppData\Local\Temp\bullmq-test\src\queue.ts:2**  
No job timeout in defaultJobOptions — jobs can hang indefinitely if they stall.  
```
const emailQueue = new Queue('email', {
```
> Fix: defaultJobOptions: { timeout: 30000 }

> Findings are based on static analysis and may include false positives. Review each before acting.
