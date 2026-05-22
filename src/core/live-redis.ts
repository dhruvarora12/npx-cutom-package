import { Redis } from 'ioredis';
import type { LiveRedisResult } from '../types/live.js';
import { scanKeys } from './scan-keys.js';
import { scanQueues } from './scan-queues.js';

const CONNECTION_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseInfo(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

async function fetchInfo(
  client: Redis,
  section: string,
): Promise<Record<string, string>> {
  const raw = await client.info(section);
  return parseInfo(raw);
}

/**
 * Runs CONFIG GET <key> and returns the value string, or null if the command
 * is unavailable (managed Redis, ACL restriction, etc.). Never throws.
 */
async function fetchConfigGet(
  client: Redis,
  key: string,
  warnings: string[],
): Promise<string | null> {
  try {
    const result = await client.config('GET', key);
    // ioredis returns [key, value] or [] if unset
    if (Array.isArray(result) && result.length === 2) {
      return result[1] ?? null;
    }
    return null;
  } catch {
    warnings.push(
      'CONFIG GET unavailable (managed Redis?) — eviction policy sourced from INFO memory only',
    );
    return null;
  }
}

function parseKeyspace(
  info: Record<string, string>,
): LiveRedisResult['keyspace'] {
  const databases: Array<{ db: number; keys: number; expires: number }> = [];
  let totalKeys = 0;
  let keysWithTtl = 0;

  for (const [k, v] of Object.entries(info)) {
    // keys match pattern: db0, db1, db2, ...
    if (!/^db\d+$/.test(k)) continue;
    // value format: keys=N,expires=M,avg_ttl=P
    const keysMatch = /keys=(\d+)/.exec(v);
    const expiresMatch = /expires=(\d+)/.exec(v);
    const db = parseInt(k.slice(2), 10);
    const keys = keysMatch ? parseInt(keysMatch[1]!, 10) : 0;
    const expires = expiresMatch ? parseInt(expiresMatch[1]!, 10) : 0;
    databases.push({ db, keys, expires });
    totalKeys += keys;
    keysWithTtl += expires;
  }

  databases.sort((a, b) => a.db - b.db);

  return {
    totalKeys,
    keysWithTtl,
    keysWithoutTtl: totalKeys - keysWithTtl,
    databases,
  };
}

function computeCacheHitRate(
  statsInfo: Record<string, string>,
): number | null {
  const hits = parseInt(statsInfo['keyspace_hits'] ?? '', 10);
  const misses = parseInt(statsInfo['keyspace_misses'] ?? '', 10);
  if (isNaN(hits) || isNaN(misses)) return null;
  const total = hits + misses;
  if (total === 0) return null;
  return Math.round((hits / total) * 100 * 100) / 100; // 2 decimal places
}

function buildWarnings(
  result: Omit<LiveRedisResult, 'warnings' | 'keyScan' | 'queueScan'>,
): string[] {
  const w: string[] = [];

  if (result.memory.maxBytes === 0) {
    w.push('No maxmemory limit set — Redis may grow unbounded');
  } else if (result.memory.usagePercent >= 80) {
    w.push(
      `Memory usage at ${result.memory.usagePercent.toFixed(1)}% of limit`,
    );
  }

  if (result.memory.fragmentationRatio >= 1.5) {
    w.push(
      `High memory fragmentation ratio: ${result.memory.fragmentationRatio.toFixed(2)} (expected < 1.5)`,
    );
  }

  if (result.cacheHitRate !== null && result.cacheHitRate < 50) {
    w.push(
      `Low cache hit rate: ${result.cacheHitRate.toFixed(1)}% (expected >= 50%)`,
    );
  }

  if (
    result.memory.evictionPolicy === 'noeviction' &&
    result.memory.maxBytes > 0
  ) {
    w.push(
      'Eviction policy is noeviction — Redis will return errors when memory is full',
    );
  }

  return w;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function analyzeLive(
  redisUrl: string,
  options?: {
    sampleSize?: number;
    idleThresholdDays?: number;
    skipQueues?: boolean;
    onProgress?: (scanned: number, total: number) => void;
  },
): Promise<LiveRedisResult> {
  const sampleSize = options?.sampleSize ?? 1000;
  const idleThresholdDays = options?.idleThresholdDays ?? 30;

  const client = new Redis(redisUrl, {
    connectTimeout: CONNECTION_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
    enableReadyCheck: false,
  });

  // Collect CONFIG GET warnings separately so they merge into final warnings
  const configWarnings: string[] = [];

  // Suppress ioredis's default unhandled-error-event stderr output.
  // The error still propagates via the rejected connect() promise.
  client.on('error', () => { /* handled by caller */ });

  try {
    await client.connect();
    await client.ping();

    const [serverInfo, memInfo, statsInfo, keyspaceInfo, clientsInfo] =
      await Promise.all([
        fetchInfo(client, 'server'),
        fetchInfo(client, 'memory'),
        fetchInfo(client, 'stats'),
        fetchInfo(client, 'keyspace'),
        fetchInfo(client, 'clients'),
      ]);

    // --- memory ---
    const usedBytes = parseInt(memInfo['used_memory'] ?? '0', 10);
    const usedHuman = memInfo['used_memory_human'] ?? '0B';
    const maxBytes = parseInt(memInfo['maxmemory'] ?? '0', 10);
    const maxHuman = memInfo['maxmemory_human'] ?? '0B';
    const usagePercent =
      maxBytes > 0
        ? Math.round((usedBytes / maxBytes) * 100 * 100) / 100
        : 0;
    const fragmentationRatio = parseFloat(
      memInfo['mem_fragmentation_ratio'] ?? '1',
    );

    // Eviction policy: prefer INFO memory (Redis 7+), fall back to CONFIG GET
    let evictionPolicy: string = memInfo['maxmemory_policy'] ?? '';
    if (!evictionPolicy) {
      const configPolicy = await fetchConfigGet(
        client,
        'maxmemory-policy',
        configWarnings,
      );
      evictionPolicy = configPolicy ?? 'unknown';
      if (evictionPolicy === 'unknown') {
        configWarnings.push(
          'Could not determine eviction policy — set evictionPolicy to unknown',
        );
      }
    }

    // --- keyspace ---
    const keyspace = parseKeyspace(keyspaceInfo);

    // --- cache hit rate ---
    const cacheHitRate = computeCacheHitRate(statsInfo);

    // --- connected clients ---
    const connectedClients = parseInt(
      clientsInfo['connected_clients'] ?? '0',
      10,
    );

    const partial: Omit<LiveRedisResult, 'warnings' | 'keyScan' | 'queueScan'> = {
      connected: true,
      host: redisUrl,
      redisVersion: serverInfo['redis_version'] ?? 'unknown',
      uptimeSeconds: parseInt(serverInfo['uptime_in_seconds'] ?? '0', 10),
      connectedClients,
      memory: {
        usedBytes,
        usedHuman,
        maxBytes,
        maxHuman,
        usagePercent,
        fragmentationRatio,
        evictionPolicy,
      },
      keyspace,
      cacheHitRate,
    };

    const warnings = [...buildWarnings(partial), ...configWarnings];

    // --- queue scan (skip if --skip-queues) ---
    const queueScan: LiveRedisResult['queueScan'] = options?.skipQueues
      ? null
      : await scanQueues(client);

    // --- key scan (only if Redis has keys) ---
    const keyScan: LiveRedisResult['keyScan'] =
      keyspace.totalKeys > 0
        ? await scanKeys(client, sampleSize, idleThresholdDays, options?.onProgress)
        : null;

    return { ...partial, warnings, queueScan, keyScan };
  } finally {
    await client.quit().catch(() => {
      // ignore quit errors — connection may already be closed
    });
  }
}
