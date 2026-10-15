# Benchmark methodology

This is the plan for measuring ngp against ngc. It follows from the hypotheses in [research.md](research.md). The harness doesn't exist yet. When it does, this file becomes its specification, and any change to a scenario changes this file first.

## The rule every scenario follows

Compare pipelines that finish the same job. ngp on its own neither type-checks nor emits JavaScript, so timing `ngp` against `ngc -p` would compare half a build with a whole one. Each scenario names the job, then the two pipelines that complete it.

Both sides also get the same compiler options. Extended template diagnostics are off in the baseline until ngp implements them (angular/angular#71316), and the report states which checks ran.

## Scenarios

| ID | Job | Baseline | Candidate | Tests hypothesis |
|---|---|---|---|---|
| S1 | Transform only: Angular source to JavaScript, no type-checking | `ngc` in `experimental-local` mode: analyze and emit, no diagnostics | `ngp` default mode, then `esbuild` transform | 1, 2 |
| S2 | Transform with cross-file optimization | `ngc` in full mode: analyze and emit, no diagnostics | `ngp --optimize`, then `esbuild` transform | 1, 2 |
| S3 | Full type-check of templates and TypeScript | `ngc -p` with `noEmit` | `ngp --optimize`, then `tsc --noEmit` (TypeScript 6.0) over `.ng.ts` and `.ngtypecheck.ts` | 3 |
| S4 | Same as S3, on TypeScript 7 | the S3 baseline | `ngp --optimize`, then `tsgo --noEmit` | 3 |
| S5 | Engine comparison | none | the S2 candidate with the native, wasm and sidecar engines forced in turn | 4 |
| S6 | Rebuild after one edit | `ngc` incremental (`NgtscProgram` with `oldProgram`) | `HybridCompiler` with `updateFileContent`, then `analyzeOptimizedDelta` | 5 |
| S7 | Development bundle | `ng build --configuration development` | ngp's `serve` pipeline: `ngp`, then `esbuild` bundle | indicative only |
| R | Reference: a normal `ng build`, development and production | none | none | context for S1 and S2 |

S1 and S2 are implemented in [harness/run.mjs](../harness/run.mjs). The baseline, [harness/ngc-transform.mjs](../harness/ngc-transform.mjs), drives `NgtscProgram` the way the Angular CLI's AOT compilation does: it loads and analyzes the program, then emits JavaScript with Angular's transformers. It never requests diagnostics, so ngc generates no type-check blocks and TypeScript skips its semantic check. The candidate, [harness/esbuild-transform.mjs](../harness/esbuild-transform.mjs), turns ngp's `.ts` output into one `.js` per file with the workspace's tsconfig and skips the `.ngtypecheck.ts` files.

Two asymmetries remain, and both cost ngp time:

- `ngp --optimize` always generates type-check blocks, and ngp has no option to skip them. In S2, ngp does work the baseline doesn't.
- The candidate runs as two processes, ngp then esbuild, so it pays Node startup twice. A CLI integration would run both in one process.

S1 and S2 time only the compiler step. A real `ng build` also type-checks, bundles, processes stylesheets and, in production, optimizes. R puts the compiler step in context. It times a cold `ng build` of the same apps, development and production, with the CLI cache (`.angular/`) cleared before each run, and reads the CLI's own phase timings (`NG_BUILD_DEBUG_PERF=1`). The report splits each build into:

- Angular compilation: program creation, analysis, finding affected files and TypeScript emit, which is the work ngp replaces;
- type-check: the CLI's diagnostics phase, which moves to a separate TypeScript run with ngp;
- optimization: production chunk optimization, which nothing in this repo changes.

R has no ngp column, because ngp can't run inside the CLI yet. The CLI bundles while it compiles, so its phases overlap, and the report shows each as a share of the whole build rather than as slices that sum to 100%.

S4 depends on `tsgo` accepting ngp's TCB output. The first run checks that, and if it fails, S4 reports the error instead of a time.

S7 is labelled indicative because the CLI does work the ngp pipeline skips, including stylesheet compilation, budgets and asset hashing. The Angular team has said they won't publish numbers until they can run this comparison through the CLI. S7 stays in the report so you can see the gap shrink as integration lands.

S6 measures three edits, each restored before the next run:

- a component's class body, such as adding a field;
- a component's external template, such as adding a binding;
- an exported symbol in a shared library that many components import.

## Phase timing inside ngp

Wall time for S2 says how long ngp took. It doesn't say whether Rust or TypeScript took it, which is what hypothesis 2 needs. [toolchain/patches/ngp-phase-timings.patch](../toolchain/patches/ngp-phase-timings.patch) instruments ngp's own CLI loop. It's off unless `NGP_PHASE_TIMINGS=<file>` is set, and it records these phases in wall-clock milliseconds:

| Phase | What it covers |
|---|---|
| Node start + load | process start until `main()` runs: Node bootstrap and module loading |
| Setup | config reading, analyzer construction, `HybridCompiler` construction |
| Waiting on analyzer | time the TypeScript backend spent blocked on the Rust analyzer's next chunk |
| prepareChunk | binding and cycle analysis per chunk, in TypeScript |
| Process files | reading, generating and writing every file, in TypeScript |
| Diagnostics writes | rewriting `.ngdiag.json` after each chunk |

The backend handles one chunk at a time, so these phases don't overlap and they add up to ngp's wall time. "Waiting on analyzer" measures how long the backend was blocked. It's not the analyzer's CPU time, because the analyzer keeps working on its own threads while the backend generates code.

The ngc baseline gets its breakdown from `angularCompilerOptions.tracePerformance`, which reports program creation, analysis, resolution, compilation and emit. Phase runs are separate from the hyperfine runs, so instrumentation never touches the headline numbers, and each phase run also records peak RSS through `/usr/bin/time`.

## Corpus

**Synthetic apps** come from [corpus/generate.mjs](../corpus/generate.mjs), which writes a standard Angular CLI workspace from a component count and a seed. The same inputs always produce byte-identical files, and each workspace's `manifest.json` records a SHA-256 over them. The apps are all standalone, with no NgModules, because that's what a new Angular app looks like today.

| Size | Features | Shared components | Pipes and directives | `.ts` files | All files |
|---|---|---|---|---|---|
| 100 | 5 | 10 | 2 + 2 | 113 | 178 |
| 1,000 | 45 | 100 | 20 + 20 | 1,089 | 1,792 |
| 5,000 | 225 | 500 | 100 + 100 | 5,429 | 8,929 |

Each app is a router shell with one lazy route per feature. A feature holds a page, about 20 child components wired as an acyclic graph, and a root-provided signal store. Every child has the same signal inputs (`label`, `count`, `items`) and a `selected` output, so any parent can bind any child. The templates vary, and these shares are seeded:

- half use external `.html` files, and a fifth use external `.css`;
- control flow (`@if`, `@for`, `@switch`), `@let`, `@defer (on viewport)`, `@angular/common` pipes, and custom pipes and directives from a shared library;
- two-way binding to a `model()` input, host bindings, and `OnPush` on about 70% of components.

Templates compile under `strictTemplates`, so a type error anywhere fails both compilers. Scaling across three sizes is what tests hypothesis 1. A single large app can show ngp is faster without showing how the gap grows.

[corpus/check.mjs](../corpus/check.mjs) checks a workspace before any timing runs on it. It compiles the app with `ngc`, then runs `ngp --optimize` and type-checks ngp's output with `tsc`. With `--negative-control`, it plants one template type error and passes only if every pipeline rejects it.

**Real apps.** At least two open-source Angular apps, pinned by commit and upgraded to `22.3.0-next.2`. Super Productivity and Bitwarden's web vault are candidates because VoidZero published numbers for both, though for a different compiler and a different comparison. [TK: confirm each candidate's Angular version, and whether it upgrades to 22.3 with TypeScript 6.0 without patches.]

**Golden cases.** Angular's own preprocessor golden tests (`packages/compiler-cli/preprocessor/test/golden`) aren't a performance corpus. They're cheap, and they show whether the locally built ngp produces the output Angular expects before any timing runs.

## What gets measured

| Metric | Tool | Why |
|---|---|---|
| Wall time, median and p95 | `hyperfine` for whole processes, `performance.now()` for in-process phases | headline speed |
| CPU time, user plus system | `hyperfine` | shows parallel work that wall time hides |
| Parallelism, CPU over wall | derived | tests hypothesis 4 directly |
| Peak RSS | `/usr/bin/time -l` on macOS, `/usr/bin/time -v` on Linux | tests hypothesis 6 |
| Diagnostics, by error code | both compilers' outputs | parity check, see below |
| Bundle size, raw and gzip | esbuild metafile | `--optimize` should match ngc |

Each data point uses 2 warm-up runs and at least 10 measured runs, with output directories deleted in a `--prepare` step. The report shows median, p95 and the median absolute deviation. If the deviation exceeds 5% of the median, the report flags the result as noisy.

## Correctness gates

A run only produces a timing if it passes these checks. Otherwise the harness records the failure.

1. **It compiles.** ngp exits 0 and writes an output file for every input.
2. **It runs.** For S7, the development bundle boots in headless Chrome without console errors.
3. **Diagnostics match.** S3 and S4 report the same set of error codes and locations as ngc. Any difference is listed in the report, since the Angular team expects a few rare new type errors. Plain `tsc` reports a template error at its line in the `.ngtypecheck.ts` file, while ngc reports it in the `.html` or inline template. The harness has to map TCB locations back to the template through the span comments ngp writes into the TCB, such as `/*270,277*/`, before it can compare locations.
4. **Bundles match.** With `--optimize`, bundle size stays within 1% of ngc's.
5. **The input is unchanged.** Before and after timing, the app's files match the SHA-256 in its manifest. `ngp --out` overwrites sources when its input path runs through a symlink, so the harness checks rather than assumes.

A compiler that fails gate 1 on an app tells you more about ngp's readiness than any timing would, so the report shows failures next to the timings.

## Environment

Every result file records:

- Angular commit SHA, `@angular/compiler-cli` version, and the `Cargo.lock` hash for `ng-analyze`;
- TypeScript 6 and `tsgo` versions, Node version, Rust version;
- which engine actually loaded, from the loader's own debug log, not the one requested;
- SHA-256 of `Cargo.lock`, each engine binary, and each local patch;
- CPU model, core count, RAM, OS, and whether the machine was on battery.

The native engine sizes its thread pool from `available_parallelism()` and has no override. To test scaling by core count on Linux, run under `taskset`. macOS has no equivalent, so core-scaling results come from Linux only.

Every Node process, on both sides, runs with the same heap limit, `--max-old-space-size=6144`. On an 8 GB runner, Node's default heap is about 2 GB, and ngc's full compile with template type-checking of the 5,000-component app runs out of memory at that limit (exit 134; it peaks at 2.7 GB with the larger heap). The report states the limit.

Published results come from GitHub Actions ([.github/workflows/bench.yml](../.github/workflows/bench.yml)), not from a laptop, so anyone with access can see how a number was produced and rerun it. Standard runners have 2 cores and change CPU model between runs, so a report compares ratios inside one run and records the CPU, the runner image and the load average. The generated apps and all compiler output live on a RAM disk (`/dev/shm`). On the runner's network disk, ngp waited on I/O for over a second of a 7-second run, and its medians varied by more than 5%.

## Layout

```text
toolchain/   build ngp from a pinned Angular SHA: TS backend, native, wasm, sidecar; hyperfine
corpus/      synthetic generator and the ngc/ngp compile check
harness/     runner, baseline and esbuild steps, statistics, environment capture, report
results/     smoke-test JSON, and one directory per benchmark run with raw data and report.md
docs/        research, this methodology
```

## Open questions

- Does `tsgo` type-check ngp's `.ngtypecheck.ts` files today? S4 depends on it.
- Which ngc API gives an incremental baseline for S6 that matches what the CLI's watch mode does?
