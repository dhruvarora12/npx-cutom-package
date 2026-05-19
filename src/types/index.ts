export type ClientCategory = 'redis-client' | 'redis-queue';

export interface DetectedClient {
  name: string;
  version: string;
  category: ClientCategory;
  isDirect: boolean;
}

export interface DetectionResult {
  isNodeProject: boolean;
  packageJsonPath: string | null;
  hasRedis: boolean;
  hasQueues: boolean;
  clients: DetectedClient[];
  warnings: string[];
}

export interface CliOptions {
  output: 'text' | 'json' | 'markdown';
  verbose: boolean;
  color: boolean;
  skipCache: boolean;
  skipQueues: boolean;
  live: boolean;
  redisUrl: string | undefined;
  envFile: string;
  sampleSize: number;
  idleThreshold: number;
}
