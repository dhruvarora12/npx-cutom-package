export type FindingSeverity = 'error' | 'warn' | 'info';

export type FindingRule =
  | 'missing-ttl'
  | 'setnx-no-expiry'
  | 'zero-ttl'
  | 'negative-ttl'
  // Phase 4 — queue rules
  | 'queue-missing-attempts'
  | 'queue-no-remove-on-complete'
  | 'queue-no-remove-on-fail'
  | 'queue-missing-timeout'
  | 'queue-default-concurrency'
  | 'queue-missing-stalled-interval';

export interface Finding {
  rule: FindingRule;
  severity: FindingSeverity;
  file: string;
  line: number;
  column: number;
  message: string;
  library: string;
  fix?: string;
  codeSnippet?: string;
}

export interface CacheAnalysisResult {
  findings: Finding[];
  filesAnalyzed: number;
  disclaimer: string;
}

export interface QueueAnalysisResult {
  findings: Finding[];
  filesAnalyzed: number;
  disclaimer: string;
  advisories: string[];
}
