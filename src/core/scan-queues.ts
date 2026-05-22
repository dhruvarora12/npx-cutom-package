import type { Redis } from 'ioredis';
import type { QueueScanEntry, QueueScanResult } from '../types/live.js';
import {
  QUEUE_FAILED_WARN_THRESHOLD,
  QUEUE_ACTIVE_WARN_THRESHOLD,
  QUEUE_WAITING_WARN_THRESHOLD,
  QUEUE_COMPLETED_WARN_THRESHOLD,
} from '../constants.js';

// ---------------------------------------------------------------------------
// Queue name extraction
// ---------------------------------------------------------------------------

/**
 * From `bull:myqueue:waiting` → { name: 'myqueue', cluster: false }
 * From `{bull:myqueue}:waiting` → { name: 'myqueue', cluster: true }
 */
function extractQueueName(
  key: string,
): { name: string; cluster: boolean } | null {
  // Cluster pattern: {bull:<name>}:waiting
  const clusterMatch = /^\{bull:(.+)\}:waiting$/.exec(key);
  if (clusterMatch) return { name: clusterMatch[1]!, cluster: true };

  // Plain pattern: bull:<name>:waiting
  const plainMatch = /^bull:(.+):waiting$/.exec(key);
  if (plainMatch) return { name: plainMatch[1]!, cluster: false };

  return null;
}

function buildKeys(
  name: string,
  cluster: boolean,
): {
  waiting: string;
  active: string;
  completed: string;
  failed: string;
  delayed: string;
  stalledPlain: string;
  stalledCluster: string;
} {
  const plain = `bull:${name}`;
  const clust = `{bull:${name}}`;
  const base = cluster ? clust : plain;
  return {
    waiting:        `${base}:waiting`,
    active:         `${base}:active`,
    completed:      `${base}:completed`,
    failed:         `${base}:failed`,
    delayed:        `${base}:delayed`,
    stalledPlain:   `bull:${name}:stalled`,
    stalledCluster: `{bull:${name}}:stalled`,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: discover queue names via SCAN
// ---------------------------------------------------------------------------

async function discoverQueues(
  client: Redis,
): Promise<Map<string, boolean>> {
  // Map: queueName → cluster (true = cluster-style key)
  const found = new Map<string, boolean>();

  for (const pattern of ['bull:*:waiting', '{bull:*}:waiting']) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      for (const key of keys) {
        const parsed = extractQueueName(key);
        if (parsed && !found.has(parsed.name)) {
          found.set(parsed.name, parsed.cluster);
        }
      }
      cursor = nextCursor;
    } while (cursor !== '0');
  }

  return found;
}

// ---------------------------------------------------------------------------
// Phase 2: pipeline inspection per queue
// ---------------------------------------------------------------------------

async function inspectQueues(
  client: Redis,
  queues: Map<string, boolean>,
): Promise<QueueScanEntry[]> {
  if (queues.size === 0) return [];

  // Build one flat pipeline: 7 commands per queue
  // Order: waiting, active, completed, failed, delayed, stalled-plain, stalled-cluster
  const pipeline = client.pipeline();
  const orderedNames: string[] = [];

  for (const [name, cluster] of queues) {
    const k = buildKeys(name, cluster);
    pipeline.llen(k.waiting);
    pipeline.llen(k.active);
    pipeline.zcard(k.completed);
    pipeline.zcard(k.failed);
    pipeline.zcard(k.delayed);
    pipeline.exists(k.stalledPlain);
    pipeline.exists(k.stalledCluster);
    orderedNames.push(name);
  }

  const results = await pipeline.exec();
  const entries: QueueScanEntry[] = [];

  for (let i = 0; i < orderedNames.length; i++) {
    const name = orderedNames[i]!;
    const base = i * 7;

    const get = (offset: number): number => {
      const entry = results?.[base + offset];
      return entry !== undefined && entry[0] === null && typeof entry[1] === 'number'
        ? entry[1]
        : 0;
    };

    const waiting   = get(0);
    const active    = get(1);
    const completed = get(2);
    const failed    = get(3);
    const delayed   = get(4);
    const stalledPlainCount   = get(5);
    const stalledClusterCount = get(6);
    const hasStalled = stalledPlainCount > 0 || stalledClusterCount > 0;

    const warnings: string[] = [];
    if (failed >= QUEUE_FAILED_WARN_THRESHOLD) {
      warnings.push(`Queue "${name}" has ${failed} failed job${failed === 1 ? '' : 's'}`);
    }
    if (active > QUEUE_ACTIVE_WARN_THRESHOLD) {
      warnings.push(
        `Queue "${name}" has ${active} active jobs — possible stall`,
      );
    }
    if (waiting > QUEUE_WAITING_WARN_THRESHOLD) {
      warnings.push(`Queue "${name}" is backed up — ${waiting} jobs waiting`);
    }
    if (completed > QUEUE_COMPLETED_WARN_THRESHOLD) {
      warnings.push(
        `Queue "${name}" has ${completed} completed jobs — removeOnComplete may not be set`,
      );
    }
    if (hasStalled) {
      warnings.push(`Queue "${name}" has stalled jobs`);
    }

    entries.push({ name, waiting, active, completed, failed, delayed, hasStalled, warnings });
  }

  // Sort alphabetically for stable output
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ---------------------------------------------------------------------------
// Public API (internal — not exported from src/index.ts)
// ---------------------------------------------------------------------------

export async function scanQueues(client: Redis): Promise<QueueScanResult> {
  const queues = await discoverQueues(client);
  const entries = await inspectQueues(client, queues);

  const totalFailed  = entries.reduce((s, q) => s + q.failed, 0);
  const totalWaiting = entries.reduce((s, q) => s + q.waiting, 0);

  return {
    queues: entries,
    totalFailed,
    totalWaiting,
    warnings: [],
  };
}
