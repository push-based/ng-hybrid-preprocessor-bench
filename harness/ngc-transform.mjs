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
//
// --typecheck makes this ngc's full compile, as `ngc -p` runs it: every TypeScript and Angular
// diagnostic (template type-checking included) is collected before emit, and errors fail the run.
// It uses the same option overrides as harness/ngc-typecheck.mjs. S8 uses it.

import {parseArgs} from 'node:util';
import * as path from 'node:path';
import {NgtscProgram, createCompilerHost, formatDiagnostics, readConfiguration} from '@angular/compiler-cli';

const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    mode: {type: 'string', default: 'full'},
    out: {type: 'string'},
    trace: {type: 'string'},
    diagnostics: {type: 'boolean', default: false},
    typecheck: {type: 'boolean', default: false},
    root: {type: 'string'},
  },
});
if (positionals.length !== 1 || !args.out || !['local', 'full'].includes(args.mode)) {
  console.error('Usage: node harness/ngc-transform.mjs <tsconfig> --mode local|full --out <dir>');
  process.exit(1);
}

const tsconfig = path.resolve(positionals[0]);
// Same overrides as the S3 baseline: unused-code checks off on both sides, extended diagnostics
// suppressed where ngc accepts that (strictTemplates on).
const typecheckOverrides = args.typecheck
  ? {
      noUnusedLocals: false,
      noUnusedParameters: false,
      ...(readConfiguration(tsconfig).options.strictTemplates ? {extendedDiagnostics: {defaultCategory: 'suppress'}} : {}),
    }
  : {};
const config = readConfiguration(tsconfig, {
  ...typecheckOverrides,
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
if (args.typecheck) {
  const diags = [
    ...program.getTsOptionDiagnostics(),
    ...program.getNgOptionDiagnostics(),
    ...program.getTsSyntacticDiagnostics(),
    ...program.getNgStructuralDiagnostics(),
    ...program.getTsSemanticDiagnostics(),
    ...program.getNgSemanticDiagnostics(),
  ];
  if (diags.length > 0) console.error(formatDiagnostics(diags));
  if (diags.some((d) => d.category === 1 /* ts.DiagnosticCategory.Error */)) process.exit(1);
}
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
  // Only errors fail the gate; warnings such as NG8113 (unused standalone import) are printed.
  const errors = diags.filter((d) => d.category === 1 /* ts.DiagnosticCategory.Error */);
  if (errors.length > 0) {
    for (const d of errors.slice(0, 5)) {
      const text = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText;
      console.error(`${d.file?.fileName ?? ''}: error ${d.source === 'angular' ? 'NG' : 'TS'}${d.code}: ${text}`);
    }
    console.error(`${errors.length} errors`);
    process.exit(1);
  }
}
