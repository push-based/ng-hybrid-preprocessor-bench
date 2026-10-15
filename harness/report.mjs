// Turns one run directory (results/runs/<id>) into report.md.
//
// Usage: node harness/report.mjs <run-dir>

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {median} from './lib/stats.mjs';

const runDir = path.resolve(process.argv[2]);
const run = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
const env = run.environment;

const results = [];
for (const s of run.scenarios) {
  for (const size of run.sizes) {
    const file = path.join(runDir, `${s}-${size}.json`);
    const r = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (r) results.push(r);
  }
}

const sec = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`);
const msf = (ms) => `${Math.round(ms).toLocaleString('en-US')}`;
const mb = (bytes) => `${Math.round(bytes / 2 ** 20).toLocaleString('en-US')} MB`;
const num = (n) => n.toLocaleString('en-US');
const med = (arr, f) => median(arr.map(f));

const lines = [];
const out = (s = '') => lines.push(s);

out(`# Run ${run.runId}`);
out();
out(
  `${env.machine.cpuModel}, ${env.machine.cores} cores, ${env.machine.memoryGb} GB, ` +
    `${env.machine.os} (${env.machine.osVersion}), power: ${env.machine.power ?? 'unknown'}. ` +
    `Node ${env.versions.node}, Angular \`${env.versions.angularSha?.slice(0, 7)}\`, ` +
    `compiler-cli ${env.versions.compilerCli}, TypeScript ${env.versions.typescript}, ` +
    `esbuild ${env.versions.esbuild}, ${env.versions.hyperfine}. ` +
    `ngp engine: ${run.engine}. ${run.warmup} warm-up and ${run.runs} measured runs per command; ` +
    `${run.phaseRuns} phase run${run.phaseRuns === 1 ? '' : 's'}. ` +
    `Every Node process gets a ${run.heapMb ?? 'default'} MB heap limit.`,
);
if (env.ci) {
  out();
  out(
    `GitHub Actions run [${env.ci.runId}](https://github.com/${env.ci.repository}/actions/runs/${env.ci.runId}) ` +
      `(attempt ${env.ci.runAttempt}) on commit \`${env.ci.sha?.slice(0, 7)}\`, runner image ${env.ci.runnerImage ?? 'unknown'}.`,
  );
}
if (env.warnings.length) {
  out();
  for (const w of env.warnings) out(`> Warning: ${w}`);
}

for (const scenarioId of run.scenarios) {
  const rows = results.filter((r) => r.scenario === scenarioId);
  if (rows.length === 0) continue;
  if (rows[0].reference) {
    renderReference(scenarioId, rows);
    continue;
  }
  out();
  out(`## ${scenarioId}: ${rows[0].title}`);
  out();
  out(
    scenarioId === 'S1'
      ? 'Baseline: `ngc` in `experimental-local` mode, analyze and emit, no diagnostics. Candidate: `ngp`, then `esbuild` to JavaScript.'
      : 'Baseline: `ngc` in full mode, analyze and emit, no diagnostics. Candidate: `ngp --optimize`, then `esbuild` to JavaScript. ngp also generates type-check blocks in this mode, which the baseline does not.',
  );
  out();
  out('| Components | ngc median | ngp + esbuild median | ngc ÷ ngp | ngc p95 | ngp p95 | ngc CPU (cores used) | ngp CPU (cores used) | ngc peak RSS | ngp peak RSS |');
  out('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    const label = num(r.corpus.components);
    if (!r.hyperfine) {
      const failed = [
        !r.gate.baseline.pass && `ngc gate failed (${r.gate.baseline.js}/${r.corpus.sourceTs} files)`,
        !r.gate.candidate.pass &&
          `ngp gate failed (exit ${r.gate.candidate.ngpExit}, ${r.gate.candidate.diagnostics} diagnostics, ` +
            `${r.gate.candidate.ts}/${r.corpus.sourceTs} files, engine ${r.gate.candidate.engineLoaded})`,
      ].filter(Boolean);
      out(`| ${label} | ${failed.join('; ')} | | | | | | | | |`);
      continue;
    }
    const b = r.hyperfine.baseline;
    const c = r.hyperfine.candidate;
    const noisy = (x) => (x.noisy ? ' ⚠' : '');
    const bRss = med(r.phaseRuns.baseline, (p) => p.rss);
    const cRss = med(r.phaseRuns.candidate, (p) => p.rss);
    out(
      `| ${label} | ${sec(b.medianMs)}${noisy(b)} | ${sec(c.medianMs)}${noisy(c)} | ${(b.medianMs / c.medianMs).toFixed(2)}× | ` +
        `${sec(b.p95Ms)} | ${sec(c.p95Ms)} | ${sec(b.cpuMs)} (${b.parallelism.toFixed(1)}) | ` +
        `${sec(c.cpuMs)} (${c.parallelism.toFixed(1)}) | ${mb(bRss)} | ${mb(cRss)} |`,
    );
  }

  const timedRows = rows.filter((r) => r.phaseRuns);
  if (timedRows.length === 0) continue;

  out();
  out(`### Where ngp's time goes (${scenarioId}, median ms of ${run.phaseRuns} run${run.phaseRuns === 1 ? '' : 's'})`);
  out();
  out('| Components | Node start + load | Setup | Waiting on analyzer | prepareChunk | Process files | Diagnostics writes | esbuild | Total |');
  out('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of timedRows) {
    const p = (k) => msf(med(r.phaseRuns.candidate, (x) => x.phasesMs[k]));
    out(
      `| ${num(r.corpus.components)} | ${p('mainStart')} | ${p('setup')} | ${p('analyzerWait')} | ${p('prepareChunk')} | ` +
        `${p('processFiles')} | ${p('writeDiagnostics')} | ${msf(med(r.phaseRuns.candidate, (x) => x.esbuildWallMs))} | ` +
        `${msf(med(r.phaseRuns.candidate, (x) => x.wallMs))} |`,
    );
  }

  out();
  out(`### Where ngc's time goes (${scenarioId}, median ms of ${run.phaseRuns} run${run.phaseRuns === 1 ? '' : 's'}, from \`tracePerformance\`)`);
  out();
  const ngcPhases = ['TypeScriptProgramCreate', 'Analysis', 'Resolve', 'Compile', 'TypeScriptEmit'];
  out(`| Components | Program create | Analysis | Resolve | Compile | TS emit | Other | Total |`);
  out('|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of timedRows) {
    const p = (k) => med(r.phaseRuns.baseline, (x) => x.phasesMs[k] ?? 0);
    const wall = med(r.phaseRuns.baseline, (x) => x.wallMs);
    const named = ngcPhases.reduce((sum, k) => sum + p(k), 0);
    out(
      `| ${num(r.corpus.components)} | ${ngcPhases.map((k) => msf(p(k))).join(' | ')} | ${msf(wall - named)} | ${msf(wall)} |`,
    );
  }
}

function renderReference(scenarioId, rows) {
  const pct = (part, whole) => `${Math.round((100 * part) / whole)}%`;
  out();
  out(`## ${scenarioId}: Full \`ng build\` (reference, not a comparison)`);
  out();
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
  out('- **Optimization**: minifying and tree-shaking chunks, production only. ngp doesn\'t change it, and neither does anything else in this report.');
  out();
  out('The CLI bundles while it compiles, so the phases overlap. Each percentage is that phase\'s time relative to the whole build; they don\'t add up to 100%.');
  out();
  out('| Components | `ng build` development | Angular compilation | Type-check | `ng build` production | Optimization | Peak memory, dev / prod |');
  out('|---:|---:|---:|---:|---:|---:|---:|');
  const compileKeys = ['NG_CREATE_PROGRAM', 'NG_ANALYZE_PROGRAM', 'NG_FIND_AFFECTED', 'NG_EMIT_TS'];
  for (const r of rows) {
    const label = num(r.corpus.components);
    if (!r.hyperfine) {
      const failed = Object.entries(r.gate)
        .filter(([, g]) => !g.pass)
        .map(([c, g]) => `${c} build failed (exit ${g.exit})`);
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
    const noisy = (x) => (x.noisy ? ' ⚠' : '');
    out(
      `| ${label} | ${sec(r.hyperfine.development.medianMs)}${noisy(r.hyperfine.development)} | ` +
        `${sec(compile)} (${pct(compile, devWall)}) | ${sec(typecheck)} (${pct(typecheck, devWall)}) | ` +
        `${sec(r.hyperfine.production.medianMs)}${noisy(r.hyperfine.production)} | ${sec(optimize)} (${pct(optimize, prodWall)}) | ` +
        `${mb(med(dev, (x) => x.rss))} / ${mb(med(prod, (x) => x.rss))} |`,
    );
  }
  out();
  out(
    'Build times are hyperfine medians. Phase times and percentages come from the separate instrumented runs, ' +
      'so each percentage compares numbers from the same runs.',
  );
}

out();
out('## How to read this');
out();
out('- Medians and p95 come from hyperfine. ⚠ marks a command whose median absolute deviation is above 5% of its median.');
out('- "Cores used" is CPU time divided by wall time. The native engine runs on every core; the TypeScript backend and ngc run on one thread plus Node\'s helper threads.');
out('- The ngp column is two processes, ngp and esbuild, so it pays Node startup twice. A CLI integration would run both in one process.');
out('- Phase tables come from separate runs with instrumentation on, and their totals are wall time including process startup. "Other" for ngc is wall time minus the named phases: Node startup, module loading, config reading.');
out('- "Waiting on analyzer" is time the TypeScript backend spent blocked on the Rust analyzer, not the analyzer\'s CPU time. It overlaps nothing: the backend processes one chunk at a time.');
out('- One machine, one run. Compare sizes and ratios within this report, not absolute times across machines.');

await fs.writeFile(path.join(runDir, 'report.md'), lines.join('\n') + '\n');
console.log(`\nreport: ${path.relative(process.cwd(), path.join(runDir, 'report.md'))}`);
