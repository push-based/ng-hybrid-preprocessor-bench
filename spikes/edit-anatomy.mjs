// Spike for the Vite-plugin investigation: what does one edit cost ngp, piece by piece, and can a
// plugin regenerate only the module Vite asks for instead of everything the delta marks stale?
//
// For each edit it measures, in one long-lived compiler (like a dev server):
//   update      analyzer.updateFileContent([...])          the Rust side absorbing the edit
//   delta       iterating analyzeOptimizedDelta() to the end, processing nothing
//   lazy        regenerating only the edited component, without running the delta first
// and it checks correctness against a fresh compiler that builds the edited sources from scratch:
//   - is the lazy output for the edited component identical to the fresh build's?
//   - which files' output actually changed, versus how many the analyzer reported stale?
//
// The workspace must be a scratch copy: edits are written to disk and reverted.
// Usage: node spikes/edit-anatomy.mjs --workspace <generated app copy> [--rounds 3]

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {readConfiguration} from '@angular/compiler-cli';
import {engineEnv, root} from '../harness/lib/paths.mjs';

const {values: args} = parseArgs({
  options: {workspace: {type: 'string'}, rounds: {type: 'string', default: '3'}},
});
const workspace = await fs.realpath(path.resolve(args.workspace));
const tsconfig = path.join(workspace, 'tsconfig.app.json');
const rounds = Number(args.rounds);
Object.assign(process.env, engineEnv('native').env);
const ngp = await import(path.join(root, 'toolchain/out/preprocessor/api.js'));
const ngOptions = readConfiguration(tsconfig).options;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const now = () => performance.now();

// No tsconfigPath: HybridCompiler then skips rewriting .ngdiag.json after every chunk, which a
// dev-server plugin wouldn't do either.
async function createCompiler() {
  const analyzer = await ngp.createAnalyzer(tsconfig, {optimize: true, backend: 'native'});
  const compiler = new ngp.HybridCompiler(analyzer, {
    optimize: true,
    tcbConfig: ngp.buildTypeCheckingConfig(ngOptions, false),
    rootDir: workspace,
    supportJitMode: ngOptions.supportJitMode !== false,
  });
  return compiler;
}

/** The CLI path: stream the whole program and generate every file. */
async function fullBuild(compiler) {
  const out = new Map();
  for await (const chunk of compiler.analyzeOptimized()) {
    const ctx = await compiler.prepareChunk(chunk);
    for (const f of chunk.files) {
      const content = await fs.readFile(f.filePath, 'utf8');
      const p = await compiler.processFile(f.filePath, content, f, ctx);
      out.set(path.resolve(f.filePath), p.magicString.toString());
    }
  }
  return out;
}

/** The Vite path: one file, no chunk iteration, metadata fetched on demand. */
async function lazyFile(compiler, file) {
  compiler.fileCache.delete(file);
  const content = await fs.readFile(file, 'utf8');
  const p = await compiler.processFile(file, content);
  return p.magicString.toString();
}

// Same edits as S6 (harness/incremental-worker.mjs), so numbers line up with the CI report.
const name = path.basename(workspace);
const pad = name.includes('-5000-') ? 3 : name.includes('-1000-') ? 2 : 1;
const f0 = `f${'0'.repeat(pad)}`;
const firstChild = `${f0}-c01`;
const edits = [
  {
    kind: 'class-field',
    file: `src/app/features/${f0}/${firstChild}.ts`,
    apply: (src, i) =>
      src.replace("protected readonly query = signal('');", `protected readonly query = signal('');\n\n  protected readonly benchEdit = signal(${i});`),
  },
  {
    kind: 'template',
    file: null, // first external template in the first feature, found below
    apply: (src, i) => `${src.trimEnd()}\n<p>bench edit ${i}: {{ count() }}</p>\n`,
  },
  {
    // A public-API edit: the selector decides which parent elements match this component, so the
    // parent's compiled output changes too. This is the case where regenerating only the edited
    // file is not enough, and the stale set has to cover the parents.
    kind: 'selector',
    file: `src/app/features/${f0}/${firstChild}.ts`,
    apply: (src, i) => src.replace(`selector: 'app-${firstChild}'`, `selector: 'app-${firstChild}-renamed${i}'`),
  },
  {
    kind: 'shared-type',
    file: 'src/app/shared/models.ts',
    apply: (src, i) => src.replace('readonly createdAt: Date;', `readonly createdAt: Date;\n  readonly benchEdit${i}?: number;`),
  },
];
const featureDir = path.join(workspace, 'src/app/features', f0);
const html = (await fs.readdir(featureDir)).filter((n) => n.endsWith('.html')).sort()[0];
edits[1].file = path.relative(workspace, path.join(featureDir, html));
for (const e of edits) {
  const src = await fs.readFile(path.join(workspace, e.file), 'utf8');
  if (e.apply(src, 0) === src) throw new Error(`edit ${e.kind} doesn't apply to ${e.file}`);
}

const live = await createCompiler();
let t = now();
const before = await fullBuild(live);
const result = {workspace: name, files: before.size, initialBuildMs: now() - t, edits: []};

for (const edit of edits) {
  const abs = path.join(workspace, edit.file);
  const original = await fs.readFile(abs, 'utf8');
  // The component a Vite plugin would re-transform: the edited .ts, or the template's component.
  const target = abs.endsWith('.html')
    ? path.resolve((await live.analyzer.getTsFileForTemplate(abs))[0].tsFilePath)
    : abs;
  const times = {update: [], delta: [], lazy: [], lazyStale: []};
  let staleLazy = new Map();
  let stale = [];
  let deltaFiles = 0;
  let lazyOut = null;

  for (let i = 1; i <= rounds; i++) {
    const edited = edit.apply(original, i);
    await fs.writeFile(abs, edited);

    // Lazy first: update, then regenerate the target without touching the delta.
    t = now();
    const invalidated = await live.analyzer.updateFileContent([{filePath: abs, content: edited}]);
    times.update.push(now() - t);
    stale = invalidated.filter((p) => p.endsWith('.ts')).map((p) => path.resolve(p));
    t = now();
    lazyOut = await lazyFile(live, target);
    times.lazy.push(now() - t);
    // What a plugin would do for every stale module Vite has loaded: regenerate it, still without
    // the delta. Here that's every stale file, which is the worst case.
    t = now();
    staleLazy = new Map();
    for (const f of stale) staleLazy.set(f, await lazyFile(live, f));
    times.lazyStale.push(now() - t);

    // Then the delta the CLI path would run, to measure it on its own.
    t = now();
    deltaFiles = 0;
    for await (const chunk of live.analyzeOptimizedDelta()) {
      deltaFiles += chunk.files.length;
      for (const f of chunk.files) live.fileCache.delete(f.filePath);
    }
    times.delta.push(now() - t);

    if (i < rounds) {
      // Revert between rounds so each round is a fresh edit from the same base.
      await fs.writeFile(abs, original);
      await live.analyzer.updateFileContent([{filePath: abs, content: original}]);
      for await (const chunk of live.analyzeOptimizedDelta()) for (const f of chunk.files) live.fileCache.delete(f.filePath);
    }
  }

  // Ground truth: a fresh compiler on the edited sources (last round's edit is still on disk).
  const fresh = await createCompiler();
  const after = await fullBuild(fresh);
  fresh.analyzer.close();
  const changed = [...after.keys()].filter((f) => after.get(f) !== before.get(f));
  const staleSet = new Set(stale);

  result.edits.push({
    kind: edit.kind,
    file: edit.file,
    regenerated: path.relative(workspace, target),
    medianMs: {
      update: median(times.update),
      lazy: median(times.lazy),
      lazyStale: median(times.lazyStale),
      delta: median(times.delta),
    },
    deltaStreamedFiles: deltaFiles,
    reportedStale: stale.length,
    actuallyChanged: changed.map((f) => path.relative(workspace, f)),
    staleCoversChanged: changed.every((f) => staleSet.has(f)),
    lazyMatchesFresh: lazyOut === after.get(target),
    // Every file whose output changed, regenerated without the delta, matches the fresh build.
    lazyStaleMatchesFresh: changed.every((f) => staleLazy.get(f) === after.get(f)),
  });

  // Restore the original and bring the live compiler back in step.
  await fs.writeFile(abs, original);
  await live.analyzer.updateFileContent([{filePath: abs, content: original}]);
  for await (const chunk of live.analyzeOptimizedDelta()) for (const f of chunk.files) live.fileCache.delete(f.filePath);
}
live.analyzer.close();

console.log(JSON.stringify(result, null, 2));
