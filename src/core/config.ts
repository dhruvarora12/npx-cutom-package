import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface StackDoctorConfig {
  redisUrl?: string;
  output?: 'text' | 'json' | 'markdown';
  failOn?: 'error' | 'warn' | 'any';
  sampleSize?: number;
  idleThreshold?: number;
  ignore?: string[];       // parsed but not yet wired to scanner — Phase 12
  skipCache?: boolean;
  skipQueues?: boolean;
}

const CONFIG_FILENAME = '.stack-doctorrc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exitConfigError(message: string): never {
  console.error(`stack-doctor: config error — ${message}`);
  process.exit(3);
}

function readConfigFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    exitConfigError(`${filePath}: invalid JSON`);
  }
}

function validateConfig(raw: unknown, filePath: string): StackDoctorConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    exitConfigError(`${filePath} must contain a JSON object`);
  }

  const obj = raw as Record<string, unknown>;
  const config: StackDoctorConfig = {};

  if ('redisUrl' in obj) {
    if (typeof obj.redisUrl !== 'string') exitConfigError(`${filePath}: "redisUrl" must be a string`);
    config.redisUrl = obj.redisUrl;
  }

  if ('output' in obj) {
    if (obj.output !== 'text' && obj.output !== 'json' && obj.output !== 'markdown') {
      exitConfigError(`${filePath}: "output" must be "text", "json", or "markdown"`);
    }
    config.output = obj.output;
  }

  if ('failOn' in obj) {
    if (obj.failOn !== 'error' && obj.failOn !== 'warn' && obj.failOn !== 'any') {
      exitConfigError(`${filePath}: "failOn" must be "error", "warn", or "any"`);
    }
    config.failOn = obj.failOn;
  }

  if ('sampleSize' in obj) {
    if (typeof obj.sampleSize !== 'number' || !Number.isInteger(obj.sampleSize) || obj.sampleSize <= 0) {
      exitConfigError(`${filePath}: "sampleSize" must be a positive integer`);
    }
    config.sampleSize = obj.sampleSize;
  }

  if ('idleThreshold' in obj) {
    if (typeof obj.idleThreshold !== 'number' || !Number.isInteger(obj.idleThreshold) || obj.idleThreshold <= 0) {
      exitConfigError(`${filePath}: "idleThreshold" must be a positive integer`);
    }
    config.idleThreshold = obj.idleThreshold;
  }

  if ('ignore' in obj) {
    if (!Array.isArray(obj.ignore) || !obj.ignore.every((item) => typeof item === 'string')) {
      exitConfigError(`${filePath}: "ignore" must be an array of strings`);
    }
    config.ignore = obj.ignore as string[];
  }

  if ('skipCache' in obj) {
    if (typeof obj.skipCache !== 'boolean') exitConfigError(`${filePath}: "skipCache" must be a boolean`);
    config.skipCache = obj.skipCache;
  }

  if ('skipQueues' in obj) {
    if (typeof obj.skipQueues !== 'boolean') exitConfigError(`${filePath}: "skipQueues" must be a boolean`);
    config.skipQueues = obj.skipQueues;
  }

  return config;
}

function tryLoadFile(filePath: string): StackDoctorConfig | null {
  if (!existsSync(filePath)) return null;
  return validateConfig(readConfigFile(filePath), filePath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadConfig(targetDir: string): StackDoctorConfig {
  const resolvedTarget = resolve(targetDir);

  const targetPath = join(resolvedTarget, CONFIG_FILENAME);
  const fromTarget = tryLoadFile(targetPath);
  if (fromTarget !== null) return fromTarget;

  const resolvedCwd = resolve(process.cwd());
  if (resolvedTarget !== resolvedCwd) {
    const cwdPath = join(resolvedCwd, CONFIG_FILENAME);
    const fromCwd = tryLoadFile(cwdPath);
    if (fromCwd !== null) return fromCwd;
  }

  return {};
}
