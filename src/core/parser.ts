import { parse } from '@babel/parser';
import { readFile, stat } from 'node:fs/promises';
import { BABEL_PARSER_PLUGINS, SCAN_FILE_SIZE_LIMIT_BYTES } from '../config/constants.js';
import type { SkippedFile } from '../types/scan.js';
import type { File } from '@babel/types';

export type ParseOutcome = { ok: true; ast: File; source: string } | { ok: false; skipped: SkippedFile };

export async function parseFile(filePath: string): Promise<ParseOutcome> {
  let fileSize: number;
  try {
    const stats = await stat(filePath);
    fileSize = stats.size;
  } catch (err) {
    return { ok: false, skipped: { path: filePath, reason: 'permission', message: String(err) } };
  }

  if (fileSize > SCAN_FILE_SIZE_LIMIT_BYTES) {
    return {
      ok: false,
      skipped: {
        path: filePath,
        reason: 'too-large',
        message: `${Math.round(fileSize / 1024)} KB exceeds ${SCAN_FILE_SIZE_LIMIT_BYTES / 1024} KB limit`,
      },
    };
  }

  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch (err) {
    return { ok: false, skipped: { path: filePath, reason: 'permission', message: String(err) } };
  }

  if (hasBinaryContent(source)) {
    return {
      ok: false,
      skipped: { path: filePath, reason: 'binary', message: 'File contains binary content' },
    };
  }

  try {
    const ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: BABEL_PARSER_PLUGINS,
      strictMode: false,
      errorRecovery: false,
    });
    return { ok: true, ast: ast as unknown as File, source };
  } catch (err) {
    const syntaxErr = err as { loc?: { line?: number } };
    return {
      ok: false,
      skipped: {
        path: filePath,
        reason: 'parse-error',
        message: err instanceof Error ? err.message : String(err),
        ...(syntaxErr.loc?.line !== undefined ? { line: syntaxErr.loc.line } : {}),
      },
    };
  }
}

function hasBinaryContent(content: string): boolean {
  const checkLength = Math.min(content.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}
