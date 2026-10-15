// Second half of the S1/S2 candidate: turn ngp's TypeScript output into JavaScript.
//
// One esbuild call, no bundling, one .js and .js.map per input, using the workspace's tsconfig
// so class-field and decorator semantics match ngc's emit. Type-check blocks (.ngtypecheck.ts)
// are skipped: they exist for type-checking and are never shipped.
//
// Usage: node harness/esbuild-transform.mjs <ngp-out-dir> --tsconfig <workspace tsconfig.json>

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import * as esbuild from 'esbuild';

const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {tsconfig: {type: 'string'}},
});
const dir = path.resolve(positionals[0]);

const entries = await fs.readdir(dir, {recursive: true, withFileTypes: true});
const entryPoints = entries
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .filter((e) => !e.name.endsWith('.ngtypecheck.ts') && !e.name.endsWith('.d.ts'))
  .map((e) => path.join(e.parentPath, e.name));

await esbuild.build({
  entryPoints,
  outdir: dir,
  outbase: dir,
  bundle: false,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  tsconfig: path.resolve(args.tsconfig),
  logLevel: 'error',
});
