import type { Redis } from 'ioredis';
import type { KeyScanResult, ScannedKey, NamespaceEntry } from '../types/live.js';
import {
  OVERSIZED_KEY_BYTES,
  KEY_SCAN_TIMEOUT_MS,
  KEY_SCAN_BATCH_SIZE,
  KEY_SCAN_NAMESPACE_TOP_N,
  KEY_SCAN_TOP_KEYS,
} from '../constants.js';

const NO_TTL_WARNING_THRESHOLD = 0.3; // 30%

// ---------------------------------------------------------------------------
// Namespace helpers
// ---------------------------------------------------------------------------

function extractPrefix(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? '(no prefix)' : key.slice(0, idx + 1);
}

function buildNamespaces(
  keys: ScannedKey[],
  totalMemory: number,
): NamespaceEntry[] {
  const map = new Map<string, { keyCount: number; memoryBytes: number }>();

  for (const k of keys) {
    const prefix = extractPrefix(k.key);
    const existing = map.get(prefix);
    if (existing !== undefined) {
      existing.keyCount += 1;
      existing.memoryBytes += k.memoryBytes;
    } else {
      map.set(prefix, { keyCount: 1, memoryBytes: k.memoryBytes });
    }
  }

  const entries: NamespaceEntry[] = [];
  for (const [prefix, { keyCount, memoryBytes }] of map) {
    entries.push({
      prefix,
      keyCount,
      memoryBytes,
      memoryPercent:
        totalMemory > 0
          ? Math.round((memoryBytes / totalMemory) * 100 * 100) / 100
          : 0,
    });
  }

  entries.sort((a, b) => b.keyCount - a.keyCount);
  return entries.slice(0, KEY_SCAN_NAMESPACE_TOP_N);
}

// ---------------------------------------------------------------------------
// Pipeline batch inspection
// ---------------------------------------------------------------------------

async function inspectBatch(
  client: Redis,
  batch: string[],
): Promise<ScannedKey[]> {
  const pipeline = client.pipeline();
  for (const key of batch) {
    pipeline.ttl(key);
    pipeline.object('idletime', key);
    pipeline.memory('usage', key);
  }

  const results = await pipeline.exec();
  const scannedKeys: ScannedKey[] = [];

  for (let i = 0; i < batch.length; i++) {
    const key = batch[i]!;
    const base = i * 3;

    const ttlEntry  = results?.[base];
    const idleEntry = results?.[base + 1];
    const memEntry  = results?.[base + 2];

    const ttl =
      ttlEntry !== undefined && ttlEntry[0] === null && typeof ttlEntry[1] === 'number'
        ? ttlEntry[1]
        : -1;
    const idleSeconds =
      idleEntry !== undefined && idleEntry[0] === null && typeof idleEntry[1] === 'number'
        ? idleEntry[1]
        : 0;
    const memoryBytes =
      memEntry !== undefined && memEntry[0] === null && typeof memEntry[1] === 'number'
        ? memEntry[1]
        : 0;

    scannedKeys.push({ key, ttl, idleSeconds, memoryBytes });
  }

  return scannedKeys;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function scanKeys(
  client: Redis,
  sampleSize: number,
  idleThresholdDays: number,
  onProgress?: (scanned: number, total: number) => void,
): Promise<KeyScanResult> {
  const idleThresholdSeconds = idleThresholdDays * 86_400;
  const startTime = Date.now();
  const collectedKeys: string[] = [];
  let cursor = '0';
  let truncated = false;

  // ── Phase 1: SCAN db0 until sampleSize collected, cursor wraps, or timeout ──
  do {
    if (Date.now() - startTime > KEY_SCAN_TIMEOUT_MS) {
      truncated = true;
      break;
    }

    const [nextCursor, keys] = await client.scan(cursor, 'COUNT', 100);

    for (const key of keys) {
      collectedKeys.push(key);
      if (collectedKeys.length >= sampleSize) break;
    }

    cursor = nextCursor;
  } while (cursor !== '0' && collectedKeys.length < sampleSize);

  // Trim to exact sampleSize in case last batch pushed us over
  const keysToInspect = collectedKeys.slice(0, sampleSize);

  // ── Phase 2: Pipeline inspection in batches of KEY_SCAN_BATCH_SIZE ──
  const allScanned: ScannedKey[] = [];
  const batches: string[][] = [];
  for (let i = 0; i < keysToInspect.length; i += KEY_SCAN_BATCH_SIZE) {
    batches.push(keysToInspect.slice(i, i + KEY_SCAN_BATCH_SIZE));
  }

  for (const batch of batches) {
    if (Date.now() - startTime > KEY_SCAN_TIMEOUT_MS) {
      truncated = true;
      break;
    }

    const results = await inspectBatch(client, batch);
    allScanned.push(...results);
    onProgress?.(allScanned.length, keysToInspect.length);
  }

  // ── Phase 3: Aggregate ──
  const scanned = allScanned.length;
  const noTtlCount = allScanned.filter(k => k.ttl === -1).length;
  const noTtlPercent =
    scanned > 0 ? Math.round((noTtlCount / scanned) * 100 * 100) / 100 : 0;

  const idleKeys = allScanned
    .filter(k => k.idleSeconds >= idleThresholdSeconds)
    .sort((a, b) => b.idleSeconds - a.idleSeconds)
    .slice(0, KEY_SCAN_TOP_KEYS);

  const oversizedKeys = allScanned
    .filter(k => k.memoryBytes >= OVERSIZED_KEY_BYTES)
    .sort((a, b) => b.memoryBytes - a.memoryBytes)
    .slice(0, KEY_SCAN_TOP_KEYS);

  const totalMemory = allScanned.reduce((sum, k) => sum + k.memoryBytes, 0);
  const namespaces = buildNamespaces(allScanned, totalMemory);

  // ── Phase 4: Warnings ──
  const warnings: string[] = [];

  if (scanned > 0 && noTtlCount / scanned > NO_TTL_WARNING_THRESHOLD) {
    warnings.push(
      `${noTtlPercent.toFixed(1)}% of sampled keys have no TTL — consider setting expiry to prevent unbounded growth`,
    );
  }

  if (truncated) {
    warnings.push(
      `Key scan hit the ${KEY_SCAN_TIMEOUT_MS / 1000}s time limit — only ${scanned} of up to ${sampleSize} keys were inspected`,
    );
  }

  return {
    scanned,
    noTtlCount,
    noTtlPercent,
    idleKeys,
    oversizedKeys,
    namespaces,
    truncated,
    warnings,
  };
}
