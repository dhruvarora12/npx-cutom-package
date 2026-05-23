import {
  SCAN_FILE_COUNT_HARD_LIMIT,
  SCAN_FILE_COUNT_WARNING,
} from '../config/constants.js';
import type { ScannedFile, SkippedFile, ScanResult, ScanOptions } from '../types/scan.js';
import type { File } from '@babel/types';
import { walkSourceFiles } from './walker.js';
import { parseFile } from './parser.js';
import { mapImports } from './mapper.js';

export async function scanFiles(
  targetPath: string,
  libraries: string[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const start = Date.now();
  const libSet = new Set(libraries);

  const { paths, hitWarning, hitHardLimit } = await walkSourceFiles(targetPath, options.ignore);

  if (hitWarning && !hitHardLimit) {
    process.stderr.write(
      `Warning: found ${SCAN_FILE_COUNT_WARNING}+ source files. Scan may be slow.\n`,
    );
  }
  if (hitHardLimit) {
    process.stderr.write(
      `Warning: scan stopped at ${SCAN_FILE_COUNT_HARD_LIMIT} files. Narrow the target path if needed.\n`,
    );
  }

  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];
  let allParsedCount = 0;

  for (const filePath of paths) {
    const outcome = await parseFile(filePath);
    if (!outcome.ok) {
      skipped.push(outcome.skipped);
      continue;
    }

    allParsedCount++;
    options.onProgress?.(allParsedCount);
    const imports = mapImports(outcome.ast, libSet);
    if (imports.length > 0) {
      files.push({ path: filePath, source: outcome.source, imports, ast: outcome.ast });
    }
  }

  return {
    files,
    allParsedCount,
    skipped,
    stats: {
      totalFiles: paths.length,
      parsedFiles: allParsedCount,
      skippedFiles: skipped.length,
      durationMs: Date.now() - start,
    },
  };
}

export function getAst(result: ScanResult, filePath: string): File | null {
  return result.files.find(f => f.path === filePath)?.ast ?? null;
}
