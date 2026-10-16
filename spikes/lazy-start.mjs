// Spike for the Vite-plugin investigation: can ngp compile modules on demand, the way Vite's dev
// server requests them, without streaming the whole program first?
//
// Three ways to produce every file's output, each in a fresh compiler:
//   full     the CLI path: stream analyzeOptimized()/analyze(), prepareChunk, processFile
//   lazy     no streaming at all: processFile(file, content) per file, in import order from main.ts
//   warmed   compiler.init() (the analyzer's full pass, nothing generated), then the lazy loop
// It reports how long the first module takes (what a browser waits for), the total, and whether
// lazy and warmed outputs are byte-identical to full.
//
// Usage: node spikes/lazy-start.mjs --workspace <generated app> [--mode optimize|local]

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {readConfiguration} from '@angular/compiler-cli';
import {engineEnv, root} from '../harness/lib/paths.mjs';

const {values: args} = parseArgs({
  options: {workspace: {type: 'string'}, mode: {type: 'string', default: 'optimize'}},
});
const workspace = await fs.realpath(path.resolve(args.workspace));
const tsconfig = path.join(workspace, 'tsconfig.app.json');
const optimize = args.mode === 'optimize';
Object.assign(process.env, engineEnv('native').env);
const ngp = await import(path.join(root, 'toolchain/out/preprocessor/api.js'));
const ngOptions = readConfiguration(tsconfig).options;
const now = () => performance.now();

async function createCompiler() {
  const analyzer = await ngp.createAnalyzer(tsconfig, {optimize, backend: 'native'});
  return new ngp.HybridCompiler(analyzer, {
    optimize,
    tcbConfig: ngp.buildTypeCheckingConfig(ngOptions, false),
    rootDir: workspace,
    supportJitMode: ngOptions.supportJitMode !== false,
  });
}

// Module order a browser would request: depth-first over relative imports from main.ts.
async function importOrder() {
  const seen = new Set();
  const order = [];
  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    order.push(file);
    const src = await fs.readFile(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import\()\s*'(\.[^']+)'/g)) {
      await visit(path.resolve(path.dirname(file), m[1]) + '.ts');
    }
  }
  await visit(path.join(workspace, 'src/main.ts'));
  return order;
}

async function full() {
  const t0 = now();
  const compiler = await createCompiler();
  const out = new Map();
  let first = null;
  const iterate = optimize ? compiler.analyzeOptimized() : compiler.analyze();
  for await (const chunk of iterate) {
    const ctx = await compiler.prepareChunk(chunk);
    for (const f of chunk.files) {
      const content = await fs.readFile(f.filePath, 'utf8');
      out.set(path.resolve(f.filePath), (await compiler.processFile(f.filePath, content, f, ctx)).magicString.toString());
      first ??= now() - t0;
    }
  }
  compiler.analyzer.close();
  return {out, firstMs: first, totalMs: now() - t0};
}

async function lazy(order, {warm}) {
  const t0 = now();
  const compiler = await createCompiler();
  let initMs = null;
  if (warm) {
    await compiler.init();
    initMs = now() - t0;
  }
  const out = new Map();
  let first = null;
  for (const file of order) {
    const content = await fs.readFile(file, 'utf8');
    out.set(file, (await compiler.processFile(file, content)).magicString.toString());
    first ??= now() - t0;
  }
  compiler.analyzer.close();
  return {out, firstMs: first, initMs, totalMs: now() - t0};
}

const order = await importOrder();
const ref = await full();
const result = {workspace: path.basename(workspace), mode: args.mode, modules: order.length, full: {firstMs: ref.firstMs, totalMs: ref.totalMs}};
for (const [label, opts] of [['lazy', {warm: false}], ['warmed', {warm: true}]]) {
  const r = await lazy(order, opts);
  const mismatched = order.filter((f) => r.out.get(f) !== ref.out.get(f));
  result[label] = {
    firstMs: r.firstMs,
    initMs: r.initMs,
    totalMs: r.totalMs,
    mismatched: mismatched.length,
    firstMismatches: mismatched.slice(0, 3).map((f) => path.relative(workspace, f)),
  };
}
console.log(JSON.stringify(result, null, 2));
