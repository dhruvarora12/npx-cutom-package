import { fdir } from 'fdir';
import ignore, { type Ignore } from 'ignore';
import { readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import {
  SCAN_EXTENSIONS,
  SCAN_FILE_COUNT_HARD_LIMIT,
  SCAN_FILE_COUNT_WARNING,
  SCAN_IGNORE_DIRS,
} from '../config/constants.js';

export interface WalkerResult {
  paths: string[];
  hitWarning: boolean;
  hitHardLimit: boolean;
}

export async function walkSourceFiles(targetPath: string): Promise<WalkerResult> {
  const ig = await loadGitignore(targetPath);
  const ignoreDirSet = new Set(SCAN_IGNORE_DIRS);

  const paths: string[] = await (new fdir()
    .withFullPaths()
    .exclude((dirName: string) => ignoreDirSet.has(dirName))
    .filter((filePath: string) => {
      if (!SCAN_EXTENSIONS.has(extname(filePath))) return false;
      if (ig !== null) {
        const rel = relative(targetPath, filePath);
        if (!rel.startsWith('..') && ig.ignores(rel)) return false;
      }
      return true;
    })
    .crawl(targetPath)
    .withPromise() as unknown as Promise<string[]>);

  const hitWarning = paths.length >= SCAN_FILE_COUNT_WARNING;
  const hitHardLimit = paths.length >= SCAN_FILE_COUNT_HARD_LIMIT;

  return {
    paths: hitHardLimit ? paths.slice(0, SCAN_FILE_COUNT_HARD_LIMIT) : paths,
    hitWarning,
    hitHardLimit,
  };
}

async function loadGitignore(targetPath: string): Promise<Ignore | null> {
  try {
    const content = await readFile(join(targetPath, '.gitignore'), 'utf-8');
    return ignore().add(content);
  } catch {
    return null;
  }
}
