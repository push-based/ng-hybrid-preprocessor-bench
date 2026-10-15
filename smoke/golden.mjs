// Runs Angular's preprocessor golden cases against the locally built ngp, once per engine.
//
// It calls the same helpers as Angular's own golden_spec.ts (runPipeline, compareOutputs),
// so a pass here means what a pass means in Angular's CI. The only difference is the engine
// selection added by toolchain/patches/test-utils-engine-select.patch.
//
// Usage: node smoke/golden.mjs [--engine native,wasm,sidecar] [--filter <substring>] [--verbose]

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolchainOut = path.join(root, 'toolchain/out');
const goldenRoot = path.join(
  root,
  'toolchain/.cache/angular/packages/compiler-cli/preprocessor/test/golden',
);

const {values: args} = parseArgs({
  options: {
    engine: {type: 'string', default: 'native,wasm,sidecar'},
    filter: {type: 'string', default: ''},
    verbose: {type: 'boolean', default: false},
  },
});

process.env['NGP_FIXTURE_NODE_MODULES'] = path.join(root, 'node_modules');
process.env['NGP_NATIVE_BINDING'] = path.join(toolchainOut, 'engines/native/ng_analyze.node');
process.env['NGP_WASM_BINDING'] = path.join(toolchainOut, 'engines/wasm/ng_analyze.js');
process.env['NGP_SIDECAR_BINARY'] = path.join(toolchainOut, 'engines/sidecar/ng_analyze_bin');

// Angular's resolveGoldenRoot() looks for packages/compiler-cli/preprocessor/test/golden under
// the working directory, and case names are relative to whatever it finds.
process.chdir(path.join(root, 'toolchain/.cache/angular'));

const testDir = path.join(toolchainOut, 'preprocessor/test');
const {parseMarkdownTestCase, runPipeline, compareOutputs, pathExists} = await import(
  path.join(testDir, 'utils.js')
);
const {collectGoldenCasesSync, pipelineOptionsFor} = await import(
  path.join(testDir, 'golden_cases.js')
);

const cases = collectGoldenCasesSync(goldenRoot).filter((c) => c.includes(args.filter));
const engines = args.engine.split(',').map((e) => e.trim());

// One (case, mode) pair per golden file, with the same skip rules as golden_spec.ts.
async function jobsFor(testCase) {
  const dir = path.join(goldenRoot, testCase);
  const jobs = [];
  if (await pathExists(path.join(dir, 'golden.md'))) {
    jobs.push({testCase, mode: 'standard', golden: path.join(dir, 'golden.md')});
  }
  if (await pathExists(path.join(dir, 'golden.opt.md'))) {
    jobs.push({testCase, mode: 'optimize', golden: path.join(dir, 'golden.opt.md')});
  }
  return jobs;
}

async function runJob(job) {
  const dir = path.join(goldenRoot, job.testCase);
  const [source, expected] = await Promise.all([
    parseMarkdownTestCase(path.join(dir, 'source.md')),
    parseMarkdownTestCase(job.golden),
  ]);
  const errors = [];
  const start = performance.now();
  try {
    const actual = await runPipeline(source, {...pipelineOptionsFor(job.testCase, job.mode), errors});
    compareOutputs(actual, expected);
    return {status: 'pass', ms: performance.now() - start, errors};
  } catch (e) {
    const message = String(e?.message ?? e);
    // compareOutputs throws "Content mismatch" / "Missing file" / "Unexpected file";
    // anything else is the pipeline itself failing.
    const status = /^(Content mismatch|Missing file|Unexpected file)/.test(message)
      ? 'mismatch'
      : 'crash';
    return {status, ms: performance.now() - start, errors, message};
  }
}

const jobs = (await Promise.all(cases.map(jobsFor))).flat();
console.log(`${cases.length} golden cases, ${jobs.length} case/mode pairs, engines: ${engines.join(', ')}\n`);

const report = {
  angularSha: (await fs.readFile(path.join(root, 'toolchain/versions.env'), 'utf8')).match(
    /ANGULAR_SHA=(\w+)/,
  )[1],
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  date: new Date().toISOString(),
  engines: {},
};

for (const engine of engines) {
  process.env['NGP_ENGINE'] = engine;
  const results = [];
  const engineStart = performance.now();
  for (const job of jobs) {
    const result = await runJob(job);
    results.push({case: job.testCase, mode: job.mode, ...result});
    if (args.verbose && result.status !== 'pass') {
      console.log(`  ${result.status.padEnd(8)} ${job.testCase} [${job.mode}]`);
    }
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = {
    pass: count('pass'),
    mismatch: count('mismatch'),
    crash: count('crash'),
    totalMs: Math.round(performance.now() - engineStart),
  };
  report.engines[engine] = {summary, results};
  console.log(
    `${engine.padEnd(8)} pass ${summary.pass}/${results.length}  mismatch ${summary.mismatch}  ` +
      `crash ${summary.crash}  (${(summary.totalMs / 1000).toFixed(1)} s)`,
  );
}

// Failures that differ between engines point at an engine bug rather than a backend gap.
const failingBy = (engine) =>
  new Set(
    report.engines[engine].results
      .filter((r) => r.status !== 'pass')
      .map((r) => `${r.case} [${r.mode}]`),
  );
const allFailing = new Set(engines.flatMap((e) => [...failingBy(e)]));
if (allFailing.size > 0) {
  console.log('\nNon-passing cases:');
  for (const key of [...allFailing].sort()) {
    const marks = engines.map((e) => {
      const r = report.engines[e].results.find((x) => `${x.case} [${x.mode}]` === key);
      return `${e}=${r.status}`;
    });
    console.log(`  ${key.padEnd(60)} ${marks.join('  ')}`);
  }
}

const outDir = path.join(root, 'results/smoke');
await fs.mkdir(outDir, {recursive: true});
const outFile = path.join(outDir, 'golden.json');
await fs.writeFile(outFile, JSON.stringify(report, null, 2) + '\n');
console.log(`\nFull results: ${path.relative(root, outFile)}`);

const anyNonPass = engines.some((e) => report.engines[e].summary.pass !== jobs.length);
process.exitCode = anyNonPass ? 1 : 0;
