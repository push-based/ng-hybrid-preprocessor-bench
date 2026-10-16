// Baseline for S1 and S2: ngc's transform without any diagnostics.
//
// It drives NgtscProgram the way the Angular CLI's AOT compilation does: create the program,
// load and analyze it (loadNgStructureAsync), then emit JavaScript with Angular's transformers.
// It never asks for TypeScript or template diagnostics, so no type-check blocks are generated.
//
// Usage: node harness/ngc-transform.mjs <tsconfig> --mode local|full --out <dir>
//          [--trace <perf.json>] [--diagnostics] [--root <dir>]
//
// --root sets rootDir: TypeScript 6 rejects an outDir without one (TS5011), and real apps' tsconfigs
// never needed it because the Angular CLI doesn't emit through outDir.
//
// --trace writes ngc's own phase timings (angularCompilerOptions.tracePerformance).
// --diagnostics also collects all diagnostics after emit and fails if there are any; the harness
// uses it for the untimed correctness gate only.

import {parseArgs} from 'node:util';
import * as path from 'node:path';
import {NgtscProgram, createCompilerHost, readConfiguration} from '@angular/compiler-cli';

const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    mode: {type: 'string', default: 'full'},
    out: {type: 'string'},
    trace: {type: 'string'},
    diagnostics: {type: 'boolean', default: false},
    root: {type: 'string'},
  },
});
if (positionals.length !== 1 || !args.out || !['local', 'full'].includes(args.mode)) {
  console.error('Usage: node harness/ngc-transform.mjs <tsconfig> --mode local|full --out <dir>');
  process.exit(1);
}

const config = readConfiguration(path.resolve(positionals[0]), {
  outDir: path.resolve(args.out),
  noEmit: false,
  declaration: false,
  sourceMap: true,
  compilationMode: args.mode === 'local' ? 'experimental-local' : 'full',
  ...(args.trace ? {tracePerformance: path.resolve(args.trace)} : {}),
  ...(args.root ? {rootDir: path.resolve(args.root)} : {}),
});
if (config.errors.length > 0) {
  console.error(config.errors.map((d) => d.messageText).join('\n'));
  process.exit(1);
}

const host = createCompilerHost({options: config.options});
const program = new NgtscProgram(config.rootNames, config.options, host);
await program.loadNgStructureAsync();
const result = program.emit();
if (result.emitSkipped) {
  console.error('emit skipped');
  process.exit(1);
}

if (args.diagnostics) {
  const diags = [
    ...program.getTsSyntacticDiagnostics(),
    ...program.getTsSemanticDiagnostics(),
    ...program.getNgStructuralDiagnostics(),
    ...program.getNgSemanticDiagnostics(),
  ];
  if (diags.length > 0) {
    for (const d of diags.slice(0, 5)) {
      const text = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText;
      console.error(`${d.file?.fileName ?? ''}: error ${d.source === 'angular' ? 'NG' : 'TS'}${d.code}: ${text}`);
    }
    console.error(`${diags.length} diagnostics`);
    process.exit(1);
  }
}
