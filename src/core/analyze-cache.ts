import { FINDINGS_DISCLAIMER } from '../config/constants.js';
import type { CacheAnalysisResult, Finding, FindingRule, FindingSeverity } from '../types/findings.js';
import type { ImportRecord, ScannedFile, ScanResult } from '../types/scan.js';

// ─── Library classification ──────────────────────────────────────────────────

type LibFamily = 'ioredis' | 'redis-v4';

const IOREDIS_LIBS = new Set(['ioredis']);
const REDIS_V4_LIBS = new Set(['redis', '@redis/client']);

function libFamily(library: string): LibFamily | null {
  if (IOREDIS_LIBS.has(library)) return 'ioredis';
  if (REDIS_V4_LIBS.has(library) || library.startsWith('@redis/')) return 'redis-v4';
  return null;
}

// ─── AST helpers ─────────────────────────────────────────────────────────────

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

/** Returns numeric value if node is a numeric literal (including -n via UnaryExpression). */
function numericLiteralValue(node: unknown): number | null {
  if (!isNode(node)) return null;
  if (node.type === 'NumericLiteral' || node.type === 'Literal') {
    return typeof node['value'] === 'number' ? node['value'] : null;
  }
  // -n  →  UnaryExpression { operator: '-', argument: NumericLiteral }
  if (node.type === 'UnaryExpression' && node['operator'] === '-') {
    const inner = numericLiteralValue(node['argument']);
    return inner !== null ? -inner : null;
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

/** Extract source line N (1-based) from a source string. */
function extractSnippet(source: string, line: number): string | undefined {
  if (line <= 0) return undefined;
  const lines = source.split('\n');
  const text = lines[line - 1];
  return text !== undefined ? text.trim() : undefined;
}

// ─── Walk helpers ─────────────────────────────────────────────────────────────

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

// ─── Client variable resolution ──────────────────────────────────────────────

interface ClientBinding {
  name: string;
  family: LibFamily;
  library: string;
}

/**
 * Collect client variable names from import records and one level of variable declarations.
 *
 * Covers:
 *   import Redis from 'ioredis'               → seed: Redis / ioredis
 *   const client = new Redis(...)             → client / ioredis
 *   const client = createClient(...)          → client / redis-v4
 *   const client = Redis.createClient(...)    → client / ioredis
 */
function resolveClientBindings(file: ScannedFile): ClientBinding[] {
  const bindings: ClientBinding[] = [];
  const seedsByName = new Map<string, { family: LibFamily; library: string }>();

  // Step 1: seed names from import records
  for (const imp of file.imports) {
    const family = libFamily(imp.library);
    if (family === null || imp.localName === null) continue;
    seedsByName.set(imp.localName, { family, library: imp.library });
    bindings.push({ name: imp.localName, family, library: imp.library });
  }

  // Step 2: one level of variable declarations initialised from seed names
  walk(file.ast, node => {
    if (node.type !== 'VariableDeclarator') return;

    const id = node['id'];
    const declaredName = identifierName(id);
    if (declaredName === null) return;

    const init = node['init'];
    if (!isNode(init)) return;

    const seed = resolveInitSeed(init, seedsByName);
    if (seed !== null) {
      bindings.push({ name: declaredName, ...seed });
    }
  });

  return bindings;
}

function resolveInitSeed(
  init: AstNode,
  seeds: Map<string, { family: LibFamily; library: string }>,
): { family: LibFamily; library: string } | null {
  // new SeedName(...)
  if (init.type === 'NewExpression') {
    const calleeName = identifierName(init['callee']);
    if (calleeName !== null) {
      const seed = seeds.get(calleeName);
      if (seed) return seed;
    }
  }

  // SeedName(...)
  if (init.type === 'CallExpression') {
    const callee = init['callee'];
    if (isNode(callee)) {
      // createClient()
      const calleeName = identifierName(callee);
      if (calleeName !== null) {
        const seed = seeds.get(calleeName);
        if (seed) return seed;
      }
      // SeedName.createClient()
      if (callee.type === 'MemberExpression') {
        const objName = identifierName(callee['object']);
        if (objName !== null) {
          const seed = seeds.get(objName);
          if (seed) return seed;
        }
      }
    }
  }

  return null;
}

// ─── TTL argument analysis ───────────────────────────────────────────────────

/**
 * Checks ioredis positional args for TTL expiry flags.
 * set(key, value, 'EX', n, ...)
 * Returns:
 *   'has-ttl'    — expiry option present (EX/PX/EXAT/PXAT/KEEPTTL)
 *   'zero'       — TTL flag present but value is 0
 *   'negative'   — TTL flag present but value is negative
 *   'no-ttl'     — no expiry option found
 */
type TtlStatus = 'has-ttl' | 'zero' | 'negative' | 'no-ttl';

const IOREDIS_TTL_FLAGS = new Set(['EX', 'PX', 'EXAT', 'PXAT']);

function checkIoredisTtl(args: unknown[]): TtlStatus {
  for (let i = 0; i < args.length; i++) {
    const flag = stringLiteralValue(args[i]);
    if (flag === 'KEEPTTL') return 'has-ttl';
    if (flag !== null && IOREDIS_TTL_FLAGS.has(flag.toUpperCase())) {
      const ttlVal = numericLiteralValue(args[i + 1]);
      if (ttlVal === null) return 'has-ttl'; // non-literal expression → accept
      if (ttlVal === 0) return 'zero';
      if (ttlVal < 0) return 'negative';
      return 'has-ttl';
    }
  }
  return 'no-ttl';
}

const REDIS_V4_TTL_KEYS = new Set(['EX', 'PX', 'EXAT', 'PXAT', 'KEEPTTL']);

function checkRedisV4Ttl(optionsArg: unknown): TtlStatus {
  if (!isNode(optionsArg) || optionsArg.type !== 'ObjectExpression') return 'no-ttl';
  const props = optionsArg['properties'];
  if (!Array.isArray(props)) return 'no-ttl';

  for (const prop of props) {
    if (!isNode(prop)) continue;
    const keyNode = prop['key'];
    const keyName =
      identifierName(keyNode) ??
      stringLiteralValue(keyNode);
    if (keyName === null) continue;

    if (!REDIS_V4_TTL_KEYS.has(keyName.toUpperCase())) continue;

    if (keyName.toUpperCase() === 'KEEPTTL') return 'has-ttl';

    const ttlVal = numericLiteralValue(prop['value']);
    if (ttlVal === null) return 'has-ttl'; // non-literal → accept
    if (ttlVal === 0) return 'zero';
    if (ttlVal < 0) return 'negative';
    return 'has-ttl';
  }
  return 'no-ttl';
}

/** Check whether options object contains NX: true (redis v4) or args contain 'NX' string (ioredis). */
function ioredisSetsNx(args: unknown[]): boolean {
  return args.some(a => {
    const s = stringLiteralValue(a);
    return s !== null && s.toUpperCase() === 'NX';
  });
}

function redisV4SetsNx(optionsArg: unknown): boolean {
  if (!isNode(optionsArg) || optionsArg.type !== 'ObjectExpression') return false;
  const props = optionsArg['properties'];
  if (!Array.isArray(props)) return false;
  return props.some(p => {
    if (!isNode(p)) return false;
    const k = identifierName(p['key']) ?? stringLiteralValue(p['key']);
    return k?.toUpperCase() === 'NX';
  });
}

// ─── Finding builder ─────────────────────────────────────────────────────────

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

// ─── Per-file analysis ───────────────────────────────────────────────────────

function analyzeFile(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];
  const clientBindings = resolveClientBindings(file);
  if (clientBindings.length === 0) return findings;

  // Map from client variable name → binding (last one wins if same name re-used)
  const clientMap = new Map<string, ClientBinding>();
  for (const b of clientBindings) clientMap.set(b.name, b);

  walk(file.ast, node => {
    if (node.type !== 'CallExpression') return;

    const callee = node['callee'];
    if (!isNode(callee) || callee.type !== 'MemberExpression') return;

    const objectName = identifierName(callee['object']);
    if (objectName === null) return;

    const binding = clientMap.get(objectName);
    if (binding === undefined) return;

    const methodName = identifierName(callee['property']);
    if (methodName === null) return;

    const args = Array.isArray(node['arguments']) ? (node['arguments'] as unknown[]) : [];

    if (binding.family === 'ioredis') {
      analyzeIoredisCall(node, methodName, args, binding, file, findings);
    } else {
      analyzeRedisV4Call(node, methodName, args, binding, file, findings);
    }
  });

  return findings;
}

function analyzeIoredisCall(
  node: AstNode,
  method: string,
  args: unknown[],
  binding: ClientBinding,
  file: ScannedFile,
  findings: Finding[],
): void {
  const lib = binding.library;

  switch (method) {
    case 'set': {
      const hasNx = ioredisSetsNx(args);
      const ttl = checkIoredisTtl(args);

      if (hasNx && (ttl === 'no-ttl')) {
        findings.push(makeFinding(
          'setnx-no-expiry', 'error', node, file, lib,
          `${binding.name}.set() uses NX without an expiry — locks can deadlock if the process crashes.`,
          `client.set(key, value, 'EX', 30, 'NX')`,
        ));
      } else if (!hasNx && ttl === 'no-ttl') {
        findings.push(makeFinding(
          'missing-ttl', 'warn', node, file, lib,
          `${binding.name}.set() called without a TTL — key will never expire.`,
          `client.set(key, value, 'EX', 3600)`,
        ));
      } else if (ttl === 'zero') {
        findings.push(makeFinding(
          'zero-ttl', 'error', node, file, lib,
          `${binding.name}.set() has a TTL of 0 — this is invalid and will likely error at runtime.`,
          'Use a positive integer for the TTL.',
        ));
      } else if (ttl === 'negative') {
        findings.push(makeFinding(
          'negative-ttl', 'error', node, file, lib,
          `${binding.name}.set() has a negative TTL — this is invalid.`,
          'Use a positive integer for the TTL.',
        ));
      }
      break;
    }

    case 'setex':
    case 'psetex': {
      // setex(key, ttl, value) — args[1] is ttl
      const ttlVal = numericLiteralValue(args[1]);
      if (ttlVal !== null && ttlVal === 0) {
        findings.push(makeFinding(
          'zero-ttl', 'error', node, file, lib,
          `${binding.name}.${method}() has a TTL of 0.`,
          'Use a positive integer for the TTL.',
        ));
      } else if (ttlVal !== null && ttlVal < 0) {
        findings.push(makeFinding(
          'negative-ttl', 'error', node, file, lib,
          `${binding.name}.${method}() has a negative TTL.`,
          'Use a positive integer for the TTL.',
        ));
      }
      break;
    }

    case 'setnx': {
      findings.push(makeFinding(
        'setnx-no-expiry', 'error', node, file, lib,
        `${binding.name}.setnx() never sets an expiry — use SET with NX + EX to avoid permanent locks.`,
        `client.set(key, value, 'EX', 30, 'NX')`,
      ));
      break;
    }
  }
}

function analyzeRedisV4Call(
  node: AstNode,
  method: string,
  args: unknown[],
  binding: ClientBinding,
  file: ScannedFile,
  findings: Finding[],
): void {
  const lib = binding.library;

  switch (method) {
    case 'set': {
      const optionsArg = args[2]; // set(key, value, options?)
      const hasNx = redisV4SetsNx(optionsArg);
      const ttl = checkRedisV4Ttl(optionsArg);

      if (hasNx && ttl === 'no-ttl') {
        findings.push(makeFinding(
          'setnx-no-expiry', 'error', node, file, lib,
          `${binding.name}.set() uses NX without an expiry — locks can deadlock if the process crashes.`,
          `client.set(key, value, { NX: true, EX: 30 })`,
        ));
      } else if (!hasNx && (optionsArg === undefined || ttl === 'no-ttl')) {
        findings.push(makeFinding(
          'missing-ttl', 'warn', node, file, lib,
          `${binding.name}.set() called without a TTL — key will never expire.`,
          `client.set(key, value, { EX: 3600 })`,
        ));
      } else if (ttl === 'zero') {
        findings.push(makeFinding(
          'zero-ttl', 'error', node, file, lib,
          `${binding.name}.set() has a TTL of 0 — this is invalid.`,
          'Use a positive integer for the TTL.',
        ));
      } else if (ttl === 'negative') {
        findings.push(makeFinding(
          'negative-ttl', 'error', node, file, lib,
          `${binding.name}.set() has a negative TTL — this is invalid.`,
          'Use a positive integer for the TTL.',
        ));
      }
      break;
    }

    case 'setNX': {
      findings.push(makeFinding(
        'setnx-no-expiry', 'error', node, file, lib,
        `${binding.name}.setNX() never sets an expiry — use SET with NX + EX to avoid permanent locks.`,
        `client.set(key, value, { NX: true, EX: 30 })`,
      ));
      break;
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function analyzeCache(scanResult: ScanResult): CacheAnalysisResult {
  const findings: Finding[] = [];

  for (const file of scanResult.files) {
    findings.push(...analyzeFile(file));
  }

  return {
    findings,
    filesAnalyzed: scanResult.files.length,
    disclaimer: FINDINGS_DISCLAIMER,
  };
}
