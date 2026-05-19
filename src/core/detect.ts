import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { DetectedClient, DetectionResult } from '../types/index.js';

const REDIS_CLIENTS = ['ioredis', 'redis', '@redis/client'] as const;
const REDIS_QUEUES = ['bullmq', 'bull', 'bee-queue'] as const;

function categorize(name: string): DetectedClient['category'] | null {
  if ((REDIS_CLIENTS as readonly string[]).includes(name) || name.startsWith('@redis/')) {
    return 'redis-client';
  }
  if ((REDIS_QUEUES as readonly string[]).includes(name)) {
    return 'redis-queue';
  }
  return null;
}

interface RawPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function detectProject(targetPath: string): Promise<DetectionResult> {
  const packageJsonPath = join(resolve(targetPath), 'package.json');

  let raw: string;
  try {
    raw = await readFile(packageJsonPath, 'utf-8');
  } catch {
    return {
      isNodeProject: false,
      packageJsonPath: null,
      hasRedis: false,
      hasQueues: false,
      clients: [],
      warnings: [],
    };
  }

  let pkg: RawPackageJson;
  try {
    pkg = JSON.parse(raw) as RawPackageJson;
  } catch {
    return {
      isNodeProject: true,
      packageJsonPath,
      hasRedis: false,
      hasQueues: false,
      clients: [],
      warnings: ['package.json could not be parsed as JSON.'],
    };
  }

  const clients: DetectedClient[] = [];

  const sources: Array<{ deps: Record<string, string>; isDirect: boolean }> = [
    { deps: pkg.dependencies ?? {}, isDirect: true },
    { deps: pkg.devDependencies ?? {}, isDirect: false },
  ];

  for (const { deps, isDirect } of sources) {
    for (const [name, version] of Object.entries(deps)) {
      const category = categorize(name);
      if (category !== null) {
        clients.push({ name, version, category, isDirect });
      }
    }
  }

  return {
    isNodeProject: true,
    packageJsonPath,
    hasRedis: clients.some(c => c.category === 'redis-client'),
    hasQueues: clients.some(c => c.category === 'redis-queue'),
    clients,
    warnings: [],
  };
}
