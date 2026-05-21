import type { ParserPlugin } from '@babel/parser';

export const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export const SCAN_IGNORE_DIRS = [
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.git',
  '.turbo',
  '.cache',
  'tmp',
];

export const SCAN_FILE_SIZE_LIMIT_BYTES = 500 * 1024;

export const SCAN_FILE_COUNT_WARNING = 5_000;

export const SCAN_FILE_COUNT_HARD_LIMIT = 10_000;

export const BABEL_PARSER_PLUGINS: ParserPlugin[] = [
  'typescript',
  'jsx',
  'importMeta',
  'dynamicImport',
  'decorators-legacy',
];

export const FINDINGS_DISCLAIMER =
  'Findings are based on static analysis and may include false positives. Review each before acting.';
