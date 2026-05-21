import type { File } from '@babel/types';

export type ImportStyle =
  | 'default'
  | 'named'
  | 'namespace'
  | 'dynamic'
  | 'require'
  | 'require-destructure'
  | 'require-unbound';

export interface ImportRecord {
  library: string;
  localName: string | null;
  importStyle: ImportStyle;
  line: number;
  column: number;
}

export interface SkippedFile {
  path: string;
  reason: 'parse-error' | 'too-large' | 'permission' | 'unsupported-syntax' | 'binary';
  message: string;
  line?: number;
}

export interface ScannedFile {
  path: string;
  source: string;
  imports: ImportRecord[];
  ast: File;
}

export interface ScanStats {
  totalFiles: number;
  parsedFiles: number;
  skippedFiles: number;
  durationMs: number;
}

export interface ScanResult {
  files: ScannedFile[];
  allParsedCount: number;
  skipped: SkippedFile[];
  stats: ScanStats;
}
