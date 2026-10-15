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
    `${run.phaseRuns} phase runs.`,
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
  out(`### Where ngp's time goes (${scenarioId}, median ms of ${run.phaseRuns} runs)`);
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
  out(`### Where ngc's time goes (${scenarioId}, median ms of ${run.phaseRuns} runs, from \`tracePerformance\`)`);
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
