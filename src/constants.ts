export const OVERSIZED_KEY_BYTES      = 524_288; // 512 KB
export const KEY_SCAN_TIMEOUT_MS      = 30_000;  // 30 seconds hard limit
export const KEY_SCAN_BATCH_SIZE      = 50;      // keys per pipeline batch
export const KEY_SCAN_NAMESPACE_TOP_N = 10;
export const KEY_SCAN_TOP_KEYS        = 10;      // top idle / oversized to surface

export const QUEUE_FAILED_WARN_THRESHOLD    = 1;        // any failed jobs
export const QUEUE_ACTIVE_WARN_THRESHOLD    = 100;
export const QUEUE_WAITING_WARN_THRESHOLD   = 1_000;
export const QUEUE_COMPLETED_WARN_THRESHOLD = 10_000;
