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

export async function walkSourceFiles(
  targetPath: string,
  ignorePatterns?: string[],
): Promise<WalkerResult> {
  const ig = await buildIgnore(targetPath, ignorePatterns);
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

async function buildIgnore(
  targetPath: string,
  ignorePatterns: string[] | undefined,
): Promise<Ignore | null> {
  const hasUserPatterns = ignorePatterns !== undefined && ignorePatterns.length > 0;

  let ig: Ignore | null = null;
  try {
    const content = await readFile(join(targetPath, '.gitignore'), 'utf-8');
    ig = ignore().add(content);
  } catch {
    // no .gitignore — ig stays null
  }

  if (hasUserPatterns) {
    if (ig !== null) {
      ig.add(ignorePatterns!);            // append to existing .gitignore instance
    } else {
      ig = ignore().add(ignorePatterns!); // fresh instance — no .gitignore found
    }
  }

  return ig;
}
