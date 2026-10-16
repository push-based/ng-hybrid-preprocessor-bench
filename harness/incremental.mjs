// S6: rebuild after one edit. Orchestrates harness/incremental-worker.mjs, once per compiler.
//
// Copies the app to a scratch directory so edits can go to disk, picks three edits, runs the ngc
// and ngp workers in separate processes (so neither inherits the other's heap), and writes one
// result file. See the worker for how each compiler rebuilds.
//
// Usage: node harness/incremental.mjs --workspace <app> --tsconfig <path> --out <dir> --result <json>
//          [--rounds 5] [--warmup 1] [--engine native] [--title ...] [--label ...]

import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {root} from './lib/paths.mjs';

const {values: args} = parseArgs({
  options: {
    workspace: {type: 'string'},
    tsconfig: {type: 'string'},
    out: {type: 'string'},
    result: {type: 'string'},
    rounds: {type: 'string', default: '5'},
    warmup: {type: 'string', default: '1'},
    engine: {type: 'string', default: 'native'},
    title: {type: 'string', default: 'Rebuild after one edit'},
    label: {type: 'string'},
  },
});
const source = path.resolve(args.workspace);
const out = path.resolve(args.out);
const copy = path.join(out, 'workspace');

await fs.rm(out, {recursive: true, force: true});
await fs.cp(source, copy, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|\.angular|dist|out-tsc)$/.test(src),
});
await fs.symlink(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
const tsconfig = path.join(copy, path.relative(source, path.resolve(args.tsconfig)));

// Edit targets in a generated app: the first child component, the first external template,
// and the shared model every component imports.
const files = (await fs.readdir(path.join(copy, 'src/app/features'), {recursive: true}))
  .map((f) => path.join('src/app/features', f))
  .sort();
const componentTs = files.find((f) => /-c0*1\.ts$/.test(f));
const templateHtml = files.find((f) => f.endsWith('.html'));
const edits = [
  {id: 'class-field', label: `Component class (${path.basename(componentTs)})`, file: componentTs, kind: 'class-field'},
  {id: 'template', label: `External template (${path.basename(templateHtml)})`, file: templateHtml, kind: 'template'},
  {id: 'shared-type', label: 'Shared type every component imports (models.ts)', file: 'src/app/shared/models.ts', kind: 'shared-type'},
];
const editsFile = path.join(out, 'edits.json');
await fs.writeFile(editsFile, JSON.stringify(edits));

function worker(compiler) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(root, 'harness/incremental-worker.mjs'), '--compiler', compiler, '--workspace', copy,
      '--tsconfig', tsconfig, '--out', out, '--edits', editsFile, '--rounds', args.rounds, '--warmup', args.warmup,
    ],
    {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024},
  );
  if (res.status !== 0) throw new Error(`${compiler} worker failed:\n${(res.stderr || res.stdout).trim().split('\n').slice(-10).join('\n')}`);
  return JSON.parse(res.stdout.trim().split('\n').at(-1));
}

const ngc = worker('ngc');
const ngp = worker('ngp');
const result = {
  scenario: 'S6',
  title: args.title,
  incremental: true,
  engine: args.engine,
  target: {name: path.basename(source), label: args.label ?? path.basename(source)},
  rounds: Number(args.rounds),
  initial: {
    ngc: {medianMs: ngc.initial.ms, files: ngc.initial.files},
    ngp: {medianMs: ngp.initial.ms, files: ngp.initial.files},
  },
  edits: edits.map((e, i) => ({id: e.id, label: e.label, file: e.file, ngc: ngc.edits[i], ngp: ngp.edits[i]})),
};
await fs.writeFile(args.result, JSON.stringify(result, null, 2) + '\n');
await fs.rm(out, {recursive: true, force: true});
for (const e of result.edits) {
  console.log(
    `${e.id}: ngc ${Math.round(e.ngc.medianMs)} ms (${e.ngc.files} files${e.ngc.matchesFreshBuild ? '' : ', MISMATCH'}), ` +
      `ngp ${Math.round(e.ngp.medianMs)} ms (${e.ngp.files} files${e.ngp.matchesFreshBuild ? '' : ', MISMATCH'})`,
  );
}
const ok = result.edits.every((e) => e.ngc.matchesFreshBuild && e.ngp.matchesFreshBuild);
process.exitCode = ok ? 0 : 1;
