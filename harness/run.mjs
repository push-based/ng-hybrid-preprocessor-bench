// Benchmark runner. Each scenario compares one baseline with one or more ngp candidates on the
// same job; R is a reference with no ngp side.
//
//   S1  transform only, local mode    ngc (experimental-local)  vs  ngp, then esbuild
//   S2  transform, cross-file opt.    ngc (full)                vs  ngp --optimize, then esbuild
//   S3  type-check (also reports S4)  ngc type-check            vs  ngp --optimize, then tsc 6 (S3)
//                                                                   ngp --optimize, then tsgo 7 (S4)
//   S5  analyzer engines              ngc (full)                vs  the S2 candidate on native, wasm, sidecar
//   S6  rebuild after one edit        in-process, see harness/incremental.mjs
//   S7  development bundle            ng build (development)    vs  ngp --optimize, then an esbuild bundle
//                                                                   ...and the same plus tsgo
//   R   reference                     ng build (development and production) with the CLI's own phases
//
// For every scenario and target it does three things, in this order:
//   1. Correctness gate (untimed). Every pipeline must finish its job correctly: emit one file per
//      source file, report no diagnostics, load the requested engine, and for S7 boot in Chrome.
//      A failed gate is recorded, and that pipeline is not timed.
//   2. hyperfine: warm-up runs, then measured runs of every passing pipeline, outputs wiped before each.
//   3. Phase runs under /usr/bin/time: ngc's tracePerformance phases or the CLI's NG_BUILD_DEBUG_PERF
//      phases, ngp's NGP_PHASE_TIMINGS phases, each follow-up step on its own, and peak RSS.
//
// Usage: node harness/run.mjs [--scenario S1,S2,S3,S5,S6,S7,R] [--size 100,1000,5000,real:<name>]
//          [--engine native] [--runs 10] [--warmup 2] [--phase-runs 3] [--seed 1] [--heap-mb 6144]
//
// A target is a generated app size, or `real:<name>` for a pinned real app (corpus/real/).
// Every Node process, on both sides, gets the same --max-old-space-size (default 6144 MB). On an
// 8 GB runner Node's default heap is about 2 GB, and ngc's full type-check of the 5,000-component
// app runs out of memory there. Writes results/runs/<run-id>/ and then the report.
//
// Generated apps are read from CORPUS_DIR (default: corpus/generated), real apps from REAL_DIR
// (default: corpus/real-apps). Compiler output goes to BENCH_OUT_DIR (default: the OS temp
// directory), never into the project: IDEs and Spotlight react to thousands of new files there.

import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {verifyCorpus} from './lib/corpus.mjs';
import {captureEnvironment} from './lib/environment.mjs';
import {engineEnv, hyperfineBin, ngpMain, root, tscBin, tsgoBin} from './lib/paths.mjs';
import {summarize} from './lib/stats.mjs';
import ts from 'typescript';

const {values: args} = parseArgs({
  options: {
    scenario: {type: 'string', default: 'S1,S2,S3,S5,S6,S7,R'},
    size: {type: 'string', default: '100,1000,5000'},
    engine: {type: 'string', default: 'native'},
    runs: {type: 'string', default: '10'},
    warmup: {type: 'string', default: '2'},
    'phase-runs': {type: 'string', default: '3'},
    seed: {type: 'string', default: '1'},
    'heap-mb': {type: 'string', default: '6144'},
  },
});

const engine = args.engine;
const ngBin = path.join(root, 'node_modules/@angular/cli/bin/ng.js');

// Follow-up steps after ngp. Each gets the ngp output dir and the scenario's paths.
const STEPS = {
  esbuild: (t, p) => ['harness/esbuild-transform.mjs', p.ngpOut, '--tsconfig', t.tsconfigRoot],
  tsc: (t, p) => [tscBin, '-p', p.checkConfig],
  tsgo: (t, p) => [tsgoBin, '-p', p.checkConfig],
  bundle: (t, p) => ['harness/ngp-bundle.mjs', p.ngpOut, '--workspace', t.workspace, '--out', p.distOut],
};

const SCENARIOS = {
  S1: {
    title: 'Transform only, local mode',
    description:
      'Angular source to JavaScript, no type-checking. Baseline: ngc in `experimental-local` mode, ' +
      'analyze and emit, no diagnostics. Candidate: `ngp`, then esbuild to JavaScript.',
    baseline: 'ngc-local',
    candidates: [{id: 'S1', label: 'ngp + esbuild', ngpArgs: [], steps: ['esbuild']}],
  },
  S2: {
    title: 'Transform with cross-file optimization',
    description:
      'Angular source to JavaScript with cross-file analysis, no type-checking. Baseline: ngc in full ' +
      'mode, analyze and emit, no diagnostics. Candidate: `ngp --optimize`, then esbuild. ngp also ' +
      'generates type-check blocks in this mode, which the baseline does not.',
    baseline: 'ngc-full',
    candidates: [{id: 'S2', label: 'ngp --optimize + esbuild', ngpArgs: ['--optimize'], steps: ['esbuild']}],
  },
  S3: {
    title: 'Type-check templates and TypeScript',
    description:
      'Report every template and TypeScript error, emit nothing. Baseline: ngc\'s full type-check, which ' +
      'builds type-check blocks inside its own TypeScript 6 program. Candidates: `ngp --optimize` ' +
      'writes the type-check blocks as files, then TypeScript checks them: `tsc` 6 (S3) or `tsgo` 7 (S4).',
    baseline: 'ngc-typecheck',
    candidates: [
      {id: 'S3', label: 'ngp --optimize + tsc 6', ngpArgs: ['--optimize'], steps: ['tsc']},
      {id: 'S4', label: 'ngp --optimize + tsgo 7', ngpArgs: ['--optimize'], steps: ['tsgo']},
    ],
  },
  S5: {
    title: 'Analyzer engines',
    description:
      'The S2 job with each analyzer engine forced in turn. native: the N-API addon, using every core. ' +
      'wasm: the WebAssembly build, single-threaded. sidecar: a separate process speaking JSON over stdio.',
    baseline: 'ngc-full',
    candidates: ['native', 'wasm', 'sidecar'].map((e) => ({
      id: `S5-${e}`,
      label: `ngp ${e} + esbuild`,
      engine: e,
      ngpArgs: ['--optimize'],
      steps: ['esbuild'],
    })),
  },
  S6: {title: 'Rebuild after one edit', incremental: true},
  S7: {
    title: 'Development bundle (indicative)',
    description:
      'A runnable development build that boots in Chrome. Baseline: `ng build --configuration ' +
      'development`, cold. Candidates: `ngp --optimize`, then an esbuild bundle with Angular\'s linker; and ' +
      'the same followed by `tsgo`, since `ng build` also type-checks. Indicative only: the ngp pipeline ' +
      'skips stylesheet processing, budgets and asset handling, and runs its steps one after another ' +
      'where the CLI overlaps them.',
    baseline: 'ng-build-dev',
    boot: true,
    candidates: [
      {id: 'S7', label: 'ngp --optimize + bundle', ngpArgs: ['--optimize'], steps: ['bundle']},
      {id: 'S7-tsgo', label: 'ngp --optimize + bundle + tsgo', ngpArgs: ['--optimize'], steps: ['bundle', 'tsgo']},
    ],
  },
  R: {title: 'Full ng build (reference, not a comparison)', reference: true},
};

// S4 is measured inside S3 (same baseline, second candidate).
const scenarios = [...new Set(args.scenario.split(',').map((s) => (s.trim() === 'S4' ? 'S3' : s.trim())))];
for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s}`);
const targets = args.size.split(',').map((s) => s.trim());
const runs = Number(args.runs);
const warmup = Number(args.warmup);
const phaseRuns = Number(args['phase-runs']);
const heapMb = Number(args['heap-mb']);

// Inherited by every child process: ngc, ngp, esbuild, tsc, tsgo, ng build, hyperfine's commands.
process.env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], `--max-old-space-size=${heapMb}`]
  .filter(Boolean)
  .join(' ');

// Real paths only: when ngp's input path runs through a symlink (macOS's /var -> /private/var),
// `ngp --out` computes output paths relative to the wrong root and overwrites the sources.
const corpusDir = await fs.realpath(path.resolve(process.env['CORPUS_DIR'] ?? path.join(root, 'corpus/generated')));
const realDir = path.resolve(process.env['REAL_DIR'] ?? path.join(root, 'corpus/real-apps'));
const benchOutRequested = path.resolve(
  process.env['BENCH_OUT_DIR'] ?? path.join(os.tmpdir(), 'ng-hybrid-preprocessor-bench'),
);
await fs.mkdir(benchOutRequested, {recursive: true});
const benchOut = await fs.realpath(benchOutRequested);

const env = await captureEnvironment();
const runId = `${env.date.replace(/[:.]/g, '-').slice(0, 19)}-${env.hostTag}`;
const runDir = path.join(root, 'results/runs', runId);
await fs.mkdir(path.join(runDir, 'hyperfine'), {recursive: true});
await fs.writeFile(
  path.join(runDir, 'run.json'),
  JSON.stringify({runId, scenarios, targets, engine, runs, warmup, phaseRuns, heapMb, environment: env}, null, 2) + '\n',
);
console.log(`run ${runId}: ${scenarios.join(', ')} x ${targets.join(', ')}, engine ${engine}, ${runs} runs`);
if (env.warnings.length) console.log(env.warnings.map((w) => `  warning: ${w}`).join('\n'));

const node = process.execPath;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function countFiles(dir, pred) {
  const entries = await fs.readdir(dir, {recursive: true, withFileTypes: true}).catch(() => []);
  return entries.filter((e) => e.isFile() && pred(e.name)).length;
}

/**
 * Runs a node script under /usr/bin/time; returns wall ms, peak RSS bytes and the script's output.
 * time's own statistics go to a separate file so they never bury the script's error messages.
 */
let timedCounter = 0;
function timed(scriptArgs, extraEnv = {}, cwd = root) {
  const timeFlag = process.platform === 'darwin' ? '-l' : '-v';
  const statsFile = path.join(benchOut, `time-${process.pid}-${timedCounter++}.txt`);
  const start = process.hrtime.bigint();
  const res = spawnSync('/usr/bin/time', [timeFlag, '-o', statsFile, node, ...scriptArgs], {
    cwd,
    env: {...process.env, ...extraEnv},
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  let stats = '';
  try {
    stats = readFileSync(statsFile, 'utf8');
    rmSync(statsFile);
  } catch {}
  const rss =
    process.platform === 'darwin'
      ? Number(stats.match(/(\d+)\s+maximum resident set size/)?.[1] ?? NaN)
      : Number(stats.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1] ?? NaN) * 1024;
  return {exit: res.status, ms, rss, output: (res.stdout ?? '') + (res.stderr ?? '')};
}

const tail = (output, n = 6) => output.trim().split('\n').slice(-n);
const msPhases = (perf) => Object.fromEntries(Object.entries(perf.phases).map(([k, v]) => [k, v / 1000]));
const cliPhases = (output) =>
  Object.fromEntries([...output.matchAll(/DURATION\[([A-Z_]+\*?)\]: ([\d.]+)s/g)].map((m) => [m[1], Number(m[2]) * 1000]));

/** A generated app (`100`) or a pinned real app (`real:<name>`), with the paths the harness needs. */
async function resolveTarget(item) {
  if (/^\d+$/.test(item)) {
    const name = `standalone-${item}-s${args.seed}`;
    const workspace = path.join(corpusDir, name);
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'manifest.json'), 'utf8'));
    return {
      name,
      label: Number(item).toLocaleString('en-US'),
      kind: 'generated',
      components: manifest.components,
      features: manifest.breakdown.pages,
      workspace,
      manifest,
      tsconfigApp: path.join(workspace, 'tsconfig.app.json'),
      tsconfigRoot: path.join(workspace, 'tsconfig.json'),
      ngpTarget: workspace,
      ngBin,
      paths: null,
    };
  }
  const real = item.match(/^real:(.+)$/)?.[1];
  if (!real) throw new Error(`unknown target ${item}`);
  const workspace = await fs.realpath(path.join(realDir, real));
  const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'manifest.json'), 'utf8'));
  return {
    name: real,
    label: real,
    kind: 'real',
    components: manifest.components ?? null,
    features: null,
    workspace,
    manifest,
    tsconfigApp: path.join(workspace, manifest.tsconfigApp),
    tsconfigRoot: path.join(workspace, manifest.tsconfigRoot ?? manifest.tsconfigApp),
    ngpTarget: path.join(workspace, manifest.ngpTarget ?? manifest.tsconfigApp),
    // A real app builds with its own CLI install.
    ngBin: path.join(workspace, 'node_modules/@angular/cli/bin/ng.js'),
    paths: resolvedPaths(path.join(workspace, manifest.tsconfigApp)),
  };
}

/**
 * Error codes `tsgo` (TypeScript 7) reports on a real app's own, uncompiled sources: TypeScript-only
 * errors the app would hit migrating to TS 7, before ngp is involved. Computed once per app.
 */
const knownTsgoErrors = new Map();
function tsgoErrorsOnOriginal(t) {
  if (!knownTsgoErrors.has(t.name)) {
    const r = spawnSync(node, [tsgoBin, '-p', t.tsconfigApp, '--noEmit', '--rootDir', t.workspace], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    knownTsgoErrors.set(t.name, errorCodes(r.stdout + r.stderr));
  }
  return knownTsgoErrors.get(t.name);
}
const errorCodes = (output) => (output.match(/error TS\d+/g) ?? []).map((m) => m.slice(6)).sort();

/** The app's `paths` aliases with absolute targets, or null if it has none. */
function resolvedPaths(tsconfig) {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {}});
  const {paths, pathsBasePath} = parsed?.options ?? {};
  if (!paths) return null;
  return Object.fromEntries(
    Object.entries(paths).map(([k, targets]) => [k, targets.map((x) => path.resolve(pathsBasePath, x))]),
  );
}

/**
 * The app's aliases, pointed at ngp's output first. An alias like `src/*` -> `./src/*` would
 * otherwise make TypeScript type-check the original, uncompiled sources instead of ngp's output.
 * The original stays as a fallback for files ngp doesn't emit, such as plain TypeScript libraries.
 */
function remappedPaths(t, ngpOut) {
  if (!t.paths) return undefined;
  return Object.fromEntries(
    Object.entries(t.paths).map(([k, targets]) => [
      k,
      targets.flatMap((abs) => {
        const rel = path.relative(t.workspace, abs);
        return rel.startsWith('..') || rel.includes('node_modules') ? [abs] : [path.join(ngpOut, rel), abs];
      }),
    ]),
  );
}

/** The baseline pipeline of a scenario: command, gate check and phase source. */
function baselineSpec(kind, t, out, sourceTs) {
  const transform = (mode) => ({
    label: `ngc (${mode === 'local' ? 'experimental-local' : 'full'} mode)`,
    args: ['harness/ngc-transform.mjs', t.tsconfigApp, '--mode', mode, '--out', out, '--root', t.workspace],
    gateArgs: ['--diagnostics'],
    traceArgs: (f) => ['--trace', f],
    // One .js per source file for generated apps; real apps may emit files outside src/.
    check: async () => {
      const js = await countFiles(out, (n) => n.endsWith('.js'));
      return t.kind === 'generated' ? js === sourceTs : js > 0;
    },
  });
  switch (kind) {
    case 'ngc-local':
      return transform('local');
    case 'ngc-full':
      return transform('full');
    case 'ngc-typecheck':
      return {
        label: 'ngc type-check',
        args: ['harness/ngc-typecheck.mjs', t.tsconfigApp, '--root', t.workspace],
        gateArgs: [],
        traceArgs: (f) => ['--trace', f],
        check: async () => true,
      };
    case 'ng-build-dev':
      return {
        label: 'ng build (development)',
        args: [t.ngBin, 'build', '--configuration', 'development', '--output-path', out, '--no-progress'],
        gateArgs: [],
        cwd: t.workspace,
        env: {NG_CLI_ANALYTICS: 'false'},
        // .angular/cache is the CLI's persistent cache; clearing it keeps every build cold.
        clean: [path.join(t.workspace, '.angular')],
        cliPhases: true,
        bootDir: out,
        check: async () => (await countFiles(out, (n) => n.endsWith('.js'))) > 0,
      };
    default:
      throw new Error(`unknown baseline ${kind}`);
  }
}

async function runPair(scenarioId, scenario, t) {
  const out = path.join(benchOut, `${scenarioId}-${t.name}`);
  // ngp writes its diagnostics next to the tsconfig it compiled.
  const diagFile = t.tsconfigApp.replace(/\.json$/, '.ngdiag.json');
  const sourceTs = await countSourceTs(t);
  const baseline = baselineSpec(scenario.baseline, t, path.join(out, 'baseline'), sourceTs);

  const candidates = scenario.candidates.map((c) => {
    const e = c.engine ?? engine;
    const {env: eEnv, extraArgs} = engineEnv(e);
    const dir = path.join(out, c.id);
    const p = {
      ngpOut: path.join(dir, 'ngp'),
      distOut: path.join(dir, 'dist'),
      checkConfig: path.join(out, `${c.id}.tsconfig.json`),
    };
    return {
      ...c,
      engine: e,
      env: eEnv,
      dir,
      paths: p,
      ngpArgs: [ngpMain, t.ngpTarget, ...c.ngpArgs, '--out', p.ngpOut, '--root', t.workspace, ...extraArgs],
      stepArgs: c.steps.map((s) => ({name: s, args: STEPS[s](t, p)})),
    };
  });

  // The output dir sits outside the repo: link node_modules so @angular/* resolves for tsc and
  // tsgo, and write each candidate's type-check config, which extends the app's own tsconfig.
  const setupOut = async () => {
    await fs.mkdir(out, {recursive: true});
    // Real apps resolve packages from their own install; generated apps from this repo's.
    const modules = t.kind === 'real' ? path.join(t.workspace, 'node_modules') : path.join(root, 'node_modules');
    await fs.symlink(modules, path.join(out, 'node_modules'), 'dir').catch(() => {});
    for (const c of candidates) {
      await fs.writeFile(
        c.paths.checkConfig,
        JSON.stringify({
          extends: t.tsconfigRoot,
          // rootDir only gates which files may be part of the program here (nothing is emitted).
          // Path-alias fallbacks can resolve to the app's own non-Angular sources outside the
          // output dir, so it has to contain everything.
          // rootDirs merges ngp's output with the app folder for relative imports, output first:
          // files ngp doesn't emit (JSON, hand-written .d.ts) resolve from the app, as they would
          // in a build that compiled in memory.
          compilerOptions: {
            noEmit: true,
            types: [],
            rootDir: '/',
            rootDirs: [c.paths.ngpOut, t.workspace],
            paths: remappedPaths(t, c.paths.ngpOut),
          },
          files: [],
          include: [`${path.relative(out, c.paths.ngpOut)}/src/**/*.ts`],
        }),
      );
    }
  };
  const wipe = async () => {
    await fs.rm(out, {recursive: true, force: true});
    await fs.rm(diagFile, {force: true});
    for (const d of baseline.clean ?? []) await fs.rm(d, {recursive: true, force: true});
    await setupOut();
  };

  const result = {
    scenario: scenarioId,
    title: scenario.title,
    description: scenario.description,
    target: {name: t.name, label: t.label, kind: t.kind, components: t.components, sha256: t.manifest.sha256, sourceTs},
    baseline: {label: baseline.label},
    candidates: candidates.map((c) => ({id: c.id, label: c.label, engine: c.engine, steps: c.steps})),
  };
  console.log(`\n== ${scenarioId} ${t.name}`);

  // 1. Correctness gate
  await wipe();
  result.corpusIntactBefore = await verifyCorpus(t.workspace, t.manifest);
  if (!result.corpusIntactBefore) throw new Error(`${t.name} does not match its manifest; regenerate it`);

  const gb = timed([...baseline.args, ...baseline.gateArgs], baseline.env, baseline.cwd);
  let basePass = gb.exit === 0 && (await baseline.check());
  if (basePass && scenario.boot) basePass = boot(baseline.bootDir, t).pass;
  result.baseline.gate = {exit: gb.exit, pass: basePass};
  if (!basePass) result.baseline.gate.tail = tail(gb.output);

  for (const [i, c] of candidates.entries()) {
    const r = result.candidates[i];
    const g = timed(c.ngpArgs, {...c.env, NG_EXP_DEBUG_LOADER: '1'});
    const diagnostics = await fs
      .readFile(diagFile, 'utf8')
      .then((x) => JSON.parse(x).diagnostics.length)
      .catch(() => null);
    // ngp also copies hand-written .d.ts files through; those aren't outputs to count.
    const emitted = await countFiles(
      c.paths.ngpOut,
      (n) => n.endsWith('.ts') && !n.endsWith('.ngtypecheck.ts') && !n.endsWith('.d.ts'),
    );
    const tcbs = await countFiles(c.paths.ngpOut, (n) => n.endsWith('.ngtypecheck.ts'));
    const loaded = c.engine === 'sidecar' ? 'sidecar' : g.output.match(/loaded (native|wasm) from/)?.[1] ?? null;
    const steps = c.stepArgs.map((s) => ({name: s.name, ...timed(s.args)}));
    // A real app may not type-check under TypeScript 7 at all. Then tsgo on ngp's output passes
    // only if it reports exactly the errors tsgo reports on the app's own sources: ngp added none.
    for (const s of steps) {
      if (s.name !== 'tsgo' || s.exit === 0 || t.kind !== 'real') continue;
      const known = tsgoErrorsOnOriginal(t);
      if (known.length > 0 && JSON.stringify(errorCodes(s.output)) === JSON.stringify(known)) {
        s.exit = 0;
        s.knownErrors = known;
      }
    }
    const js = c.steps.includes('esbuild')
      ? await countFiles(c.paths.ngpOut, (n) => n.endsWith('.js'))
      : null;
    const optimize = c.ngpArgs.includes('--optimize');
    // Generated apps: exactly one output (and one type-check block) per source file. Real apps:
    // ngp skips type-only modules, so its count can sit below TypeScript's; what must hold is that
    // every follow-up step succeeds on what ngp wrote, including tsc/tsgo finding zero errors.
    const countsOk =
      t.kind === 'generated'
        ? emitted === sourceTs && (!optimize || tcbs === sourceTs) && (js === null || js === sourceTs)
        : emitted > 0 && (!optimize || tcbs > 0) && (js === null || js === emitted);
    let pass =
      g.exit === 0 &&
      diagnostics === 0 &&
      countsOk &&
      loaded === c.engine &&
      steps.every((s) => s.exit === 0);
    let booted = null;
    if (pass && scenario.boot) {
      booted = boot(c.paths.distOut, t);
      pass = booted.pass;
    }
    r.gate = {
      ngpExit: g.exit,
      diagnostics,
      ts: emitted,
      ngtypecheck: tcbs,
      engineLoaded: loaded,
      steps: Object.fromEntries(steps.map((s) => [s.name, s.exit])),
      knownTsgoErrors: steps.find((s) => s.knownErrors)?.knownErrors ?? null,
      js,
      boot: booted?.pass ?? null,
      pass,
    };
    if (!pass) r.gate.tail = tail(g.output + steps.map((s) => s.output).join('\n') + (booted?.output ?? ''));
    await fs.rm(diagFile, {force: true});
  }
  console.log(
    `gate: ${baseline.label} ${basePass ? 'pass' : 'FAIL'}; ` +
      result.candidates.map((r) => `${r.label} ${r.gate.pass ? 'pass' : 'FAIL'}`).join('; '),
  );

  const passing = candidates.filter((_, i) => result.candidates[i].gate.pass);
  if (basePass && passing.length > 0) {
    // 2. hyperfine
    const hfJson = path.join(runDir, 'hyperfine', `${scenarioId}-${t.name}.json`);
    const envPrefix = (e) =>
      Object.keys(e).length ? `env ${Object.entries(e).map(([k, v]) => `${k}=${q(v)}`).join(' ')} ` : '';
    const rm = (dirs) => `rm -rf ${[...dirs, diagFile].map(q).join(' ')}`;
    const hfArgs = ['--warmup', String(warmup), '--runs', String(runs), '--style', 'basic', '--export-json', hfJson];
    hfArgs.push(
      '--prepare', rm([path.join(out, 'baseline'), ...(baseline.clean ?? [])]),
      '--command-name', baseline.label,
      `${baseline.cwd ? `cd ${q(baseline.cwd)} && ` : ''}${envPrefix(baseline.env ?? {})}${[node, ...baseline.args].map(q).join(' ')}`,
    );
    for (const c of passing) {
      // A tsgo step that passed the gate with known app errors exits 1; let hyperfine time it.
      const tolerated = result.candidates.find((r) => r.id === c.id).gate.knownTsgoErrors;
      const chain = [
        `${envPrefix(c.env)}${[node, ...c.ngpArgs].map(q).join(' ')} >/dev/null`,
        ...c.stepArgs.map(
          (s) => `${[node, ...s.args].map(q).join(' ')} >/dev/null${s.name === 'tsgo' && tolerated ? ' || [ $? -eq 1 ]' : ''}`,
        ),
      ].join(' && ');
      hfArgs.push('--prepare', rm([c.dir]), '--command-name', c.label, chain);
    }
    execFileSync(hyperfineBin, hfArgs, {cwd: root, stdio: 'inherit'});
    const hf = JSON.parse(await fs.readFile(hfJson, 'utf8'));
    result.baseline.hyperfine = summarize(hf.results[0]);
    passing.forEach((c, i) => {
      result.candidates.find((r) => r.id === c.id).hyperfine = summarize(hf.results[i + 1]);
    });

    // 3. Phase runs, with peak RSS
    result.baseline.phaseRuns = [];
    for (const c of passing) result.candidates.find((r) => r.id === c.id).phaseRuns = [];
    for (let i = 0; i < phaseRuns; i++) {
      await wipe();
      const trace = path.join(out, `baseline-trace-${i}.json`);
      const b = baseline.cliPhases
        ? timed(baseline.args, {...baseline.env, NG_BUILD_DEBUG_PERF: '1'}, baseline.cwd)
        : timed([...baseline.args, ...baseline.traceArgs(trace)], baseline.env, baseline.cwd);
      result.baseline.phaseRuns.push({
        wallMs: b.ms,
        rss: b.rss,
        // tracePerformance reports microseconds; the CLI prints seconds.
        phasesMs: baseline.cliPhases ? cliPhases(b.output) : msPhases(JSON.parse(await fs.readFile(trace, 'utf8'))),
      });
      for (const c of passing) {
        const timingsFile = path.join(out, `${c.id}-phases-${i}.json`);
        const n = timed(c.ngpArgs, {...c.env, NGP_PHASE_TIMINGS: timingsFile});
        const steps = c.stepArgs.map((s) => ({name: s.name, ...timed(s.args)}));
        result.candidates.find((r) => r.id === c.id).phaseRuns.push({
          wallMs: n.ms + steps.reduce((sum, s) => sum + s.ms, 0),
          rss: Math.max(n.rss, ...steps.map((s) => s.rss)),
          ngpWallMs: n.ms,
          ngpRss: n.rss,
          stepsMs: Object.fromEntries(steps.map((s) => [s.name, s.ms])),
          stepsRss: Object.fromEntries(steps.map((s) => [s.name, s.rss])),
          phasesMs: JSON.parse(await fs.readFile(timingsFile, 'utf8')),
        });
        await fs.rm(diagFile, {force: true});
      }
    }
  }

  await fs.rm(out, {recursive: true, force: true});
  await fs.rm(diagFile, {force: true});
  for (const d of baseline.clean ?? []) await fs.rm(d, {recursive: true, force: true});
  result.corpusIntactAfter = await verifyCorpus(t.workspace, t.manifest);
  await fs.writeFile(path.join(runDir, `${scenarioId}-${t.name}.json`), JSON.stringify(result, null, 2) + '\n');
  if (!result.corpusIntactAfter) throw new Error(`${t.name} changed during the benchmark; results are invalid`);
}

/** Source .ts files ngp should emit one output for: everything the app tsconfig includes. */
async function countSourceTs(t) {
  if (t.kind === 'generated') return countFiles(path.join(t.workspace, 'src'), (n) => n.endsWith('.ts'));
  return t.manifest.sourceTs;
}

function boot(dir, t) {
  const r = timed(['harness/boot-check.mjs', dir, ...(t.features ? ['--features', String(t.features)] : [])]);
  return {pass: r.exit === 0, output: r.output};
}

/** R: cold `ng build` in development and production, with the CLI's phase timings. */
async function runReference(scenarioId, scenario, t) {
  const out = path.join(benchOut, `${scenarioId}-${t.name}`);
  const configs = ['development', 'production'];
  const buildArgs = (config) => [
    t.ngBin, 'build', '--configuration', config, '--output-path', path.join(out, config), '--no-progress',
  ];
  const ngEnv = {NG_CLI_ANALYTICS: 'false'};
  const cacheDir = path.join(t.workspace, '.angular');
  const wipe = async () => {
    await fs.rm(out, {recursive: true, force: true});
    await fs.rm(cacheDir, {recursive: true, force: true});
  };
  const result = {
    scenario: scenarioId,
    title: scenario.title,
    reference: true,
    target: {name: t.name, label: t.label, kind: t.kind, components: t.components, sha256: t.manifest.sha256},
    gate: {},
  };
  console.log(`\n== ${scenarioId} ${t.name}`);

  await wipe();
  result.corpusIntactBefore = await verifyCorpus(t.workspace, t.manifest);
  if (!result.corpusIntactBefore) throw new Error(`${t.name} does not match its manifest; regenerate it`);
  for (const config of configs) {
    const g = timed(buildArgs(config), ngEnv, t.workspace);
    const js = await countFiles(path.join(out, config), (n) => n.endsWith('.js'));
    result.gate[config] = {exit: g.exit, js, pass: g.exit === 0 && js > 0};
    if (!result.gate[config].pass) result.gate[config].tail = tail(g.output, 8);
  }
  console.log(`gate: ${configs.map((c) => `${c} ${result.gate[c].pass ? 'pass' : 'FAIL'}`).join(', ')}`);

  if (configs.every((c) => result.gate[c].pass)) {
    const hfJson = path.join(runDir, 'hyperfine', `${scenarioId}-${t.name}.json`);
    const hfArgs = ['--warmup', String(warmup), '--runs', String(runs), '--style', 'basic', '--export-json', hfJson];
    for (const config of configs) {
      hfArgs.push(
        '--prepare', `rm -rf ${q(path.join(out, config))} ${q(cacheDir)}`,
        '--command-name', `ng build ${config}`,
        `cd ${q(t.workspace)} && ${[node, ...buildArgs(config)].map(q).join(' ')}`,
      );
    }
    execFileSync(hyperfineBin, hfArgs, {cwd: root, env: {...process.env, ...ngEnv}, stdio: 'inherit'});
    const hf = JSON.parse(await fs.readFile(hfJson, 'utf8'));
    result.hyperfine = {development: summarize(hf.results[0]), production: summarize(hf.results[1])};

    // NG_BUILD_DEBUG_PERF=1 makes the CLI print DURATION[<phase>]: <seconds> lines.
    // Phases marked * add up concurrent requests and can exceed wall time.
    result.phaseRuns = {development: [], production: []};
    for (let i = 0; i < phaseRuns; i++) {
      for (const config of configs) {
        await wipe();
        const r = timed(buildArgs(config), {...ngEnv, NG_BUILD_DEBUG_PERF: '1'}, t.workspace);
        result.phaseRuns[config].push({wallMs: r.ms, rss: r.rss, phasesMs: cliPhases(r.output)});
      }
    }
  }

  await wipe();
  result.corpusIntactAfter = await verifyCorpus(t.workspace, t.manifest);
  await fs.writeFile(path.join(runDir, `${scenarioId}-${t.name}.json`), JSON.stringify(result, null, 2) + '\n');
  if (!result.corpusIntactAfter) throw new Error(`${t.name} changed during the benchmark; results are invalid`);
}

/** S6: one process per compiler, edits applied and reverted in-process; see harness/incremental.mjs. */
async function runIncremental(scenarioId, scenario, t) {
  const out = path.join(benchOut, `${scenarioId}-${t.name}`);
  const resultFile = path.join(runDir, `${scenarioId}-${t.name}.json`);
  console.log(`\n== ${scenarioId} ${t.name}`);
  const before = await verifyCorpus(t.workspace, t.manifest);
  if (!before) throw new Error(`${t.name} does not match its manifest; regenerate it`);
  await fs.rm(out, {recursive: true, force: true});
  const {env: eEnv} = engineEnv(engine);
  const r = timed(
    [
      'harness/incremental.mjs', '--workspace', t.workspace, '--tsconfig', t.tsconfigApp,
      '--out', out, '--rounds', String(runs), '--warmup', String(warmup), '--result', resultFile,
      '--engine', engine, '--title', scenario.title, '--label', t.label,
    ],
    eEnv,
  );
  if (r.exit !== 0) {
    await fs.writeFile(
      resultFile,
      JSON.stringify({scenario: scenarioId, title: scenario.title, incremental: true, target: {name: t.name, label: t.label}, failed: tail(r.output, 10)}, null, 2) + '\n',
    );
    console.log(`S6 failed:\n${tail(r.output, 10).join('\n')}`);
  }
  await fs.rm(out, {recursive: true, force: true});
  const after = await verifyCorpus(t.workspace, t.manifest);
  if (!after) throw new Error(`${t.name} changed during the benchmark; results are invalid`);
}

for (const scenarioId of scenarios) {
  const scenario = SCENARIOS[scenarioId];
  for (const item of targets) {
    const t = await resolveTarget(item);
    // S6 picks its edits from a generated app's layout, and S7's boot check looks for a generated
    // app's markup; neither knows a real app's structure yet.
    if (t.kind === 'real' && (scenario.incremental || scenario.boot)) {
      console.log(`\n== ${scenarioId} ${t.name}: skipped, this scenario supports generated apps only`);
      continue;
    }
    if (scenario.reference && !existsSync(path.join(t.workspace, 'angular.json'))) {
      console.log(`\n== ${scenarioId} ${t.name}: skipped, not an Angular CLI workspace (no angular.json)`);
      continue;
    }
    if (scenario.reference) await runReference(scenarioId, scenario, t);
    else if (scenario.incremental) await runIncremental(scenarioId, scenario, t);
    else await runPair(scenarioId, scenario, t);
  }
}

execFileSync(node, [path.join(root, 'harness/report.mjs'), runDir], {stdio: 'inherit'});
