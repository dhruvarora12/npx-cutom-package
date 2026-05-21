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
}
