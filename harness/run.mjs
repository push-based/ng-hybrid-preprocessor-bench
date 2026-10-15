// Benchmark runner for the transform-only scenarios.
//
//   S1  local mode   baseline: ngc-transform --mode local       candidate: ngp, then esbuild
//   S2  optimize     baseline: ngc-transform --mode full        candidate: ngp --optimize, then esbuild
//
// For every scenario and corpus size it does three things, in this order:
//   1. Correctness gate (untimed). Baseline emits one .js per source .ts with zero diagnostics;
//      ngp exits 0 with zero diagnostics and one output per input, and esbuild turns each into .js;
//      the loader confirms which engine actually loaded. A failed gate is recorded and skips timing.
//   2. hyperfine: warm-up runs, then measured runs of both commands, output dirs wiped before each.
//   3. Phase runs under /usr/bin/time: ngc's tracePerformance phases, ngp's NGP_PHASE_TIMINGS
//      phases, the esbuild step on its own, and peak RSS of every process.
//
// Usage: node harness/run.mjs [--scenario S1,S2] [--size 100,1000,5000] [--engine native]
//          [--runs 10] [--warmup 2] [--phase-runs 3] [--seed 1]
// Writes results/runs/<run-id>/ and then the report (harness/report.mjs).
//
// Generated apps are read from CORPUS_DIR (default: corpus/generated).
// Compiler output goes to BENCH_OUT_DIR (default: the OS temp directory), never into the project:
// IDEs and Spotlight react to thousands of new files there and add noise to the timings.

import {execFileSync, spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {verifyCorpus} from './lib/corpus.mjs';
import {captureEnvironment} from './lib/environment.mjs';
import {engineEnv, hyperfineBin, ngpMain, root} from './lib/paths.mjs';
import {summarize} from './lib/stats.mjs';

const {values: args} = parseArgs({
  options: {
    scenario: {type: 'string', default: 'S1,S2'},
    size: {type: 'string', default: '100,1000,5000'},
    engine: {type: 'string', default: 'native'},
    runs: {type: 'string', default: '10'},
    warmup: {type: 'string', default: '2'},
    'phase-runs': {type: 'string', default: '3'},
    seed: {type: 'string', default: '1'},
  },
});

const SCENARIOS = {
  S1: {title: 'Transform only, local mode', ngcMode: 'local', ngpArgs: []},
  S2: {title: 'Transform with cross-file optimization', ngcMode: 'full', ngpArgs: ['--optimize']},
};
const scenarios = args.scenario.split(',').map((s) => s.trim());
for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s}`);
const sizes = args.size.split(',').map((s) => Number(s.trim()));
const engine = args.engine;
const runs = Number(args.runs);
// Real paths only: when ngp's input path runs through a symlink (macOS's /var -> /private/var),
// `ngp --out` computes output paths relative to the wrong root and overwrites the sources.
const corpusDir = await fs.realpath(
  path.resolve(process.env['CORPUS_DIR'] ?? path.join(root, 'corpus/generated')),
);
const benchOutRequested = path.resolve(
  process.env['BENCH_OUT_DIR'] ?? path.join(os.tmpdir(), 'ng-hybrid-preprocessor-bench'),
);
await fs.mkdir(benchOutRequested, {recursive: true});
const benchOut = await fs.realpath(benchOutRequested);
const warmup = Number(args.warmup);
const phaseRuns = Number(args['phase-runs']);

const env = await captureEnvironment();
const runId = `${env.date.replace(/[:.]/g, '-').slice(0, 19)}-${env.hostTag}`;
const runDir = path.join(root, 'results/runs', runId);
await fs.mkdir(path.join(runDir, 'hyperfine'), {recursive: true});
await fs.writeFile(
  path.join(runDir, 'run.json'),
  JSON.stringify({runId, scenarios, sizes, engine, runs, warmup, phaseRuns, environment: env}, null, 2) + '\n',
);
console.log(`run ${runId}: ${scenarios.join(', ')} x ${sizes.join(', ')}, engine ${engine}, ${runs} runs`);
if (env.warnings.length) console.log(env.warnings.map((w) => `  warning: ${w}`).join('\n'));

const {env: ngpEnv, extraArgs: ngpExtraArgs} = engineEnv(engine);
const node = process.execPath;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function countFiles(dir, pred) {
  const entries = await fs.readdir(dir, {recursive: true, withFileTypes: true}).catch(() => []);
  return entries.filter((e) => e.isFile() && pred(e.name)).length;
}

/** Runs a node script under /usr/bin/time; returns wall ms, peak RSS bytes and output. */
function timed(scriptArgs, extraEnv = {}) {
  const timeFlag = process.platform === 'darwin' ? '-l' : '-v';
  const start = process.hrtime.bigint();
  const res = spawnSync('/usr/bin/time', [timeFlag, node, ...scriptArgs], {
    cwd: root,
    env: {...process.env, ...extraEnv},
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const stderr = res.stderr ?? '';
  const rss =
    process.platform === 'darwin'
      ? Number(stderr.match(/(\d+)\s+maximum resident set size/)?.[1] ?? NaN)
      : Number(stderr.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1] ?? NaN) * 1024;
  return {exit: res.status, ms, rss, output: (res.stdout ?? '') + stderr};
}

for (const scenarioId of scenarios) {
  const scenario = SCENARIOS[scenarioId];
  for (const size of sizes) {
    const name = `standalone-${size}-s${args.seed}`;
    const workspace = path.join(corpusDir, name);
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'manifest.json'), 'utf8'));
    const out = path.join(benchOut, `${scenarioId}-${size}`);
    const baseOut = path.join(out, 'baseline');
    const candOut = path.join(out, 'candidate');
    const diagFile = path.join(workspace, 'tsconfig.app.ngdiag.json');
    const tsconfigApp = path.join(workspace, 'tsconfig.app.json');
    const tsconfigRoot = path.join(workspace, 'tsconfig.json');
    const sourceTs = await countFiles(path.join(workspace, 'src'), (n) => n.endsWith('.ts'));

    const baselineArgs = (extra = []) => [
      'harness/ngc-transform.mjs', tsconfigApp, '--mode', scenario.ngcMode, '--out', baseOut, ...extra,
    ];
    const ngpArgs = [ngpMain, workspace, ...scenario.ngpArgs, '--out', candOut, ...ngpExtraArgs];
    const esbuildArgs = ['harness/esbuild-transform.mjs', candOut, '--tsconfig', tsconfigRoot];

    const result = {
      scenario: scenarioId,
      title: scenario.title,
      corpus: {name, components: manifest.components, sha256: manifest.sha256, sourceTs},
      engine,
      gate: {},
    };
    const wipe = async () => {
      await fs.rm(out, {recursive: true, force: true});
      await fs.rm(diagFile, {force: true});
    };
    console.log(`\n== ${scenarioId} ${name}`);

    // 1. Correctness gate
    await wipe();
    result.corpusIntactBefore = await verifyCorpus(workspace, manifest);
    if (!result.corpusIntactBefore) throw new Error(`${name} does not match its manifest; regenerate it`);
    const gBase = timed(baselineArgs(['--diagnostics']));
    const baseJs = await countFiles(baseOut, (n) => n.endsWith('.js'));
    const gNgp = timed(ngpArgs, {...ngpEnv, NG_EXP_DEBUG_LOADER: '1'});
    const diagnostics = await fs
      .readFile(diagFile, 'utf8')
      .then((t) => JSON.parse(t).diagnostics.length)
      .catch(() => null);
    const candTs = await countFiles(candOut, (n) => n.endsWith('.ts') && !n.endsWith('.ngtypecheck.ts'));
    const gEsb = timed(esbuildArgs);
    const candJs = await countFiles(candOut, (n) => n.endsWith('.js'));
    const loaded =
      engine === 'sidecar' ? 'sidecar' : gNgp.output.match(/loaded (native|wasm) from/)?.[1] ?? null;
    result.gate = {
      baseline: {exit: gBase.exit, js: baseJs, pass: gBase.exit === 0 && baseJs === sourceTs},
      candidate: {
        ngpExit: gNgp.exit,
        diagnostics,
        ts: candTs,
        esbuildExit: gEsb.exit,
        js: candJs,
        engineLoaded: loaded,
        pass:
          gNgp.exit === 0 && diagnostics === 0 && candTs === sourceTs && gEsb.exit === 0 &&
          candJs === sourceTs && loaded === engine,
      },
    };
    if (!result.gate.baseline.pass) result.gate.baseline.tail = gBase.output.trim().split('\n').slice(-5);
    if (!result.gate.candidate.pass) result.gate.candidate.tail = (gNgp.output + gEsb.output).trim().split('\n').slice(-5);
    const gatePass = result.gate.baseline.pass && result.gate.candidate.pass;
    console.log(
      `gate: baseline ${result.gate.baseline.pass ? 'pass' : 'FAIL'} (${baseJs}/${sourceTs} js), ` +
        `candidate ${result.gate.candidate.pass ? 'pass' : 'FAIL'} (${candTs}/${sourceTs} ts, ${candJs}/${sourceTs} js, ` +
        `${diagnostics} diagnostics, engine ${loaded})`,
    );

    if (gatePass) {
      // 2. hyperfine
      const hfJson = path.join(runDir, 'hyperfine', `${scenarioId}-${size}.json`);
      const rmCmd = (dir) => `rm -rf ${q(dir)} ${q(diagFile)}`;
      const baselineCmd = [node, ...baselineArgs()].map(q).join(' ');
      const candidateCmd = `${[node, ...ngpArgs].map(q).join(' ')} >/dev/null && ${[node, ...esbuildArgs].map(q).join(' ')}`;
      execFileSync(
        hyperfineBin,
        [
          '--warmup', String(warmup),
          '--runs', String(runs),
          '--style', 'basic',
          '--export-json', hfJson,
          '--prepare', rmCmd(baseOut),
          '--command-name', 'ngc',
          baselineCmd,
          '--prepare', rmCmd(candOut),
          '--command-name', `ngp-${engine}`,
          candidateCmd,
        ],
        {cwd: root, env: {...process.env, ...ngpEnv}, stdio: 'inherit'},
      );
      const hf = JSON.parse(await fs.readFile(hfJson, 'utf8'));
      result.hyperfine = {
        baseline: summarize(hf.results[0]),
        candidate: summarize(hf.results[1]),
      };

      // 3. Phase runs, with peak RSS
      const phases = {baseline: [], candidate: []};
      for (let i = 0; i < phaseRuns; i++) {
        await wipe();
        const trace = path.join(out, `ngc-trace-${i}.json`);
        await fs.mkdir(out, {recursive: true});
        const b = timed(baselineArgs(['--trace', trace]));
        const perf = JSON.parse(await fs.readFile(trace, 'utf8'));
        phases.baseline.push({
          wallMs: b.ms,
          rss: b.rss,
          // tracePerformance reports microseconds.
          phasesMs: Object.fromEntries(Object.entries(perf.phases).map(([k, v]) => [k, v / 1000])),
        });

        const timingsFile = path.join(out, `ngp-phases-${i}.json`);
        const n = timed(ngpArgs, {...ngpEnv, NGP_PHASE_TIMINGS: timingsFile});
        const e = timed(esbuildArgs);
        const ngpPhases = JSON.parse(await fs.readFile(timingsFile, 'utf8'));
        phases.candidate.push({
          wallMs: n.ms + e.ms,
          rss: Math.max(n.rss, e.rss),
          ngpWallMs: n.ms,
          esbuildWallMs: e.ms,
          ngpRss: n.rss,
          esbuildRss: e.rss,
          phasesMs: ngpPhases,
        });
      }
      result.phaseRuns = phases;
    }

    await wipe();
    result.corpusIntactAfter = await verifyCorpus(workspace, manifest);
    await fs.writeFile(path.join(runDir, `${scenarioId}-${size}.json`), JSON.stringify(result, null, 2) + '\n');
    if (!result.corpusIntactAfter) throw new Error(`${name} changed during the benchmark; results are invalid`);
  }
}

execFileSync(node, [path.join(root, 'harness/report.mjs'), runDir], {stdio: 'inherit'});
