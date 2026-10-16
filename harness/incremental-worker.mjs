// One compiler's side of S6. Run by harness/incremental.mjs; prints a JSON result on stdout.
//
// The workspace is a scratch copy the orchestrator made, so edits go to disk like in watch mode.
//
//   ngc  A caching compiler host plus `new NgtscProgram(..., oldProgram)` per rebuild, with
//        `getModifiedResourceFiles` for template edits: what ngc's own watch mode and the CLI do.
//        Emit skips files ngc's incremental tracking marks unchanged. ngc saves that tracking state
//        only after template type-checking, so the worker saves it after emit (see build()).
//   ngp  One HybridCompiler for the whole session. A rebuild sends the edit to the analyzer
//        (`updateFileContent`), runs `analyzeOptimizedDelta`, and regenerates only the .ts files the
//        analyzer reported stale, then turns them into JavaScript with esbuild, like the S2 candidate.
//
// After the timed rounds of each edit, the incremental output is compared byte for byte with a
// fresh full build of the same edited sources. A mismatch fails the edit.
//
// Usage: node harness/incremental-worker.mjs --compiler ngc|ngp --workspace <copy> --tsconfig <path>
//          --out <dir> --edits <edits.json> --rounds N --warmup N

import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import ts from 'typescript';
import * as esbuild from 'esbuild';
import {NgtscProgram, createCompilerHost, readConfiguration} from '@angular/compiler-cli';

const {values: args} = parseArgs({
  options: {
    compiler: {type: 'string'},
    workspace: {type: 'string'},
    tsconfig: {type: 'string'},
    out: {type: 'string'},
    edits: {type: 'string'},
    rounds: {type: 'string', default: '5'},
    warmup: {type: 'string', default: '1'},
  },
});
const workspace = path.resolve(args.workspace);
const tsconfig = path.resolve(args.tsconfig);
const outRoot = path.resolve(args.out);
const edits = JSON.parse(await fs.readFile(args.edits, 'utf8'));
const rounds = Number(args.rounds);
const warmup = Number(args.warmup);
// Each edit changes something different every round, so no round can reuse the previous output.
const APPLY = {
  // A new signal field on a component class.
  'class-field': (src, i) =>
    src.replace("protected readonly query = signal('');", `protected readonly query = signal('');\n\n  protected readonly benchEdit = signal(${i});`),
  // One more element at the end of an external template.
  template: (src, i) => `${src.trimEnd()}\n<p>bench edit ${i}: {{ count() }}</p>\n`,
  // A new optional field on the Item interface, which every component imports.
  'shared-type': (src, i) => src.replace('readonly createdAt: Date;', `readonly createdAt: Date;\n  readonly benchEdit${i}?: number;`),
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

async function hashDir(dir) {
  const entries = (await fs.readdir(dir, {recursive: true, withFileTypes: true}))
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
  const files = {};
  for (const f of entries) files[f] = createHash('sha256').update(await fs.readFile(path.join(dir, f))).digest('hex');
  return files;
}
function diffHashes(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => a[k] !== b[k]);
}

// ---------------------------------------------------------------------------------------------
// ngc

function createNgcSession(outDir) {
  const config = readConfiguration(tsconfig, {outDir, noEmit: false, declaration: false, sourceMap: true});
  const host = createCompilerHost({options: config.options});
  const getSourceFile = host.getSourceFile.bind(host);
  const cache = new Map();
  let modifiedResources = new Set();
  let written = 0;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const key = path.resolve(fileName);
    if (!cache.has(key)) cache.set(key, getSourceFile(fileName, languageVersion, onError, shouldCreate));
    return cache.get(key);
  };
  host.getModifiedResourceFiles = () => modifiedResources;
  const writeFile = host.writeFile.bind(host);
  host.writeFile = (...a) => {
    written++;
    return writeFile(...a);
  };
  let previous;
  return {
    async build(changedFile) {
      if (changedFile) {
        cache.delete(path.resolve(changedFile));
        modifiedResources = changedFile.endsWith('.ts') ? new Set() : new Set([path.resolve(changedFile)]);
      }
      written = 0;
      const program = new NgtscProgram(config.rootNames, config.options, host, previous);
      await program.loadNgStructureAsync();
      const res = program.emit();
      if (res.emitSkipped) throw new Error('ngc emit skipped');
      // ngc records its incremental state only after template type-checking
      // (NgCompiler.getTemplateDiagnostics). S6 times transform-only rebuilds, so without this every
      // rebuild would be a full compile. Recording it after emit gives ngc its best case.
      program.compiler.incrementalStrategy.setIncrementalState(
        program.compiler.incrementalCompilation.state,
        program.getTsProgram(),
      );
      previous = program;
      modifiedResources = new Set();
      // ngc writes a .js and a .js.map per source file.
      return Math.round(written / 2);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ngp

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ngpApi = await import(path.join(root, 'toolchain/out/preprocessor/api.js'));

async function createNgpSession(outDir) {
  const raw = ts.readConfigFile(tsconfig, ts.sys.readFile).config;
  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, path.dirname(tsconfig), undefined, tsconfig);
  const ngOptions = readConfiguration(tsconfig).options;
  const analyzer = await ngpApi.createAnalyzer(tsconfig, {optimize: true});
  const compiler = new ngpApi.HybridCompiler(analyzer, {
    optimize: true,
    tsconfigPath: tsconfig,
    tcbConfig: ngpApi.buildTypeCheckingConfig(ngOptions, false),
    rootDir: workspace,
    supportJitMode: ngOptions.supportJitMode !== false,
  });
  const tsconfigRaw = {
    compilerOptions: {
      experimentalDecorators: parsed.options.experimentalDecorators,
      useDefineForClassFields: parsed.options.useDefineForClassFields,
      target: 'es2022',
    },
  };

  // esbuild transforms are queued and awaited once per build: ngp delivers one file per chunk,
  // and waiting on an esbuild round trip per chunk would add seconds that aren't ngp's.
  let transforms = [];
  async function emit(file, chunkContext) {
    const content = await fs.readFile(file.filePath, 'utf8');
    const processed = await compiler.processFile(file.filePath, content, file, chunkContext);
    const rel = path.relative(workspace, file.filePath);
    const target = path.join(outDir, rel);
    await fs.mkdir(path.dirname(target), {recursive: true});
    const code = processed.magicString.toString();
    const map = processed.magicString.generateMap({source: rel, file: path.basename(target), includeContent: true});
    transforms.push(
      esbuild
        .transform(code, {loader: 'ts', format: 'esm', sourcemap: true, sourcefile: rel, tsconfigRaw})
        .then((js) =>
          Promise.all([
            fs.writeFile(target.replace(/\.ts$/, '.js'), js.code),
            fs.writeFile(target.replace(/\.ts$/, '.js.map'), js.map),
          ]),
        ),
    );
    const writes = [fs.writeFile(target, code), fs.writeFile(target + '.map', map.toString())];
    if (processed.tcb) writes.push(fs.writeFile(target.replace(/\.ts$/, '.ngtypecheck.ts'), processed.tcb.code));
    await Promise.all(writes);
  }

  return {
    async build(changedFile) {
      let stale = null;
      let iterator;
      if (changedFile) {
        const content = await fs.readFile(changedFile, 'utf8');
        const invalidated = await compiler.analyzer.updateFileContent([{filePath: changedFile, content}]);
        stale = new Set(invalidated.filter((p) => p.endsWith('.ts')).map((p) => path.resolve(p)));
        iterator = compiler.analyzeOptimizedDelta();
      } else {
        iterator = compiler.analyzeOptimized();
      }
      let count = 0;
      for await (const chunk of iterator) {
        // A delta re-streams every file; HybridCompiler drops their cached analyses the same way.
        for (const f of chunk.files) compiler.fileCache.delete(f.filePath);
        const files = stale ? chunk.files.filter((f) => stale.has(path.resolve(f.filePath))) : chunk.files;
        if (files.length === 0) continue;
        const chunkContext = await compiler.prepareChunk(chunk);
        await Promise.all(files.map((f) => emit(f, chunkContext)));
        count += files.length;
      }
      await Promise.all(transforms);
      transforms = [];
      return count;
    },
    close: () => analyzer.close(),
  };
}

// ---------------------------------------------------------------------------------------------

const create = args.compiler === 'ngc' ? createNgcSession : createNgpSession;
const liveOut = path.join(outRoot, `${args.compiler}-live`);
await fs.rm(liveOut, {recursive: true, force: true});
const session = await create(liveOut);

let start = performance.now();
const initialFiles = await session.build(null);
const result = {compiler: args.compiler, initial: {ms: performance.now() - start, files: initialFiles}, edits: []};

for (const edit of edits) {
  const file = path.join(workspace, edit.file);
  const original = await fs.readFile(file, 'utf8');
  const times = [];
  let files = 0;
  for (let i = 0; i < warmup + rounds; i++) {
    // A different value every round, so no round can reuse the previous round's output.
    const edited = APPLY[edit.kind](original, i);
    if (edited === original) throw new Error(`edit ${edit.id} did not change ${edit.file}`);
    await fs.writeFile(file, edited);
    start = performance.now();
    files = await session.build(file);
    const ms = performance.now() - start;
    if (i >= warmup) times.push(ms);
    if (i < warmup + rounds - 1) {
      await fs.writeFile(file, original);
      await session.build(file);
    }
  }

  // The live output now reflects the last edited round. A fresh build of the same sources
  // must produce identical files.
  const freshOut = path.join(outRoot, `${args.compiler}-fresh-${edit.id}`);
  await fs.rm(freshOut, {recursive: true, force: true});
  const fresh = await create(freshOut);
  await fresh.build(null);
  fresh.close?.();
  const mismatched = diffHashes(await hashDir(liveOut), await hashDir(freshOut));
  await fs.rm(freshOut, {recursive: true, force: true});

  await fs.writeFile(file, original);
  await session.build(file);
  result.edits.push({
    id: edit.id,
    medianMs: median(times),
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    timesMs: times,
    files,
    matchesFreshBuild: mismatched.length === 0,
    mismatched: mismatched.slice(0, 10),
  });
}
session.close?.();
process.stdout.write(JSON.stringify(result));
