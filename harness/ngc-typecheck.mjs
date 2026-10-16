// Baseline for S3 and S4: ngc's full type-check of templates and TypeScript, without emitting.
//
// Creates the NgtscProgram, analyzes it, then collects every diagnostic: TypeScript syntax and
// semantics, Angular structure, and template type-checking (which generates type-check blocks
// inside ngc's own TypeScript program). This is the work `ngc -p tsconfig.json --noEmit` does.
// Exits 1 and prints the diagnostics if there are any errors; warnings are printed but pass.
//
// Extended template diagnostics are suppressed when the app uses strictTemplates (ngc rejects the
// option otherwise): ngp doesn't implement them yet (angular/angular#71316), and running them
// would give ngc work the candidates skip.
//
// Usage: node harness/ngc-typecheck.mjs <tsconfig> [--trace <perf.json>] [--root <dir>]
//
// --root sets rootDir, for apps whose tsconfig sets outDir and imports sources from outside the
// tsconfig's directory: TypeScript 6 reports TS6059 for those even without emitting.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {NgtscProgram, createCompilerHost, formatDiagnostics, readConfiguration} from '@angular/compiler-cli';

const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {trace: {type: 'string'}, root: {type: 'string'}},
});
if (positionals.length !== 1) {
  console.error('Usage: node harness/ngc-typecheck.mjs <tsconfig> [--trace <perf.json>]');
  process.exit(1);
}

const tsconfig = path.resolve(positionals[0]);
// noUnusedLocals/noUnusedParameters are off because ngp's generated code fails them (TS6133), and
// the ngp candidates check with them off; both sides do the same work.
const overrides = {
  noEmit: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
  ...(args.root ? {rootDir: path.resolve(args.root)} : {}),
};
// ngc only accepts extendedDiagnostics with strictTemplates on (NG4003).
if (readConfiguration(tsconfig).options.strictTemplates) {
  overrides.extendedDiagnostics = {defaultCategory: 'suppress'};
}
const config = readConfiguration(tsconfig, overrides);
if (config.errors.length > 0) {
  console.error(formatDiagnostics(config.errors));
  process.exit(1);
}

const host = createCompilerHost({options: config.options});
const program = new NgtscProgram(config.rootNames, config.options, host);
await program.loadNgStructureAsync();
const diags = [
  ...program.getTsOptionDiagnostics(),
  ...program.getNgOptionDiagnostics(),
  ...program.getTsSyntacticDiagnostics(),
  ...program.getNgStructuralDiagnostics(),
  ...program.getTsSemanticDiagnostics(),
  ...program.getNgSemanticDiagnostics(),
];

// NgtscProgram writes tracePerformance only from emit(), which a type-check never calls.
if (args.trace) {
  const perf = program.compiler.perfRecorder.finalize();
  fs.writeFileSync(path.resolve(args.trace), JSON.stringify(perf, null, 2));
}

if (diags.length > 0) console.error(formatDiagnostics(diags));
if (diags.some((d) => d.category === 1 /* ts.DiagnosticCategory.Error */)) process.exit(1);
