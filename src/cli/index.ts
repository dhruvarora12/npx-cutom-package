import { Command, Option } from 'commander';
import { detectProject } from '../core/detect.js';
import type { CliOptions, DetectionResult } from '../types/index.js';

const program = new Command();

program
  .name('stack-doctor')
  .description('Static + live analysis of Redis caching and queuing in Node.js backends.')
  .version('0.1.0')
  .argument('[path]', 'Target project directory', process.cwd())
  .addOption(
    new Option('-o, --output <format>', 'Output format')
      .choices(['text', 'json', 'markdown'])
      .default('text')
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

    const options: CliOptions = {
      output: rawOpts['output'] as 'text' | 'json' | 'markdown',
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
        'No Redis usage found in code. Use --live --redis-url <url> to inspect a Redis instance directly.'
      );
      process.exit(0);
    }

    if (options.live) {
      console.log('[Phase 6 — live mode not yet implemented]');
      process.exit(0);
    }

    printStaticReport(result, options);
  });

program.parse();

function printStaticReport(result: DetectionResult, options: CliOptions): void {
  const clients = result.clients.filter(c => {
    if (options.skipCache && c.category === 'redis-client') return false;
    if (options.skipQueues && c.category === 'redis-queue') return false;
    return true;
  });

  if (options.output === 'json') {
    console.log(JSON.stringify({ clients, warnings: result.warnings }, null, 2));
    return;
  }

  if (options.output === 'markdown') {
    console.log('# Stack Doctor Report\n');
    console.log('## Detected Libraries\n');
    for (const c of clients) {
      console.log(`- **${c.name}** \`${c.version}\` — ${c.category}`);
    }
    if (result.warnings.length > 0) {
      console.log('\n## Warnings\n');
      for (const w of result.warnings) {
        console.log(`- ${w}`);
      }
    }
    return;
  }

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

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of result.warnings) {
      console.log(`  ! ${w}`);
    }
  }

  console.log('');
}
