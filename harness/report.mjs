// Turns one run directory (results/runs/<id>), or several merged with --merge, into report.md.
//
// Usage: node harness/report.mjs <run-dir>
//        node harness/report.mjs --merge <out-dir> <run-dir> <run-dir> ...
//
// Merging is for CI, where each scenario runs on its own runner: the merged report keeps each
// scenario's own environment, because GitHub assigns a different CPU to every runner.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {median} from './lib/stats.mjs';

const argv = process.argv.slice(2);
let runDirs;
let outDir;
if (argv[0] === '--merge') {
  outDir = path.resolve(argv[1]);
  runDirs = argv.slice(2).map((d) => path.resolve(d));
} else {
  outDir = path.resolve(argv[0]);
  runDirs = [outDir];
}

// Load every run and its results, in a stable scenario order.
const ORDER = ['S1', 'S2', 'S3', 'S5', 'S6', 'S7', 'R'];
const sections = [];
for (const dir of runDirs) {
  const run = JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8'));
  for (const s of run.scenarios) {
    const results = [];
    for (const t of run.targets ?? run.sizes) {
      const name = /^\d+$/.test(String(t)) ? `standalone-${t}-s1` : String(t).replace(/^real:/, '');
      const r = await fs.readFile(path.join(dir, `${s}-${name}.json`), 'utf8').then(JSON.parse).catch(() => null);
      if (r) results.push(r);
    }
    if (results.length) sections.push({scenario: s, run, results});
  }
}
sections.sort((a, b) => ORDER.indexOf(a.scenario) - ORDER.indexOf(b.scenario));

const sec = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`);
const msf = (ms) => (Number.isFinite(ms) ? Math.round(ms).toLocaleString('en-US') : '–');
const mb = (bytes) => `${Math.round(bytes / 2 ** 20).toLocaleString('en-US')} MB`;
const med = (arr, f) => median(arr.map(f));
const pct = (part, whole) => `${Math.round((100 * part) / whole)}%`;
const noisy = (x) => (x?.noisy ? ' ⚠' : '');

const lines = [];
const out = (s = '') => lines.push(s);

function envLine(run) {
  const env = run.environment;
  const ci = env.ci
    ? ` GitHub Actions run [${env.ci.runId}](https://github.com/${env.ci.repository}/actions/runs/${env.ci.runId}), commit \`${env.ci.sha?.slice(0, 7)}\`, image ${env.ci.runnerImage ?? 'unknown'}.`
    : '';
  return (
    `${env.machine.cpuModel}, ${env.machine.cores} cores, ${env.machine.memoryGb} GB, ${env.machine.os}. ` +
    `Node ${env.versions.node}, Angular \`${env.versions.angularSha?.slice(0, 7)}\`, compiler-cli ${env.versions.compilerCli}, ` +
    `TypeScript ${env.versions.typescript}, esbuild ${env.versions.esbuild}. ` +
    `${run.warmup} warm-up and ${run.runs} measured runs, ${run.phaseRuns} phase run${run.phaseRuns === 1 ? '' : 's'}, ` +
    `${run.heapMb ?? 'default'} MB heap limit per Node process.${ci}` +
    (env.warnings.length ? ` Warnings: ${env.warnings.join('; ')}.` : '')
  );
}

const first = sections[0]?.run;
out(`# Benchmark report`);
out();
out(
  sections.length && runDirs.length === 1
    ? envLine(first)
    : 'Each scenario ran on its own CI runner; its section names the machine. Compare ratios within a section, not seconds across sections.',
);

const NGC_PHASES = [
  ['TypeScriptProgramCreate', 'Program create'],
  ['Analysis', 'Analysis'],
  ['Resolve', 'Resolve'],
  ['TcbGeneration', 'TCB generation'],
  ['TcbUpdateProgram', 'TCB program update'],
  ['TypeScriptDiagnostics', 'TS diagnostics'],
  ['TtcDiagnostics', 'Template diagnostics'],
  ['Compile', 'Compile'],
  ['TypeScriptEmit', 'TS emit'],
];
const CLI_PHASES = [
  ['NG_CREATE_PROGRAM', 'Program create'],
  ['NG_ANALYZE_PROGRAM', 'Analysis'],
  ['NG_FIND_AFFECTED', 'Find affected'],
  ['NG_EMIT_TS', 'TS emit'],
  ['NG_DIAGNOSTICS_TOTAL', 'Diagnostics'],
];

function renderPair(section) {
  const {scenario, results, run} = section;
  const first = results[0];
  out();
  out(`## ${scenario}: ${first.title}`);
  out();
  if (runDirs.length > 1) {
    out(`_Machine: ${envLine(run)}_`);
    out();
  }
  out(first.description);
  out();
  out('| Target | Pipeline | Median | p95 | vs baseline | CPU (cores used) | Peak RSS |');
  out('|---|---|---:|---:|---:|---:|---:|');
  for (const r of results) {
    const b = r.baseline;
    const bRow = b.hyperfine
      ? `${sec(b.hyperfine.medianMs)}${noisy(b.hyperfine)} | ${sec(b.hyperfine.p95Ms)} | – | ${sec(b.hyperfine.cpuMs)} (${b.hyperfine.parallelism.toFixed(1)}) | ${mb(med(b.phaseRuns, (p) => p.rss))}`
      : `${b.gate?.pass ? 'not timed' : `gate failed (exit ${b.gate?.exit})`} | | | |`;
    out(`| ${r.target.label} | ${b.label} | ${bRow} |`);
    for (const c of r.candidates) {
      if (!c.hyperfine) {
        const g = c.gate ?? {};
        const why = g.pass
          ? 'not timed (baseline failed)'
          : `gate failed: ngp exit ${g.ngpExit}, ${g.diagnostics ?? '?'} diagnostics, ${g.ts}/${r.target.sourceTs} files, ` +
            `engine ${g.engineLoaded}, steps ${JSON.stringify(g.steps)}${g.boot === false ? ', boot failed' : ''}`;
        out(`| | ${c.label} | ${why} | | | | |`);
        continue;
      }
      const ratio = b.hyperfine ? `**${(b.hyperfine.medianMs / c.hyperfine.medianMs).toFixed(2)}×**` : '–';
      const known = c.gate?.knownTsgoErrors;
      if (known) c.label += ` ¹`;
      out(
        `| | ${c.label} | ${sec(c.hyperfine.medianMs)}${noisy(c.hyperfine)} | ${sec(c.hyperfine.p95Ms)} | ${ratio} | ` +
          `${sec(c.hyperfine.cpuMs)} (${c.hyperfine.parallelism.toFixed(1)}) | ${mb(med(c.phaseRuns, (p) => p.rss))} |`,
      );
    }
  }
  out();
  out('"vs baseline" is the baseline median divided by the candidate median: above 1× means ngp\'s pipeline is faster.');
  for (const r of results) {
    const known = r.candidates.find((c) => c.gate?.knownTsgoErrors)?.gate.knownTsgoErrors;
    if (known) {
      out(
        `\n¹ ${r.target.label} doesn't type-check under TypeScript 7 on its own sources: \`tsgo\` reports ${known.length} error${known.length === 1 ? '' : 's'} ` +
          `(${[...new Set(known)].join(', ')}) before ngp is involved. ngp's output passed because \`tsgo\` reported exactly those errors and no others.`,
      );
    }
  }

  // ngp phases, one table per scenario.
  const timed = results.flatMap((r) => r.candidates.filter((c) => c.phaseRuns?.length).map((c) => ({r, c})));
  if (timed.length) {
    const stepNames = [...new Set(timed.flatMap(({c}) => c.steps))];
    out();
    out(`### Where ngp's time goes (median ms)`);
    out();
    out(`| Target | Pipeline | Node start + load | Setup | Waiting on analyzer | prepareChunk | Process files | Diagnostics writes | ${stepNames.join(' | ')} | Total |`);
    out(`|---|---|${'---:|'.repeat(6 + stepNames.length + 1)}`);
    for (const {r, c} of timed) {
      const p = (k) => msf(med(c.phaseRuns, (x) => x.phasesMs[k]));
      const steps = stepNames.map((s) => (c.steps.includes(s) ? msf(med(c.phaseRuns, (x) => x.stepsMs[s])) : '–'));
      out(
        `| ${r.target.label} | ${c.label} | ${p('mainStart')} | ${p('setup')} | ${p('analyzerWait')} | ${p('prepareChunk')} | ` +
          `${p('processFiles')} | ${p('writeDiagnostics')} | ${steps.join(' | ')} | ${msf(med(c.phaseRuns, (x) => x.wallMs))} |`,
      );
    }
  }

  // Baseline phases.
  const based = results.filter((r) => r.baseline.phaseRuns?.length);
  if (based.length) {
    const cli = Object.keys(based[0].baseline.phaseRuns[0].phasesMs).some((k) => k.startsWith('NG_'));
    const known = cli ? CLI_PHASES : NGC_PHASES;
    const present = known.filter(([k]) => based.some((r) => med(r.baseline.phaseRuns, (x) => x.phasesMs[k] ?? 0) > 0));
    out();
    out(`### Where ${based[0].baseline.label}'s time goes (median ms, ${cli ? 'CLI `NG_BUILD_DEBUG_PERF`' : '`tracePerformance`'})`);
    out();
    out(`| Target | ${present.map(([, l]) => l).join(' | ')} | Total |`);
    out(`|---|${'---:|'.repeat(present.length + 1)}`);
    for (const r of based) {
      const vals = present.map(([k]) => msf(med(r.baseline.phaseRuns, (x) => x.phasesMs[k] ?? 0)));
      out(`| ${r.target.label} | ${vals.join(' | ')} | ${msf(med(r.baseline.phaseRuns, (x) => x.wallMs))} |`);
    }
    if (cli) out('\nThe CLI bundles while it compiles, so its phases overlap and don\'t add up to the total.');
  }
}

function renderReference(section) {
  const {scenario, results, run} = section;
  out();
  out(`## ${scenario}: Full \`ng build\` (reference, not a comparison)`);
  out();
  if (runDirs.length > 1) {
    out(`_Machine: ${envLine(run)}_`);
    out();
  }
  out(
    'ngp isn\'t part of the Angular CLI yet, so `ng build` can\'t use it, and this section has no ngp column. ' +
      'It times a normal Angular CLI build of the same apps, cold, with the CLI cache cleared before every run. ' +
      'It answers one question: how much of a real build is the compiler step that S1 and S2 measure?',
  );
  out();
  out('The breakdown comes from the CLI\'s own timings (`NG_BUILD_DEBUG_PERF=1`):');
  out();
  out('- **Angular compilation**: creating the TypeScript program, analyzing Angular decorators, finding affected files and emitting TypeScript. This is the work ngp replaces, and what S1 and S2 time.');
  out('- **Type-check**: template and TypeScript diagnostics. With ngp, this moves to a separate TypeScript run over ngp\'s type-check blocks (S3 and S4).');
  out('- **Optimization**: minifying and tree-shaking chunks, production only. ngp doesn\'t change it.');
  out();
  out('The CLI bundles while it compiles, so the phases overlap. Each percentage is that phase\'s time relative to the whole build; they don\'t add up to 100%.');
  out();
  out('| Target | `ng build` development | Angular compilation | Type-check | `ng build` production | Optimization | Peak memory, dev / prod |');
  out('|---|---:|---:|---:|---:|---:|---:|');
  const compileKeys = ['NG_CREATE_PROGRAM', 'NG_ANALYZE_PROGRAM', 'NG_FIND_AFFECTED', 'NG_EMIT_TS'];
  for (const r of results) {
    const label = r.target?.label ?? r.corpus?.components?.toLocaleString('en-US');
    if (!r.hyperfine) {
      const failed = Object.entries(r.gate).filter(([, g]) => !g.pass).map(([c, g]) => `${c} build failed (exit ${g.exit})`);
      out(`| ${label} | ${failed.join('; ')} | | | | | |`);
      continue;
    }
    const dev = r.phaseRuns.development;
    const prod = r.phaseRuns.production;
    const devWall = med(dev, (x) => x.wallMs);
    const prodWall = med(prod, (x) => x.wallMs);
    const compile = med(dev, (x) => compileKeys.reduce((sum, k) => sum + (x.phasesMs[k] ?? 0), 0));
    const typecheck = med(dev, (x) => x.phasesMs['NG_DIAGNOSTICS_TOTAL'] ?? 0);
    const optimize = med(prod, (x) => x.phasesMs['OPTIMIZE_CHUNKS'] ?? 0);
    out(
      `| ${label} | ${sec(r.hyperfine.development.medianMs)}${noisy(r.hyperfine.development)} | ` +
        `${sec(compile)} (${pct(compile, devWall)}) | ${sec(typecheck)} (${pct(typecheck, devWall)}) | ` +
        `${sec(r.hyperfine.production.medianMs)}${noisy(r.hyperfine.production)} | ${sec(optimize)} (${pct(optimize, prodWall)}) | ` +
        `${mb(med(dev, (x) => x.rss))} / ${mb(med(prod, (x) => x.rss))} |`,
    );
  }
  out();
  out('Build times are hyperfine medians. Phase times and percentages come from the separate instrumented runs.');
}

function renderIncremental(section) {
  const {scenario, results, run} = section;
  out();
  out(`## ${scenario}: Rebuild after one edit`);
  out();
  if (runDirs.length > 1) {
    out(`_Machine: ${envLine(run)}_`);
    out();
  }
  out(
    'How long each compiler takes to bring its output up to date after you change one file, as in watch mode. ' +
      'Both compilers stay in one process. ngc gets a new `NgtscProgram` that reuses the previous one, the way the ' +
      'Angular CLI rebuilds; ngp feeds the change to its analyzer with `updateFileContent` and regenerates the files ' +
      '`analyzeOptimizedDelta` reports. Each edit is applied and then reverted; only the edit is timed. ' +
      'Both sides write their output, and ngp\'s is transformed to JavaScript with esbuild, so the job matches S2.',
  );
  out();
  out('| Target | Edit | ngc rebuild | ngp rebuild | ngc ÷ ngp | Files ngc re-emitted | Files ngp regenerated | Output matches a fresh build |');
  out('|---|---|---:|---:|---:|---:|---:|---|');
  for (const r of results) {
    if (r.failed) {
      out(`| ${r.target.label} | failed: ${r.failed.at(-1)} | | | | | | |`);
      continue;
    }
    out(`| ${r.target.label} | initial build | ${sec(r.initial.ngc.medianMs)} | ${sec(r.initial.ngp.medianMs)} | ${(r.initial.ngc.medianMs / r.initial.ngp.medianMs).toFixed(2)}× | ${r.initial.ngc.files} | ${r.initial.ngp.files} | |`);
    for (const e of r.edits) {
      out(
        `| | ${e.label} | ${sec(e.ngc.medianMs)} | ${sec(e.ngp.medianMs)} | **${(e.ngc.medianMs / e.ngp.medianMs).toFixed(2)}×** | ${e.ngc.files} | ${e.ngp.files} | ` +
          `ngc ${e.ngc.matchesFreshBuild ? 'yes' : '**no**'}, ngp ${e.ngp.matchesFreshBuild ? 'yes' : '**no**'} |`,
      );
    }
  }
  out();
  out(
    'Medians of the timed rounds. The initial build is the first, cold compile in that process. ' +
      'ngc saves its incremental state only after template type-checking; S6 rebuilds without type-checking, ' +
      'so the harness saves it after emit, which gives ngc its best case. Without that, every ngc rebuild is a full compile.',
  );
}

for (const section of sections) {
  const r = section.results[0];
  if (r.reference) renderReference(section);
  else if (r.incremental) renderIncremental(section);
  else renderPair(section);
}

out();
out('## How to read this');
out();
out('- Medians and p95 come from hyperfine. ⚠ marks a command whose median absolute deviation is above 5% of its median.');
out('- "Cores used" is CPU time divided by wall time. The native engine runs on every core; the TypeScript backend, ngc and tsc run on one thread plus Node\'s helper threads; tsgo is multithreaded.');
out('- ngp pipelines are several processes in a row, so they pay Node startup more than once. A CLI integration would run them in one process.');
out('- Phase tables come from separate runs with instrumentation on; their totals are wall time including process startup.');
out('- "Waiting on analyzer" is time the TypeScript backend spent blocked on the Rust analyzer, not the analyzer\'s CPU time.');
out('- GitHub assigns a different CPU to every runner. Compare ratios within a section, not seconds across sections.');

await fs.mkdir(outDir, {recursive: true});
await fs.writeFile(path.join(outDir, 'report.md'), lines.join('\n') + '\n');
console.log(`\nreport: ${path.relative(process.cwd(), path.join(outDir, 'report.md'))}`);
