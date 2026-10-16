// Checks that ngc and ngp both compile a generated workspace cleanly.
//
//   ngc   `ngc -p tsconfig.app.json`: analysis, template type-checking and JS emit in one go.
//   ngp   `ngp --optimize`, then `tsc --noEmit` (TypeScript 6) and `tsgo --noEmit` (TypeScript 7)
//         over its .ts and .ngtypecheck.ts output.
//         ngp itself must exit 0, report no diagnostics in its .ngdiag.json, and write one
//         output file per input .ts file.
//
// Times printed here come from a single run each and are not benchmark results.
//
// --negative-control copies the workspace, turns one child binding into a type error
// ([count]="label()", a string into a number input), and expects BOTH pipelines to fail.
// A check that can't fail proves nothing.
//
// Usage: node corpus/check.mjs <workspace-dir> [--engine native,wasm,sidecar] [--negative-control]

import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {diagnosticKey, mapTcbDiagnostic, parseDiagnostics} from '../harness/lib/diagnostics.mjs';
import {engineEnv, ngcBin, ngpMain, root, tscBin, tsgoBin} from '../harness/lib/paths.mjs';


const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    engine: {type: 'string', default: 'native'},
    'negative-control': {type: 'boolean', default: false},
  },
});
if (positionals.length !== 1) {
  console.error('Usage: node corpus/check.mjs <workspace-dir> [--engine native,wasm,sidecar] [--negative-control]');
  process.exit(1);
}

// Real path: ngp --out overwrites sources when its input path runs through a symlink.
let workspace = await fs.realpath(path.resolve(positionals[0]));
const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'manifest.json'), 'utf8'));
const negative = args['negative-control'];
const label = manifest.name + (negative ? ' (negative control)' : '');
const outRoot = path.join(root, 'corpus/.out', manifest.name + (negative ? '-negative' : ''));
await fs.rm(outRoot, {recursive: true, force: true});
await fs.mkdir(outRoot, {recursive: true});

if (negative) {
  const copy = path.join(outRoot, 'workspace');
  await fs.cp(workspace, copy, {recursive: true});
  workspace = copy;
  await plantTypeError(workspace);
}

const tsconfigApp = path.join(workspace, 'tsconfig.app.json');
const diagFile = path.join(workspace, 'tsconfig.app.ngdiag.json');

function run(cmd, cmdArgs, env = {}) {
  const start = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [cmd, ...cmdArgs], {
    cwd: root,
    env: {...process.env, ...env},
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // ngc colors its diagnostics; strip ANSI codes so they can be counted.
  const output = ((res.stdout ?? '') + (res.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
  // ngc and tsc print one "error TSxxxx"/"error NGxxxx" per diagnostic.
  const codes = [...new Set(output.match(/error (TS|NG)\d+/g)?.map((m) => m.slice(6)) ?? [])].sort();
  const errors = output.match(/error (TS|NG)\d+/g)?.length ?? 0;
  return {exit: res.status, ms: Math.round(ms), errors, codes, output};
}

async function listFiles(dir, pred) {
  const entries = await fs.readdir(dir, {recursive: true, withFileTypes: true});
  return entries.filter((e) => e.isFile() && pred(e.name)).map((e) => path.join(e.parentPath, e.name));
}

async function plantTypeError(ws) {
  const candidates = (await listFiles(path.join(ws, 'src'), (n) => /\.(ts|html)$/.test(n))).sort();
  for (const file of candidates) {
    const text = await fs.readFile(file, 'utf8');
    const match = text.match(/\[count\]="count\(\) \+ \d+"/);
    if (match) {
      await fs.writeFile(file, text.replace(match[0], '[count]="label()"'));
      console.log(`planted type error in ${path.relative(ws, file)}: ${match[0]} -> [count]="label()"`);
      return;
    }
  }
  throw new Error('no child binding found to turn into a type error');
}

const sourceTs = (await listFiles(path.join(workspace, 'src'), (n) => n.endsWith('.ts'))).length;
const report = {workspace: manifest.name, negativeControl: negative, sourceTs, ngc: null, ngp: {}};

// ngc
{
  const r = run(ngcBin, ['-p', tsconfigApp, '--outDir', path.join(outRoot, 'ngc')]);
  report.ngc = {pass: r.exit === 0, exit: r.exit, errors: r.errors, codes: r.codes, ms: r.ms};
  report.ngc.locations = parseDiagnostics(r.output, [workspace, root])
    .map((d) => diagnosticKey(d, workspace))
    .sort();
  if (r.exit !== 0) report.ngc.firstError = r.output.split('\n').find((l) => /error/.test(l));
}

// ngp, once per engine
for (const engine of args.engine.split(',').map((e) => e.trim())) {
  const out = path.join(outRoot, `ngp-${engine}`);
  const {env, extraArgs} = engineEnv(engine);
  await fs.rm(diagFile, {force: true});
  const ngp = run(ngpMain, [workspace, '--optimize', '--out', out, ...extraArgs], env);

  let diagnostics = null;
  try {
    diagnostics = JSON.parse(await fs.readFile(diagFile, 'utf8')).diagnostics;
    await fs.rename(diagFile, path.join(outRoot, `ngp-${engine}.ngdiag.json`));
  } catch {}

  const emitted = await listFiles(out, (n) => n.endsWith('.ts') && !n.endsWith('.ngtypecheck.ts')).catch(() => []);
  const tcbs = await listFiles(out, (n) => n.endsWith('.ngtypecheck.ts')).catch(() => []);

  // Type-check what ngp wrote, using the workspace's own compiler options. The output may sit
  // outside this repo, so link node_modules next to it for @angular/* to resolve.
  const checkConfig = path.join(out, 'tsconfig.check.json');
  await fs.mkdir(out, {recursive: true});
  await fs.symlink(path.join(root, 'node_modules'), path.join(out, 'node_modules'), 'dir').catch(() => {});
  await fs.writeFile(
    checkConfig,
    JSON.stringify({
      extends: path.relative(out, path.join(workspace, 'tsconfig.json')),
      compilerOptions: {noEmit: true, types: []},
      files: [],
      include: ['src/**/*.ts'],
    }),
  );
  const tsc = run(tscBin, ['-p', checkConfig]);
  const tsgo = run(tsgoBin, ['-p', checkConfig]);

  const ngpOk = ngp.exit === 0 && diagnostics !== null && diagnostics.length === 0;
  // Errors land in .ngtypecheck.ts files; map each back to the template location ngc reports.
  const locations = (r) =>
    parseDiagnostics(r.output, [root, out])
      .map((d) => mapTcbDiagnostic(d) ?? d)
      .map((d) => diagnosticKey(d, workspace))
      .sort();
  const checker = (r) => {
    const locs = locations(r);
    return {
      exit: r.exit,
      errors: r.errors,
      codes: r.codes,
      ms: r.ms,
      locations: locs,
      locationsMatchNgc: JSON.stringify(locs) === JSON.stringify(report.ngc.locations),
    };
  };
  const result = {
    pass: ngpOk && emitted.length === sourceTs && tsc.exit === 0 && tsgo.exit === 0,
    // Negative control: ngp still compiles, and BOTH type-checkers reject the planted error.
    caught: ngpOk && emitted.length === sourceTs && tsc.exit !== 0 && tsgo.exit !== 0,
    ngp: {exit: ngp.exit, ms: ngp.ms, diagnostics: diagnostics?.length ?? null},
    outputs: {ts: emitted.length, ngtypecheck: tcbs.length},
    tsc: checker(tsc),
    tsgo: checker(tsgo),
  };
  if (ngp.exit !== 0) result.ngp.tail = ngp.output.trim().split('\n').slice(-5);
  for (const [k, r] of [['tsc', tsc], ['tsgo', tsgo]]) {
    if (r.exit !== 0) result[k].firstError = r.output.split('\n').find((l) => /error/.test(l));
  }
  report.ngp[engine] = result;
}

// Report
const verdict = (r) =>
  negative ? (r.caught ? 'caught' : 'NOT CAUGHT') : r.pass ? 'pass' : 'FAIL';
const ngcCaught = !report.ngc.pass;
console.log(`\n${label}: ${manifest.components} components, ${sourceTs} .ts files`);
console.log(
  `  ngc            ${(negative ? (ngcCaught ? 'caught' : 'NOT CAUGHT') : report.ngc.pass ? 'pass' : 'FAIL').padEnd(10)} ` +
    `${report.ngc.errors} errors ${report.ngc.codes.join(',')}   ${report.ngc.ms} ms`,
);
for (const [engine, r] of Object.entries(report.ngp)) {
  console.log(
    `  ngp ${engine.padEnd(8)}   ${verdict(r).padEnd(10)} ngp ${r.ngp.ms} ms (exit ${r.ngp.exit}, ` +
      `${r.ngp.diagnostics ?? '?'} diagnostics, ${r.outputs.ts}/${sourceTs} files, ${r.outputs.ngtypecheck} TCBs)` +
      ` + tsc ${r.tsc.ms} ms (${r.tsc.errors} errors ${r.tsc.codes.join(',')})` +
      ` + tsgo ${r.tsgo.ms} ms (${r.tsgo.errors} errors ${r.tsgo.codes.join(',')})` +
      (negative
        ? `; locations match ngc: tsc ${r.tsc.locationsMatchNgc ? 'yes' : 'NO'}, tsgo ${r.tsgo.locationsMatchNgc ? 'yes' : 'NO'}`
        : ''),
  );
}
for (const line of [
  report.ngc.firstError,
  ...Object.values(report.ngp).flatMap((r) => [r.tsc.firstError, r.tsgo.firstError]),
]) {
  if (line) console.log(`    ${line.trim()}`);
}

const resultsFile = path.join(root, 'results/smoke/corpus.json');
await fs.mkdir(path.dirname(resultsFile), {recursive: true});
const all = JSON.parse(await fs.readFile(resultsFile, 'utf8').catch(() => '{}'));
all[label] = {date: new Date().toISOString(), node: process.version, ...report};
await fs.writeFile(resultsFile, JSON.stringify(all, null, 2) + '\n');

const allPass = report.ngc.pass && Object.values(report.ngp).every((r) => r.pass);
// In the negative control, ngp's errors must also point at the same template location as ngc's.
const allCaught =
  ngcCaught &&
  Object.values(report.ngp).every((r) => r.caught && r.tsc.locationsMatchNgc && r.tsgo.locationsMatchNgc);
if (negative) console.log(`  ngc location: ${report.ngc.locations.join('; ')}`);
process.exitCode = (negative ? allCaught : allPass) ? 0 : 1;
