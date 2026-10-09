import path from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { grammarDir, runtimeWasm } from './assets';
import { chunkTextWithOffsets } from './text';

/** Bump whenever node lists, header format or size rules change; forces a full re-index on the next run. */
export const CHUNKER_VERSION = 'ts-4';

/** Definitions that are context rather than search targets; they pack together like imports and comments. */
const MINOR_KINDS = new Set([
  'lexical_declaration', 'variable_declaration', 'var_declaration', 'const_declaration', 'const_item', 'static_item',
  'type_alias_declaration', 'type_item', 'type_definition', 'property_declaration', 'val_definition', 'declaration',
]);

export interface CodeChunk {
  text: string;
  language: string;
  symbol: string | null;
  kind: string | null;
  startLine: number;
  endLine: number;
}

export interface CodeChunkOptions {
  /** Preferred chunk size in characters; small neighbouring definitions are packed up to this. */
  target: number;
  /** Definitions longer than this are split by their members, then by lines. */
  max: number;
}

interface Grammar {
  grammar: string;
  definitions: ReadonlySet<string>;
  /** Node types whose children (the body) hold nested definitions worth splitting into. */
  containers: ReadonlySet<string>;
}

const def = (grammar: string, definitions: string[], containers: string[] = []): Grammar => ({
  grammar,
  definitions: new Set(definitions),
  containers: new Set(containers),
});

const TS_DEFS = ['function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration', 'interface_declaration',
  'type_alias_declaration', 'enum_declaration', 'lexical_declaration', 'variable_declaration', 'method_definition', 'module', 'internal_module', 'export_statement'];
const TS_CONTAINERS = ['class_declaration', 'abstract_class_declaration', 'class_body', 'module', 'internal_module', 'statement_block'];

/** Languages the parser handles; everything else falls back to the sliding-window chunker. */
export const GRAMMARS: Record<string, Grammar> = {
  typescript: def('typescript', TS_DEFS, TS_CONTAINERS),
  tsx: def('tsx', TS_DEFS, TS_CONTAINERS),
  javascript: def('javascript', ['function_declaration', 'generator_function_declaration', 'class_declaration', 'lexical_declaration', 'variable_declaration', 'method_definition', 'export_statement'], ['class_declaration', 'class_body']),
  python: def('python', ['function_definition', 'class_definition', 'decorated_definition'], ['class_definition', 'block']),
  go: def('go', ['function_declaration', 'method_declaration', 'type_declaration', 'var_declaration', 'const_declaration']),
  rust: def('rust', ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item', 'const_item', 'static_item', 'type_item', 'macro_definition'], ['impl_item', 'trait_item', 'mod_item', 'declaration_list']),
  java: def('java', ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'method_declaration', 'constructor_declaration'], ['class_declaration', 'interface_declaration', 'class_body', 'interface_body']),
  kotlin: def('kotlin', ['class_declaration', 'object_declaration', 'function_declaration', 'property_declaration'], ['class_declaration', 'object_declaration', 'class_body']),
  dart: def('dart', ['class_definition', 'enum_declaration', 'mixin_declaration', 'extension_declaration', 'function_signature', 'method_signature', 'getter_signature', 'setter_signature'], ['class_definition', 'class_body']),
  c_sharp: def('c_sharp', ['class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration', 'record_declaration', 'method_declaration', 'constructor_declaration', 'namespace_declaration'], ['namespace_declaration', 'class_declaration', 'declaration_list']),
  c: def('c', ['function_definition', 'struct_specifier', 'enum_specifier', 'type_definition', 'declaration']),
  cpp: def('cpp', ['function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier', 'namespace_definition', 'template_declaration', 'type_definition'], ['namespace_definition', 'class_specifier', 'declaration_list', 'field_declaration_list']),
  ruby: def('ruby', ['method', 'singleton_method', 'class', 'module'], ['class', 'module', 'body_statement']),
  php: def('php', ['function_definition', 'class_declaration', 'interface_declaration', 'trait_declaration', 'method_declaration', 'namespace_definition'], ['class_declaration', 'declaration_list']),
  swift: def('swift', ['function_declaration', 'class_declaration', 'protocol_declaration', 'init_declaration'], ['class_declaration', 'class_body']),
  scala: def('scala', ['function_definition', 'class_definition', 'object_definition', 'trait_definition', 'val_definition'], ['class_definition', 'object_definition', 'template_body']),
  lua: def('lua', ['function_declaration', 'function_definition_statement', 'variable_declaration']),
  // No bash: its external scanner crashed web-tree-sitter on real scripts under Bun; .sh files use the window chunker until it is re-tested.
};

const EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.dart': 'dart',
  '.cs': 'c_sharp', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.scala': 'scala', '.lua': 'lua', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.md': 'markdown', '.mdx': 'markdown', '.sql': 'sql', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.css': 'css',
  '.scss': 'css', '.html': 'html', '.xml': 'xml', '.graphql': 'graphql', '.proto': 'protobuf', '.prisma': 'prisma', '.txt': 'text',
};

/** Language label for a path: a parsed language, a plain label for known text formats, or 'text'. */
export function languageOf(filePath: string): string {
  return EXTENSIONS[path.extname(filePath).toLowerCase()] ?? 'text';
}

/** Every language label the extension map can produce. */
export function supportedLanguages(): string[] {
  return Array.from(new Set(Object.values(EXTENSIONS))).sort();
}

export interface ChunkResult {
  chunks: CodeChunk[];
  /** Set when the parser could not handle the file and the sliding window was used instead. */
  fallbackReason?: string;
}

/** Split source into chunks aligned to definitions when a grammar exists, else by the sliding window. */
export async function chunkCode(text: string, language: string, relPath: string, opts: CodeChunkOptions): Promise<CodeChunk[]> {
  return (await chunkCodeDetailed(text, language, relPath, opts)).chunks;
}

/**
 * Like chunkCode, but never throws: any parser failure (a grammar that cannot
 * load, a scanner crash on unusual input) falls back to the sliding window and
 * reports why, so one odd file never fails a whole run.
 */
export async function chunkCodeDetailed(text: string, language: string, relPath: string, opts: CodeChunkOptions): Promise<ChunkResult> {
  const grammar = GRAMMARS[language];
  if (!grammar || brokenGrammars.has(grammar.grammar)) return { chunks: fallbackChunks(text, language, relPath, opts) };
  let tree: ReturnType<Parser['parse']> = null;
  try {
    const parser = await parserFor(grammar.grammar);
    tree = parser.parse(text);
    if (!tree) throw new Error('parser returned no tree');
    const units = collectUnits(tree.rootNode, text, grammar, opts, []);
    return { chunks: packUnits(units, text, language, relPath, opts) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { chunks: fallbackChunks(text, language, relPath, opts), fallbackReason: reason };
  } finally {
    tree?.delete();
  }
}

// ---------- parsing ----------

let initialised: Promise<void> | null = null;
/** One parser per grammar, reused across files; creating one per file leaks WASM memory over thousands of files. */
const parsers = new Map<string, Promise<Parser>>();
/** Grammars that failed to load, so later files skip straight to the fallback instead of retrying. */
const brokenGrammars = new Set<string>();

async function parserFor(grammar: string): Promise<Parser> {
  initialised ??= Parser.init({ locateFile: () => runtimeWasm() });
  await initialised;
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = Language.load(path.join(grammarDir(), `tree-sitter-${grammar}.wasm`))
      .then((language) => {
        const p = new Parser();
        p.setLanguage(language);
        return p;
      })
      .catch((err: unknown) => {
        brokenGrammars.add(grammar);
        parsers.delete(grammar);
        throw err;
      });
    parsers.set(grammar, parser);
  }
  return parser;
}

/** Load every grammar in GRAMMARS; returns the ones that fail. Used by tests and `repo-vector doctor`-style checks. */
export async function loadAllGrammars(): Promise<Array<{ grammar: string; error: string }>> {
  const failures: Array<{ grammar: string; error: string }> = [];
  for (const { grammar } of Object.values(GRAMMARS)) {
    try {
      await parserFor(grammar);
    } catch (err) {
      failures.push({ grammar, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return failures;
}

// ---------- units ----------

interface Unit {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  symbol: string | null;
  kind: string | null;
  /** Enclosing symbols, outermost first. */
  scope: string[];
  definition: boolean;
}

/** Top-level nodes become units; oversized containers are opened so their members become units of their own. */
function collectUnits(parent: Node, text: string, grammar: Grammar, opts: CodeChunkOptions, scope: string[]): Unit[] {
  const units: Unit[] = [];
  let pendingComment: Node | null = null;
  for (const child of parent.children) {
    if (!child) continue;
    if (child.type === 'comment' || child.type === 'line_comment' || child.type === 'block_comment') {
      pendingComment = child;
      continue;
    }
    const target = unwrap(child);
    const definition = grammar.definitions.has(target.type) || grammar.definitions.has(child.type);
    const start = pendingComment && pendingComment.endPosition.row + 1 >= child.startPosition.row ? pendingComment.startIndex : child.startIndex;
    const startLine = (start === child.startIndex ? child.startPosition.row : pendingCommentRow(parent, child)) + 1;
    pendingComment = null;
    const symbol = definition ? symbolOf(target) : null;
    const tooBig = child.endIndex - start > opts.max;
    const body = tooBig && definition ? containerBody(target, grammar) : null;
    if (body) {
      units.push(...collectUnits(body, text, grammar, opts, [...scope, ...(symbol ? [symbol] : [])]));
      continue;
    }
    units.push({ start, end: child.endIndex, startLine, endLine: child.endPosition.row + 1, symbol, kind: definition ? target.type : null, scope, definition });
  }
  return units;
}

/** Row of the comment node that immediately precedes `child` (the caller already checked adjacency). */
function pendingCommentRow(parent: Node, child: Node): number {
  const siblings = parent.children;
  const index = siblings.findIndex((n) => n !== null && n.id === child.id);
  const prev = index > 0 ? siblings[index - 1] : null;
  return prev ? prev.startPosition.row : child.startPosition.row;
}

/** `export function f() {}` and `@decorator def f()` wrap the real definition. */
function unwrap(node: Node): Node {
  if (node.type === 'export_statement' || node.type === 'decorated_definition') {
    const inner = node.namedChildren.find((c) => c !== null && c.type !== 'decorator' && c.type !== 'comment');
    if (inner) return inner;
  }
  return node;
}

function symbolOf(node: Node): string | null {
  const named = node.childForFieldName('name') ?? node.childForFieldName('declarator');
  if (named) return named.childForFieldName('name')?.text ?? named.text.split(/[\s(=:<]/)[0] ?? named.text;
  const declarator = node.descendantsOfType(['variable_declarator', 'identifier'])[0];
  const found = declarator?.childForFieldName('name')?.text ?? declarator?.text ?? null;
  if (found) return found;
  // Kotlin declares names as bare type_identifier / simple_identifier children with no field name.
  const bare = node.namedChildren.find((c) => c !== null && (c.type === 'type_identifier' || c.type === 'simple_identifier'));
  return bare?.text ?? null;
}

function containerBody(node: Node, grammar: Grammar): Node | null {
  if (!grammar.containers.has(node.type)) return null;
  const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c !== null && grammar.containers.has(c.type));
  return body ?? null;
}

// ---------- packing ----------

function packUnits(units: Unit[], text: string, language: string, relPath: string, opts: CodeChunkOptions): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let group: Unit[] = [];
  const flush = () => {
    if (group.length > 0) chunks.push(...emit(group, text, language, relPath, opts));
    group = [];
  };
  for (const unit of units) {
    const size = unit.end - unit.start;
    const groupSize = group.length ? group[group.length - 1]!.end - group[0]!.start : 0;
    const major = unit.definition && unit.kind !== null && !MINOR_KINDS.has(unit.kind);
    if (major || size > opts.max) {
      // Functions, classes and methods are search targets: one chunk each, never merged with neighbours.
      flush();
      chunks.push(...emit([unit], text, language, relPath, opts));
      continue;
    }
    if (group.length > 0 && groupSize + size > opts.target) flush();
    group.push(unit);
  }
  flush();
  return chunks.filter((c) => c.text.trim().length > 0);
}

/** One chunk per group; a single oversized unit becomes several line-window chunks sharing its symbol. */
function emit(group: Unit[], text: string, language: string, relPath: string, opts: CodeChunkOptions): CodeChunk[] {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const lead = group.find((u) => u.definition) ?? first;
  const header = [relPath, ...lead.scope, lead.symbol].filter((s): s is string => Boolean(s)).join(' › ');
  const body = text.slice(first.start, last.end);
  if (body.length <= opts.max) {
    return [{ text: `${header}\n${body.replace(/\s+$/, '')}`, language, symbol: lead.symbol, kind: lead.kind, startLine: first.startLine, endLine: last.endLine }];
  }
  return chunkTextWithOffsets(body, { size: opts.max, overlap: Math.floor(opts.max / 10) }).map((piece) => {
    const before = body.slice(0, piece.start);
    const startLine = first.startLine + countLines(before);
    return {
      text: `${header}\n${piece.text}`,
      language,
      symbol: lead.symbol,
      kind: lead.kind,
      startLine,
      endLine: startLine + countLines(piece.text),
    };
  });
}

function fallbackChunks(text: string, language: string, relPath: string, opts: CodeChunkOptions): CodeChunk[] {
  return chunkTextWithOffsets(text, { size: opts.target, overlap: Math.floor(opts.target / 6) }).map((piece) => {
    const startLine = 1 + countLines(text.slice(0, piece.start));
    return { text: `${relPath}\n${piece.text}`, language, symbol: null, kind: null, startLine, endLine: startLine + countLines(piece.text) };
  });
}

const countLines = (s: string): number => (s.match(/\n/g) ?? []).length;

/** Test hook: point a language at a grammar file name (possibly bogus) to exercise the fallback path. */
export function registerGrammarForTests(language: string, grammar: string): void {
  GRAMMARS[language] = def(grammar, ['function_declaration']);
}
