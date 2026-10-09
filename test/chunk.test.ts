import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { CHUNKER_VERSION, chunkCode, chunkCodeDetailed, languageOf, loadAllGrammars, registerGrammarForTests, supportedLanguages } from '../src/chunk/code';
import { chunkText, chunkTextWithOffsets } from '../src/chunk/text';

const repo = path.resolve(import.meta.dirname, 'fixtures/sample-repo');
const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');
const opts = { target: 1200, max: 2400 };

describe('chunkText', () => {
  test('covers every character with overlapping windows snapped to boundaries', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about tides.`).join(' ');
    const chunks = chunkTextWithOffsets(text, { size: 200, overlap: 40 });
    assert.ok(chunks.length > 5);
    for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i]!.start < chunks[i - 1]!.end, 'consecutive chunks overlap');
    assert.equal(chunks[0]!.start, 0);
    assert.equal(chunks.at(-1)!.end, text.length);
  });

  test('rejects bad options and drops whitespace-only pieces', () => {
    assert.throws(() => chunkText('x', { size: 10, overlap: 10 }), /overlap/);
    assert.throws(() => chunkText('x', { size: 0, overlap: 0 }), /positive/);
    assert.deepEqual(chunkText('   \n\n  ', { size: 4, overlap: 1 }), []);
  });
});

describe('chunkCode', () => {
  test('every grammar in GRAMMARS loads under Node', async () => {
    assert.deepEqual(await loadAllGrammars(), []);
  });

  test('TypeScript: one chunk per definition with symbol, kind, lines and a path header', async () => {
    const chunks = await chunkCode(await read('src/services/webhooks.ts'), 'typescript', 'src/services/webhooks.ts', opts);
    const symbols = chunks.map((c) => c.symbol);
    assert.ok(symbols.includes('verifySignature'));
    assert.ok(symbols.includes('WebhookDispatcher'));
    const fn = chunks.find((c) => c.symbol === 'verifySignature')!;
    assert.equal(fn.kind, 'function_declaration');
    assert.ok(fn.text.startsWith('src/services/webhooks.ts › verifySignature'));
    assert.ok(fn.text.includes('/** Verify the Shift4'));
    assert.equal(fn.startLine, 3);
    assert.equal(fn.endLine, 7);
    assert.ok(chunks.every((c) => c.language === 'typescript'));
  });

  test('Python and Dart parse too', async () => {
    const py = await chunkCode(await read('src/services/refunds.py'), 'python', 'src/services/refunds.py', opts);
    for (const s of ['issue_refund', 'RefundQueue']) assert.ok(py.map((c) => c.symbol).includes(s), s);
    const dart = await chunkCode(await read('src/terminal.dart'), 'dart', 'src/terminal.dart', opts);
    assert.ok(dart.map((c) => c.symbol).includes('TerminalSession'));
  });

  const samples: Array<[string, string, string]> = [
    ['go', 'package main\n\n// Add sums.\nfunc Add(a, b int) int {\n\treturn a + b\n}\n\ntype Point struct{ X, Y int }\n', 'Add'],
    ['rust', '/// Adds.\nfn add(a: i32, b: i32) -> i32 { a + b }\n\nstruct Point { x: i32 }\n', 'add'],
    ['java', 'public class Greeter {\n  public String greet(String n) { return "hi " + n; }\n}\n', 'Greeter'],
    ['kotlin', 'class Greeter {\n  fun greet(n: String) = "hi $n"\n}\n\nfun main() { println(Greeter().greet("x")) }\n', 'Greeter'],
  ];
  for (const [language, source, symbol] of samples) {
    test(`${language} yields a definition chunk for ${symbol}`, async () => {
      const result = await chunkCodeDetailed(source, language, `x.${language}`, opts);
      assert.equal(result.fallbackReason, undefined);
      assert.ok(result.chunks.some((c) => c.symbol === symbol && c.kind !== null), JSON.stringify(result.chunks.map((c) => [c.symbol, c.kind])));
    });
  }

  test('packs small neighbours and splits a large class into its methods', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const packed = await chunkCode(many, 'typescript', 'a.ts', opts);
    assert.ok(packed.length < 40);
    assert.ok(packed.every((c) => c.text.length <= opts.max + 100));

    const methods = Array.from({ length: 12 }, (_, i) => `  m${i}() {\n    return "${'x'.repeat(300)}";\n  }`).join('\n');
    const split = await chunkCode(`export class Big {\n${methods}\n}`, 'typescript', 'big.ts', opts);
    assert.ok(split.length > 1);
    assert.ok(split.some((c) => c.text.startsWith('big.ts › Big › m0')));
  });

  test('falls back to the sliding window for unparsed languages', async () => {
    const md = await chunkCode(await read('README.md'), 'markdown', 'README.md', opts);
    assert.equal(md.length, 1);
    assert.equal(md[0]!.symbol, null);
    assert.ok(md[0]!.text.startsWith('README.md\n'));
    assert.equal(md[0]!.startLine, 1);
  });

  test('never throws: a grammar that cannot load falls back and says why', async () => {
    registerGrammarForTests('bogus', 'does-not-exist');
    const result = await chunkCodeDetailed('function f() {}\n', 'bogus', 'x.bogus', opts);
    assert.ok(result.fallbackReason);
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0]!.symbol, null);
    const again = await chunkCodeDetailed('function g() {}\n', 'bogus', 'y.bogus', opts);
    assert.equal(again.chunks.length, 1);
  });

  test('shell scripts use the window chunker', async () => {
    const result = await chunkCodeDetailed('#!/bin/sh\nf() { echo "${1:-x}"; }\nf a\n', 'bash', 's.sh', opts);
    assert.equal(result.fallbackReason, undefined);
    assert.equal(result.chunks[0]!.symbol, null);
    assert.equal(result.chunks[0]!.language, 'bash');
  });

  test('language detection and the supported list', () => {
    assert.equal(languageOf('a/b.tsx'), 'tsx');
    assert.equal(languageOf('a/b.kts'), 'kotlin');
    assert.equal(languageOf('scripts/Makefile'), 'text');
    assert.ok(supportedLanguages().includes('dart'));
    assert.match(CHUNKER_VERSION, /\S/);
  });
});
