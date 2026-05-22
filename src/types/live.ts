export interface ScannedKey {
  key: string;
  ttl: number;          // -1 = no expiry, -2 = expired/missing
  idleSeconds: number;
  memoryBytes: number;
}

export interface NamespaceEntry {
  prefix: string;       // e.g. "user:", "session:", "(no prefix)"
  keyCount: number;
  memoryBytes: number;
  memoryPercent: number;
}

export interface KeyScanResult {
  scanned: number;
  noTtlCount: number;
  noTtlPercent: number;
  idleKeys: ScannedKey[];        // top KEY_SCAN_TOP_KEYS by idleSeconds desc
  oversizedKeys: ScannedKey[];   // top KEY_SCAN_TOP_KEYS by memoryBytes desc
  namespaces: NamespaceEntry[];  // top KEY_SCAN_NAMESPACE_TOP_N by keyCount desc
  truncated: boolean;            // true if 30s limit hit before sampleSize reached
  warnings: string[];
}

export interface QueueScanEntry {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  hasStalled: boolean;
  warnings: string[];
}

export interface QueueScanResult {
  queues: QueueScanEntry[];
  totalFailed: number;
  totalWaiting: number;
  warnings: string[];            // cross-queue warnings (reserved for Phase 10+)
}

export interface LiveRedisResult {
  connected: boolean;
  host: string;
  redisVersion: string;
  uptimeSeconds: number;
  connectedClients: number;
  memory: {
    usedBytes: number;
    usedHuman: string;
    maxBytes: number;
    maxHuman: string;
    usagePercent: number;
    fragmentationRatio: number;
    evictionPolicy: string;
  };
  keyspace: {
    totalKeys: number;
    keysWithTtl: number;
    keysWithoutTtl: number;
    databases: Array<{ db: number; keys: number; expires: number }>;
  };
  cacheHitRate: number | null;
  warnings: string[];
  queueScan: QueueScanResult | null;  // null if --skip-queues or no queue keys found
  keyScan: KeyScanResult | null;      // null if Redis has 0 keys
}
