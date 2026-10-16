// Baseline for S3 and S4: ngc's full type-check of templates and TypeScript, without emitting.
//
// Creates the NgtscProgram, analyzes it, then collects every diagnostic: TypeScript syntax and
// semantics, Angular structure, and template type-checking (which generates type-check blocks
// inside ngc's own TypeScript program). This is the work `ngc -p tsconfig.json --noEmit` does.
// Exits 1 and prints the diagnostics if there are any.
//
// Usage: node harness/ngc-typecheck.mjs <tsconfig> [--trace <perf.json>]

import * as fs from 'node:fs';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {NgtscProgram, createCompilerHost, formatDiagnostics, readConfiguration} from '@angular/compiler-cli';

const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {trace: {type: 'string'}},
});
if (positionals.length !== 1) {
  console.error('Usage: node harness/ngc-typecheck.mjs <tsconfig> [--trace <perf.json>]');
  process.exit(1);
}

const config = readConfiguration(path.resolve(positionals[0]), {noEmit: true});
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

if (diags.length > 0) {
  console.error(formatDiagnostics(diags));
  process.exit(1);
}
