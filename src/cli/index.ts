import { Command, Option } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { detectProject } from '../core/detect.js';
import { scanFiles } from '../core/scanner.js';
import { analyzeCache } from '../core/analyze-cache.js';
import { analyzeQueue } from '../core/analyze-queue.js';
import type { CliOptions, DetectionResult } from '../types/index.js';
import type { CacheAnalysisResult, Finding, QueueAnalysisResult } from '../types/findings.js';
import type { ScanResult } from '../types/scan.js';

const program = new Command();

program
  .name('stack-doctor')
  .description('Static + live analysis of Redis caching and queuing in Node.js backends.')
  .version('0.1.0')
  .argument('[path]', 'Target project directory', process.cwd())
  .addOption(
    new Option(
      '-o, --output <format>',
      'Output format (default: saves stack-doctor-report-YYYY-MM-DD.md in target directory)',
    )
      .choices(['text', 'json', 'markdown'])
    // no .default() — absence means auto-save mode
  )
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--no-color', 'Disable colored output')
  .option('--skip-cache', 'Skip cache analysis', false)
  .option('--skip-queues', 'Skip queue analysis', false)
  .option('--live', 'Run live Redis inspection (Phase 6+)', false)
  .option('--redis-url <url>', 'Redis connection URL (requires --live)')
  .option('--env-file <path>', 'Read Redis URL from .env file (requires --live)', '.env')
  .option('--sample-size <n>', 'Keys to sample in live mode (default: 1000)', '1000')
  .option('--idle-threshold <days>', 'Days before a key is considered idle (default: 30)', '30')
  .action(async (targetPath: string, rawOpts: Record<string, unknown>) => {
    if (rawOpts['skipCache'] === true && rawOpts['skipQueues'] === true) {
      console.error('Error: --skip-cache and --skip-queues together leave nothing to analyze.');
      process.exit(1);
    }

    if (rawOpts['redisUrl'] !== undefined && rawOpts['live'] !== true) {
      console.error('Error: --redis-url requires --live.');
      process.exit(1);
    }

    const isAutoMode = rawOpts['output'] === undefined;
    const date = new Date().toISOString().split('T')[0]!;

    const options: CliOptions = {
      output: (rawOpts['output'] as 'text' | 'json' | 'markdown') ?? 'text',
      verbose: rawOpts['verbose'] as boolean,
      color: rawOpts['color'] as boolean,
      skipCache: rawOpts['skipCache'] as boolean,
      skipQueues: rawOpts['skipQueues'] as boolean,
      live: rawOpts['live'] as boolean,
      redisUrl: rawOpts['redisUrl'] as string | undefined,
      envFile: rawOpts['envFile'] as string,
      sampleSize: parseInt(rawOpts['sampleSize'] as string, 10),
      idleThreshold: parseInt(rawOpts['idleThreshold'] as string, 10),
    };

    if (options.verbose) {
      console.log(`Scanning: ${targetPath}`);
    }

    const result = await detectProject(targetPath);

    if (!result.isNodeProject) {
      console.log('No package.json found. Is this a Node.js project?');
      process.exit(0);
    }

    if (!result.hasRedis && !result.hasQueues) {
      console.log(
        'No Redis usage found in code. Use --live --redis-url <url> to inspect a Redis instance directly.',
      );
      process.exit(0);
    }

    if (options.live) {
      console.log('[Phase 6 — live mode not yet implemented]');
      process.exit(0);
    }

    const libNames = result.clients
      .filter(c => {
        if (options.skipCache && c.category === 'redis-client') return false;
        if (options.skipQueues && c.category === 'redis-queue') return false;
        return true;
      })
      .map(c => c.name);

    const scanResult = await scanFiles(targetPath, libNames);
    const cacheResult = options.skipCache ? null : analyzeCache(scanResult);
    const queueResult = options.skipQueues ? null : analyzeQueue(scanResult);

    if (isAutoMode) {
      const filename = `stack-doctor-report-${date}.md`;
      const filepath = join(resolve(targetPath), filename);
      const md = buildMarkdownReport(result, scanResult, cacheResult, queueResult, options, date);
      await writeFile(filepath, md, 'utf-8');
      const rel = './' + relative(process.cwd(), filepath).replace(/\\/g, '/');
      console.log(`Report saved to ${rel}`);
      return;
    }

    printReport(result, scanResult, cacheResult, queueResult, options, date);
  });

program.parse();

// ── Markdown builder (shared by auto-save and --output markdown) ─────────────

function buildMarkdownReport(
  result: DetectionResult,
  scanResult: ScanResult,
  cacheResult: CacheAnalysisResult | null,
  queueResult: QueueAnalysisResult | null,
  options: CliOptions,
  date: string,
): string {
  const lines: string[] = [];

  const clients = result.clients.filter(c => {
    if (options.skipCache && c.category === 'redis-client') return false;
    if (options.skipQueues && c.category === 'redis-queue') return false;
    return true;
  });

  lines.push('# Stack Doctor Report', '');
  lines.push(`_Generated: ${date}_`, '');

  lines.push('## Detected Libraries', '');
  for (const c of clients) {
    lines.push(`- **${c.name}** \`${c.version}\` — ${c.category}`);
  }

  lines.push('', '## Source Files', '');
  lines.push(formatScanSummary(scanResult));
  if (scanResult.files.length > 0) {
    lines.push('');
    for (const f of scanResult.files) {
      lines.push(`### \`${f.path}\``);
      for (const imp of f.imports) {
        const name = imp.localName !== null ? ` as \`${imp.localName}\`` : '';
        lines.push(`- \`${imp.library}\`${name} (${imp.importStyle}, line ${imp.line})`);
      }
    }
  }

  if (cacheResult !== null) {
    lines.push('', '## Cache Analysis', '');
    if (cacheResult.findings.length === 0) {
      lines.push('No cache issues found.', '');
      lines.push(`> ${cacheResult.disclaimer}`);
    } else {
      lines.push(formatFindingsSummary(cacheResult.findings, cacheResult.filesAnalyzed), '');
      for (const f of cacheResult.findings) {
        lines.push(...formatFindingMarkdown(f));
      }
      lines.push(`> ${cacheResult.disclaimer}`);
    }
  }

  if (queueResult !== null) {
    lines.push('', '## Queue Analysis', '');
    if (queueResult.advisories.length > 0) {
      for (const a of queueResult.advisories) lines.push(`> ${a}`, '');
    }
    if (queueResult.findings.length === 0) {
      lines.push('No queue issues found.', '');
      lines.push(`> ${queueResult.disclaimer}`);
    } else {
      lines.push(formatFindingsSummary(queueResult.findings, queueResult.filesAnalyzed), '');
      for (const f of queueResult.findings) {
        lines.push(...formatFindingMarkdown(f));
      }
      lines.push(`> ${queueResult.disclaimer}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const w of result.warnings) lines.push(`- ${w}`);
  }

  const k = scanResult.skipped.length;
  if (k > 0) {
    lines.push('', '## Skipped Files', '');
    lines.push(`${k} ${k === 1 ? 'file was' : 'files were'} skipped during scanning.`, '');
    for (const s of scanResult.skipped) {
      const loc = s.line !== undefined ? `:${s.line}` : '';
      lines.push(`- \`${s.path}${loc}\` — ${s.reason}: ${s.message}`);
    }
  }

  return lines.join('\n');
}

function formatFindingsSummary(findings: Finding[], filesAnalyzed: number): string {
  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;
  const counts = [
    errorCount > 0 ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : '',
    warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(', ');
  return `${counts} in ${filesAnalyzed} ${filesAnalyzed === 1 ? 'file' : 'files'} analysed.`;
}

function formatFindingMarkdown(f: Finding): string[] {
  const out: string[] = [];
  out.push(`### ${f.severity.toUpperCase()} — \`${f.rule}\``);
  out.push(`**${f.file}:${f.line}**  `);
  out.push(f.message + '  ');
  if (f.codeSnippet) out.push('```', f.codeSnippet, '```');
  if (f.fix) out.push(`> Fix: ${f.fix}`);
  out.push('');
  return out;
}

// ── Text / JSON / explicit markdown output ────────────────────────────────────

function printReport(
  result: DetectionResult,
  scanResult: ScanResult,
  cacheResult: CacheAnalysisResult | null,
  queueResult: QueueAnalysisResult | null,
  options: CliOptions,
  date: string,
): void {
  const clients = result.clients.filter(c => {
    if (options.skipCache && c.category === 'redis-client') return false;
    if (options.skipQueues && c.category === 'redis-queue') return false;
    return true;
  });

  if (options.output === 'json') {
    console.log(
      JSON.stringify(
        {
          clients,
          warnings: result.warnings,
          scanStats: scanResult.stats,
          filesWithImports: scanResult.files.map(f => ({ path: f.path, imports: f.imports })),
          skippedFiles: scanResult.skipped,
          ...(cacheResult !== null
            ? {
                cacheAnalysis: {
                  findings: cacheResult.findings,
                  filesAnalyzed: cacheResult.filesAnalyzed,
                  disclaimer: cacheResult.disclaimer,
                },
              }
            : {}),
          ...(queueResult !== null
            ? {
                queueAnalysis: {
                  findings: queueResult.findings,
                  filesAnalyzed: queueResult.filesAnalyzed,
                  disclaimer: queueResult.disclaimer,
                  advisories: queueResult.advisories,
                },
              }
            : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.output === 'markdown') {
    console.log(buildMarkdownReport(result, scanResult, cacheResult, queueResult, options, date));
    return;
  }

  // ── Text ──────────────────────────────────────────────────────────────────
  console.log('\nStack Doctor — Static Analysis\n');
  console.log(`Scanned: ${result.packageJsonPath ?? 'unknown'}\n`);

  if (clients.length === 0) {
    console.log('No matching libraries found with current --skip-* filters.');
    return;
  }

  console.log('Detected libraries:');
  for (const c of clients) {
    const tag = c.category === 'redis-client' ? '[cache]' : '[queue]';
    const loc = c.isDirect ? 'dependencies' : 'devDependencies';
    console.log(`  ${tag} ${c.name} ${c.version}  (${loc})`);
  }

  console.log('');
  console.log(formatScanSummary(scanResult));

  if (scanResult.files.length > 0) {
    console.log('');
    for (const f of scanResult.files) {
      console.log(`  ${f.path}`);
      for (const imp of f.imports) {
        const name = imp.localName !== null ? `${imp.importStyle}: ${imp.localName}` : imp.importStyle;
        console.log(`    → ${imp.library}  (${name})  line ${imp.line}`);
      }
    }
  }

  if (cacheResult !== null) printCacheFindings(cacheResult);
  if (queueResult !== null) printQueueFindings(queueResult);

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of result.warnings) console.log(`  ! ${w}`);
  }

  printSkippedSummary(scanResult, options);
  console.log('');
}

function printCacheFindings(cacheResult: CacheAnalysisResult): void {
  console.log('\nCache Analysis');
  if (cacheResult.findings.length === 0) {
    console.log('  No cache issues found.');
    console.log(`\n  ! ${cacheResult.disclaimer}`);
    return;
  }
  console.log(`\n  ${formatFindingsSummary(cacheResult.findings, cacheResult.filesAnalyzed)}\n`);
  for (const f of cacheResult.findings) printFinding(f);
  console.log(`\n  ! ${cacheResult.disclaimer}`);
}

function printQueueFindings(queueResult: QueueAnalysisResult): void {
  console.log('\nQueue Analysis');
  if (queueResult.advisories.length > 0) {
    for (const a of queueResult.advisories) console.log(`  ! ${a}`);
  }
  if (queueResult.findings.length === 0) {
    console.log('  No queue issues found.');
    console.log(`\n  ! ${queueResult.disclaimer}`);
    return;
  }
  console.log(`\n  ${formatFindingsSummary(queueResult.findings, queueResult.filesAnalyzed)}\n`);
  for (const f of queueResult.findings) printFinding(f);
  console.log(`\n  ! ${queueResult.disclaimer}`);
}

function printFinding(f: Finding): void {
  const sevLabel = f.severity === 'error' ? 'ERROR' : f.severity === 'warn' ? 'WARN ' : 'INFO ';
  console.log(`  ${sevLabel}  ${f.rule.padEnd(28)}  ${f.file}:${f.line}`);
  if (f.codeSnippet) console.log(`    ${f.codeSnippet}`);
  console.log(`    ${f.message}`);
  if (f.fix) console.log(`    Fix: ${f.fix}`);
  console.log('');
}

function formatScanSummary(scanResult: ScanResult): string {
  const total = scanResult.allParsedCount;
  const withImports = scanResult.files.length;
  return `Scanned ${total} ${total === 1 ? 'file' : 'files'} — found Redis/queue imports in ${withImports} ${withImports === 1 ? 'file' : 'files'}.`;
}

function printSkippedSummary(scanResult: ScanResult, options: CliOptions): void {
  const k = scanResult.skipped.length;
  if (k === 0) return;
  if (options.verbose) {
    const { stats } = scanResult;
    console.log(
      `\nScanned ${stats.totalFiles} files in ${(stats.durationMs / 1000).toFixed(2)}s` +
        ` (parsed ${stats.parsedFiles}, skipped ${stats.skippedFiles}).`,
    );
    console.log('\nSkipped files:');
    for (const s of scanResult.skipped) {
      const line = s.line !== undefined ? `:${s.line}` : '';
      console.log(`  ! [${s.reason}] ${s.path}${line}: ${s.message}`);
    }
  } else {
    console.log(`\nSkipped ${k} ${k === 1 ? 'file' : 'files'} (use --verbose to see why).`);
  }
}
