import type { File } from '@babel/types';
import type { ImportRecord, ImportStyle } from '../types/scan.js';

type AstNode = { type: string; [key: string]: unknown };

const SKIP_KEYS = new Set([
  'type', 'loc', 'start', 'end', 'extra',
  'innerComments', 'leadingComments', 'trailingComments', 'comments', 'tokens',
]);

function isNode(val: unknown): val is AstNode {
  return (
    typeof val === 'object' &&
    val !== null &&
    'type' in val &&
    typeof (val as Record<string, unknown>).type === 'string'
  );
}

function getLocation(node: AstNode): { line: number; column: number } {
  const loc = node['loc'] as { start: { line: number; column: number } } | null | undefined;
  return { line: loc?.start.line ?? 0, column: loc?.start.column ?? 0 };
}

function getStringValue(val: unknown): string | null {
  if (!isNode(val)) return null;
  if (val.type === 'StringLiteral' && typeof val['value'] === 'string') return val['value'];
  if (val.type === 'Literal' && typeof val['value'] === 'string') return val['value'];
  return null;
}

function isRequireCall(node: AstNode): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node['callee'];
  return isNode(callee) && callee.type === 'Identifier' && callee['name'] === 'require';
}

function getRequireArg(node: AstNode): string | null {
  const args = node['arguments'];
  if (!Array.isArray(args) || args.length === 0) return null;
  return getStringValue(args[0]);
}

export function mapImports(ast: File, knownLibraries: Set<string>): ImportRecord[] {
  const records: ImportRecord[] = [];
  const boundRequireCalls = new WeakSet<AstNode>();
  walk(ast as unknown as AstNode, records, knownLibraries, boundRequireCalls);
  return records;
}

function walk(
  node: AstNode,
  records: ImportRecord[],
  libs: Set<string>,
  handled: WeakSet<AstNode>,
): void {
  switch (node.type) {
    case 'ImportDeclaration':
      handleEsmImport(node, records, libs);
      return; // specifiers are already consumed; no need to recurse

    case 'VariableDeclarator':
      handleVariableDeclarator(node, records, libs, handled);
      break; // still recurse — init may contain nested dynamic imports

    case 'CallExpression':
      if (!handled.has(node)) handleCallExpression(node, records, libs);
      break;
  }

  for (const [key, val] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (isNode(child)) walk(child, records, libs, handled);
      }
    } else if (isNode(val)) {
      walk(val, records, libs, handled);
    }
  }
}

function handleEsmImport(node: AstNode, records: ImportRecord[], libs: Set<string>): void {
  const source = getStringValue(node['source']);
  if (!source || !libs.has(source)) return;

  const specifiers = node['specifiers'];
  if (!Array.isArray(specifiers) || specifiers.length === 0) return;

  const loc = getLocation(node);

  for (const spec of specifiers) {
    if (!isNode(spec)) continue;
    const local = spec['local'];
    if (!isNode(local) || typeof local['name'] !== 'string') continue;

    let importStyle: ImportStyle;
    if (spec.type === 'ImportDefaultSpecifier') {
      importStyle = 'default';
    } else if (spec.type === 'ImportNamespaceSpecifier') {
      importStyle = 'namespace';
    } else if (spec.type === 'ImportSpecifier') {
      importStyle = 'named';
    } else {
      continue;
    }

    records.push({ library: source, localName: local['name'], importStyle, ...loc });
  }
}

function handleVariableDeclarator(
  node: AstNode,
  records: ImportRecord[],
  libs: Set<string>,
  handled: WeakSet<AstNode>,
): void {
  const init = node['init'];
  if (!isNode(init) || !isRequireCall(init)) return;

  const lib = getRequireArg(init);
  if (!lib || !libs.has(lib)) return;

  handled.add(init);
  const loc = getLocation(init);
  const id = node['id'];
  if (!isNode(id)) return;

  if (id.type === 'Identifier' && typeof id['name'] === 'string') {
    records.push({ library: lib, localName: id['name'], importStyle: 'require', ...loc });
    return;
  }

  if (id.type === 'ObjectPattern') {
    const props = id['properties'];
    if (!Array.isArray(props)) return;
    for (const prop of props) {
      if (!isNode(prop) || prop.type !== 'ObjectProperty') continue;
      const value = prop['value'];
      if (isNode(value) && value.type === 'Identifier' && typeof value['name'] === 'string') {
        records.push({ library: lib, localName: value['name'], importStyle: 'require-destructure', ...loc });
      }
    }
  }
}

function handleCallExpression(node: AstNode, records: ImportRecord[], libs: Set<string>): void {
  const callee = node['callee'];

  if (isNode(callee) && callee.type === 'Import') {
    const args = node['arguments'];
    if (Array.isArray(args) && args.length > 0) {
      const lib = getStringValue(args[0]);
      if (lib && libs.has(lib)) {
        records.push({ library: lib, localName: null, importStyle: 'dynamic', ...getLocation(node) });
      }
    }
    return;
  }

  if (isRequireCall(node)) {
    const lib = getRequireArg(node);
    if (lib && libs.has(lib)) {
      records.push({ library: lib, localName: null, importStyle: 'require-unbound', ...getLocation(node) });
    }
  }
}
