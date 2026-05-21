import { FINDINGS_DISCLAIMER } from '../config/constants.js';
import type { Finding, FindingRule, FindingSeverity, QueueAnalysisResult } from '../types/findings.js';
import type { ScannedFile, ScanResult } from '../types/scan.js';

// ─── Library classification ───────────────────────────────────────────────────

const BULLMQ_LIB = 'bullmq';
const BULL_LIB = 'bull';
const BEE_QUEUE_LIB = 'bee-queue';
const BEE_QUEUE_ADVISORY =
  'Bee-Queue detected — deep queue analysis not yet supported. Planned for v2.';

// ─── AST helpers (mirrors analyze-cache.ts conventions) ──────────────────────

type AstNode = { type: string; [key: string]: unknown };

function isNode(val: unknown): val is AstNode {
  return typeof val === 'object' && val !== null && 'type' in val;
}

function getLocation(node: AstNode): { line: number; column: number } {
  const loc = node['loc'] as { start: { line: number; column: number } } | null | undefined;
  return { line: loc?.start.line ?? 0, column: loc?.start.column ?? 0 };
}

function identifierName(node: unknown): string | null {
  if (!isNode(node) || node.type !== 'Identifier') return null;
  return typeof node['name'] === 'string' ? node['name'] : null;
}

function extractSnippet(source: string, line: number): string | undefined {
  if (line <= 0) return undefined;
  const lines = source.split('\n');
  const text = lines[line - 1];
  return text !== undefined ? text.trim() : undefined;
}

const WALK_SKIP_KEYS = new Set([
  'type', 'loc', 'start', 'end', 'extra',
  'innerComments', 'leadingComments', 'trailingComments', 'comments', 'tokens',
]);

function walk(node: unknown, visitor: (n: AstNode) => void): void {
  if (!isNode(node)) return;
  visitor(node);
  for (const [key, val] of Object.entries(node)) {
    if (WALK_SKIP_KEYS.has(key)) continue;
    if (Array.isArray(val)) {
      for (const child of val) walk(child, visitor);
    } else {
      walk(val, visitor);
    }
  }
}

// ─── Seed resolution ─────────────────────────────────────────────────────────
//
// For BullMQ we need two separate seed sets — one for Queue, one for Worker —
// because they carry different rules. We walk ImportDeclaration AST nodes
// directly so that aliases (import { Queue as BQ }) resolve correctly.
// For require-destructure we fall back to ImportRecord.localName (the key name
// equals the property name in the common non-renamed case).

interface QueueSeeds {
  bullmqQueueSeeds: Set<string>; // local aliases for bullmq's Queue class
  bullmqWorkerSeeds: Set<string>; // local aliases for bullmq's Worker class
  bullSeeds: Set<string>;         // local aliases for Bull's default export
  hasBeeQueue: boolean;
}

function resolveSeeds(file: ScannedFile): QueueSeeds {
  const bullmqQueueSeeds = new Set<string>();
  const bullmqWorkerSeeds = new Set<string>();
  const bullSeeds = new Set<string>();
  let hasBeeQueue = false;

  // Pass 1 — require-style (ImportRecord covers CJS destructuring)
  for (const imp of file.imports) {
    if (imp.localName === null) continue;
    if (imp.library === BULLMQ_LIB && imp.importStyle === 'require-destructure') {
      // localName equals the property key when no rename is used (common case)
      if (imp.localName === 'Queue') bullmqQueueSeeds.add(imp.localName);
      if (imp.localName === 'Worker') bullmqWorkerSeeds.add(imp.localName);
    }
    if (imp.library === BULL_LIB) {
      bullSeeds.add(imp.localName);
    }
    if (imp.library === BEE_QUEUE_LIB) {
      hasBeeQueue = true;
    }
  }

  // Pass 2 — ESM ImportDeclaration nodes (captures aliased imports correctly)
  walk(file.ast, node => {
    if (node.type !== 'ImportDeclaration') return;
    const sourceVal = node['source'];
    if (!isNode(sourceVal) || typeof sourceVal['value'] !== 'string') return;
    const lib = sourceVal['value'] as string;

    const specifiers = node['specifiers'];
    if (!Array.isArray(specifiers)) return;

    if (lib === BULLMQ_LIB) {
      for (const spec of specifiers) {
        if (!isNode(spec) || spec.type !== 'ImportSpecifier') continue;
        // imported: the name as exported from the module (Queue / Worker)
        const importedNode = spec['imported'];
        const importedName =
          isNode(importedNode) && importedNode.type === 'StringLiteral'
            ? (importedNode['value'] as string)
            : identifierName(importedNode);
        // local: what the developer named it in this file
        const localName = identifierName(spec['local']);
        if (importedName === null || localName === null) continue;
        if (importedName === 'Queue') bullmqQueueSeeds.add(localName);
        if (importedName === 'Worker') bullmqWorkerSeeds.add(localName);
      }
    }
  });

  return { bullmqQueueSeeds, bullmqWorkerSeeds, bullSeeds, hasBeeQueue };
}

// ─── Finding builder ──────────────────────────────────────────────────────────

function makeFinding(
  rule: FindingRule,
  severity: FindingSeverity,
  node: AstNode,
  file: ScannedFile,
  library: string,
  message: string,
  fix?: string,
): Finding {
  const { line, column } = getLocation(node);
  const snippet = extractSnippet(file.source, line);
  const finding: Finding = { rule, severity, file: file.path, line, column, message, library };
  if (fix !== undefined) finding.fix = fix;
  if (snippet !== undefined) finding.codeSnippet = snippet;
  return finding;
}

// ─── Options object helpers ───────────────────────────────────────────────────

/** Returns the value node for a named property in an ObjectExpression, or null. */
function getProperty(objNode: AstNode, key: string): unknown {
  const props = objNode['properties'];
  if (!Array.isArray(props)) return null;
  for (const prop of props) {
    if (!isNode(prop) || prop.type !== 'ObjectProperty') continue;
    const k = identifierName(prop['key']) ?? stringLiteralValue(prop['key']);
    if (k === key) return prop['value'];
  }
  return null;
}

function stringLiteralValue(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === 'StringLiteral' || node.type === 'Literal') {
    return typeof node['value'] === 'string' ? node['value'] : null;
  }
  return null;
}

/**
 * Returns true if this value node represents a "bad" configuration for a
 * boolean-or-object option (removeOnComplete, removeOnFail).
 * Bad = absent (null), false literal, or numeric 0.
 */
function isBadBooleanOption(val: unknown): boolean {
  if (val === null) return true; // key absent
  if (!isNode(val)) return false;
  if (val.type === 'BooleanLiteral') return val['value'] === false;
  if (val.type === 'NumericLiteral' || val.type === 'Literal') return val['value'] === 0;
  return false;
}

/**
 * Returns true if the attempts value is a "bad" literal:
 * absent, false, 0, or 1 (try-once = functionally no retry).
 */
function isBadAttemptsValue(val: unknown): boolean {
  if (val === null) return true; // key absent
  if (!isNode(val)) return false;
  if (val.type === 'BooleanLiteral') return val['value'] === false;
  if (val.type === 'NumericLiteral' || val.type === 'Literal') {
    return val['value'] === 0 || val['value'] === 1;
  }
  return false;
}

/**
 * Returns true if a numeric option is absent, false, or 0.
 * Used for: timeout, concurrency, stalledInterval.
 */
function isBadNumericOption(val: unknown): boolean {
  if (val === null) return true; // key absent
  if (!isNode(val)) return false;
  if (val.type === 'BooleanLiteral') return val['value'] === false;
  if (val.type === 'NumericLiteral' || val.type === 'Literal') return val['value'] === 0;
  return false;
}

// ─── Queue rule checks ────────────────────────────────────────────────────────
//
// Called ONLY when a Queue constructor is detected. Worker rules are never
// reachable from this function.

function checkQueueOpts(
  callNode: AstNode,
  optsArg: unknown,   // args[1] for both BullMQ Queue and Bull
  library: string,
  file: ScannedFile,
  findings: Finding[],
): void {
  // No opts arg at all → fire all 4 Queue rules immediately
  if (optsArg === undefined || optsArg === null) {
    findings.push(makeFinding('queue-missing-attempts', 'warn', callNode, file, library,
      `Queue constructor called with no options — jobs will not be retried on failure.`,
      `new Queue(name, { defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } } })`,
    ));
    findings.push(makeFinding('queue-no-remove-on-complete', 'warn', callNode, file, library,
      `Queue constructor called with no options — completed jobs will accumulate in Redis indefinitely.`,
      `defaultJobOptions: { removeOnComplete: { count: 100 } }`,
    ));
    findings.push(makeFinding('queue-no-remove-on-fail', 'warn', callNode, file, library,
      `Queue constructor called with no options — failed jobs will accumulate in Redis indefinitely.`,
      `defaultJobOptions: { removeOnFail: { count: 50 } }`,
    ));
    findings.push(makeFinding('queue-missing-timeout', 'warn', callNode, file, library,
      `Queue constructor called with no options — jobs can hang indefinitely if they stall.`,
      `defaultJobOptions: { timeout: 30000 }`,
    ));
    return;
  }

  // Opts is a variable reference → treat as configured, skip all Queue rules
  if (!isNode(optsArg) || optsArg.type !== 'ObjectExpression') return;

  // Opts is an object literal — look for defaultJobOptions
  const djoVal = getProperty(optsArg, 'defaultJobOptions');

  // defaultJobOptions absent → fire all 4 rules
  if (djoVal === null) {
    findings.push(makeFinding('queue-missing-attempts', 'warn', callNode, file, library,
      `defaultJobOptions not set — jobs will not be retried on failure.`,
      `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }`,
    ));
    findings.push(makeFinding('queue-no-remove-on-complete', 'warn', callNode, file, library,
      `defaultJobOptions not set — completed jobs will accumulate in Redis indefinitely.`,
      `defaultJobOptions: { removeOnComplete: { count: 100 } }`,
    ));
    findings.push(makeFinding('queue-no-remove-on-fail', 'warn', callNode, file, library,
      `defaultJobOptions not set — failed jobs will accumulate in Redis indefinitely.`,
      `defaultJobOptions: { removeOnFail: { count: 50 } }`,
    ));
    findings.push(makeFinding('queue-missing-timeout', 'warn', callNode, file, library,
      `defaultJobOptions not set — jobs have no timeout and can hang indefinitely.`,
      `defaultJobOptions: { timeout: 30000 }`,
    ));
    return;
  }

  // defaultJobOptions is a variable reference → treat as configured
  if (!isNode(djoVal) || djoVal.type !== 'ObjectExpression') return;

  // defaultJobOptions is an object literal — check individual fields
  const attemptsVal = getProperty(djoVal, 'attempts');
  if (isBadAttemptsValue(attemptsVal)) {
    const literalVal = isNode(attemptsVal)
      ? (attemptsVal['value'] as number | boolean | undefined)
      : undefined;
    const detail = literalVal !== undefined
      ? `attempts set to ${String(literalVal)} — this is functionally no retry.`
      : `No attempts set in defaultJobOptions — jobs will not be retried on failure.`;
    findings.push(makeFinding('queue-missing-attempts', 'warn', callNode, file, library,
      detail,
      `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }`,
    ));
  }

  const rocVal = getProperty(djoVal, 'removeOnComplete');
  if (isBadBooleanOption(rocVal)) {
    findings.push(makeFinding('queue-no-remove-on-complete', 'warn', callNode, file, library,
      `removeOnComplete not configured — completed jobs will accumulate in Redis indefinitely.`,
      `defaultJobOptions: { removeOnComplete: { count: 100 } }`,
    ));
  }

  const rofVal = getProperty(djoVal, 'removeOnFail');
  if (isBadBooleanOption(rofVal)) {
    findings.push(makeFinding('queue-no-remove-on-fail', 'warn', callNode, file, library,
      `removeOnFail not configured — failed jobs will accumulate in Redis indefinitely.`,
      `defaultJobOptions: { removeOnFail: { count: 50 } }`,
    ));
  }

  const timeoutVal = getProperty(djoVal, 'timeout');
  if (isBadNumericOption(timeoutVal)) {
    findings.push(makeFinding('queue-missing-timeout', 'warn', callNode, file, library,
      `No job timeout in defaultJobOptions — jobs can hang indefinitely if they stall.`,
      `defaultJobOptions: { timeout: 30000 }`,
    ));
  }
}

// ─── Worker rule checks ───────────────────────────────────────────────────────
//
// Called ONLY when a Worker constructor is detected. Queue rules are never
// reachable from this function.

function checkWorkerOpts(
  callNode: AstNode,
  optsArg: unknown,   // args[2] for BullMQ Worker (name, fn, opts)
  file: ScannedFile,
  findings: Finding[],
): void {
  // No opts arg → fire both Worker rules
  if (optsArg === undefined || optsArg === null) {
    findings.push(makeFinding('queue-default-concurrency', 'warn', callNode, file, BULLMQ_LIB,
      `Worker constructed with no options — concurrency defaults to 1, which may be a bottleneck under load.`,
      `new Worker(name, fn, { concurrency: 10 })`,
    ));
    findings.push(makeFinding('queue-missing-stalled-interval', 'warn', callNode, file, BULLMQ_LIB,
      `Worker constructed with no options — stalledInterval not set, stalled jobs may not be recovered promptly.`,
      `new Worker(name, fn, { stalledInterval: 30000, maxStalledCount: 1 })`,
    ));
    return;
  }

  // Opts is a variable reference → treat as configured
  if (!isNode(optsArg) || optsArg.type !== 'ObjectExpression') return;

  // Opts is an object literal — check concurrency and stalledInterval directly
  const concurrencyVal = getProperty(optsArg, 'concurrency');
  if (isBadNumericOption(concurrencyVal)) {
    findings.push(makeFinding('queue-default-concurrency', 'warn', callNode, file, BULLMQ_LIB,
      `concurrency not set on Worker — defaults to 1, which may be a bottleneck under load.`,
      `new Worker(name, fn, { concurrency: 10 })`,
    ));
  }

  const stalledVal = getProperty(optsArg, 'stalledInterval');
  if (isBadNumericOption(stalledVal)) {
    findings.push(makeFinding('queue-missing-stalled-interval', 'warn', callNode, file, BULLMQ_LIB,
      `stalledInterval not set on Worker — stalled jobs may not be detected and recovered promptly.`,
      `new Worker(name, fn, { stalledInterval: 30000, maxStalledCount: 1 })`,
    ));
  }
}

// ─── Per-file analysis ────────────────────────────────────────────────────────

function analyzeFile(
  file: ScannedFile,
  seeds: QueueSeeds,
): Finding[] {
  const findings: Finding[] = [];

  walk(file.ast, node => {
    // Only interested in `new ClassName(...)` expressions
    if (node.type !== 'NewExpression') return;

    const calleeName = identifierName(node['callee']);
    if (calleeName === null) return;

    const args = Array.isArray(node['arguments']) ? (node['arguments'] as unknown[]) : [];

    if (seeds.bullmqQueueSeeds.has(calleeName)) {
      // ── BullMQ Queue: new Queue(name, opts) ──
      // Queue rules only. Worker rules unreachable from this branch.
      checkQueueOpts(node, args[1], BULLMQ_LIB, file, findings);

    } else if (seeds.bullmqWorkerSeeds.has(calleeName)) {
      // ── BullMQ Worker: new Worker(name, fn, opts) ──
      // Worker rules only. Queue rules unreachable from this branch.
      checkWorkerOpts(node, args[2], file, findings);

    } else if (seeds.bullSeeds.has(calleeName)) {
      // ── Bull: new Bull(name, opts) — Queue rules A/B/C/F only ──
      // No Worker class in Bull → Worker rules never called for Bull.
      checkQueueOpts(node, args[1], BULL_LIB, file, findings);
    }
  });

  return findings;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function analyzeQueue(scanResult: ScanResult): QueueAnalysisResult {
  const findings: Finding[] = [];
  const advisories: string[] = [];
  let filesAnalyzed = 0;
  let beeQueueAdvisoryAdded = false;

  for (const file of scanResult.files) {
    const seeds = resolveSeeds(file);
    const hasQueueLib =
      seeds.bullmqQueueSeeds.size > 0 ||
      seeds.bullmqWorkerSeeds.size > 0 ||
      seeds.bullSeeds.size > 0 ||
      seeds.hasBeeQueue;

    if (!hasQueueLib) continue;

    filesAnalyzed++;

    if (seeds.hasBeeQueue && !beeQueueAdvisoryAdded) {
      advisories.push(BEE_QUEUE_ADVISORY);
      beeQueueAdvisoryAdded = true;
    }

    findings.push(...analyzeFile(file, seeds));
  }

  return {
    findings,
    filesAnalyzed,
    disclaimer: FINDINGS_DISCLAIMER,
    advisories,
  };
}
