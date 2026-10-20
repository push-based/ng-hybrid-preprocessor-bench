# Benchmark methodology

This is how the benchmark measures ngp against ngc. It follows from the hypotheses in [research.md](research.md), and it describes what [harness/run.mjs](../harness/run.mjs) does. A change to a scenario changes this file first.

## The rule every scenario follows

Compare pipelines that finish the same job. ngp on its own neither type-checks nor emits JavaScript, so timing `ngp` against `ngc -p` would compare half a build with a whole one. Each scenario names the job, then the pipelines that complete it.

Both sides also get the same compiler options:

- extended template diagnostics are off in the ngc baseline, because ngp doesn't implement them yet (angular/angular#71316);
- `noUnusedLocals` and `noUnusedParameters` are off on both sides, because ngp's generated code fails them (TS6133 on compiled templates' unused `ctx` parameters and never-called `_tcbN` functions);
- every Node process gets the same heap limit, `--max-old-space-size=6144`.

## Scenarios

| ID | Job | Baseline | Candidates | Tests hypothesis |
|---|---|---|---|---|
| S1 | Angular source to JavaScript, no type-checking | ngc in `experimental-local` mode: analyze and emit, no diagnostics | `ngp`, then esbuild | 1, 2 |
| S2 | Same, with cross-file optimization | ngc in full mode: analyze and emit, no diagnostics | `ngp --optimize`, then esbuild | 1, 2 |
| S3 | Type-check templates and TypeScript, emit nothing | ngc's full type-check | `ngp --optimize`, then `tsc` 6 | 3 |
| S4 | Same, on TypeScript 7 | the S3 baseline, in the same run | `ngp --optimize`, then `tsgo` 7 | 3 |
| S5 | The S2 job on each analyzer engine | ngc in full mode | the S2 candidate on native, wasm and sidecar | 4 |
| S6 | Rebuild after one edit | ngc, reusing its previous program | ngp, sending the edit to its analyzer | 5 |
| S7 | A development build that boots in a browser | `ng build --configuration development --aot` | `ngp --optimize`, then an esbuild bundle; and the same plus `tsgo` | indicative only |
| S8 | The whole compiler job: type errors reported and JavaScript written | ngc's full compile, as `ngc -p` runs it | `ngp --optimize`, then one `tsgo` 7 (or `tsc` 6) run that type-checks and emits | 3; the ViteConf 2026 claim |
| R | Reference: a normal `ng build`, development and production | none | none | context for S1 and S2 |

**S1 and S2.** The baseline, [harness/ngc-transform.mjs](../harness/ngc-transform.mjs), drives `NgtscProgram` the way the Angular CLI's AOT compilation does: it loads and analyzes the program, then emits JavaScript with Angular's transformers. It never requests diagnostics, so ngc builds no type-check blocks and TypeScript skips its semantic check. The candidate, [harness/esbuild-transform.mjs](../harness/esbuild-transform.mjs), turns ngp's `.ts` output into one `.js` per file with the app's tsconfig. Two asymmetries remain, and both cost ngp time: `ngp --optimize` always writes type-check blocks, which the S2 baseline doesn't build, and the candidate runs as two processes, so it pays Node startup twice.

**S3 and S4.** The baseline, [harness/ngc-typecheck.mjs](../harness/ngc-typecheck.mjs), collects every TypeScript and Angular diagnostic without emitting, which is the work `ngc --noEmit` does. The candidates type-check everything ngp wrote, `.ts` and `.ngtypecheck.ts`, with a tsconfig that extends the app's own. That config points the app's path aliases at ngp's output first, adds the same for deep imports into the app's own npm-workspace packages (Bitwarden imports `@bitwarden/components/src/...`, which would otherwise resolve through the `node_modules` symlink to the original source and load every class twice), and uses `rootDirs` so files ngp doesn't emit (JSON, hand-written `.d.ts`) resolve from the app. TypeScript 7 is installed as `typescript7` (7.0.2), because Angular needs `typescript` 6 by that name.

**S5.** The S2 job, with the engine forced through the loader, so it can't silently fall back. native is the N-API addon and uses every core. wasm is single-threaded. sidecar is a separate process that speaks JSON over stdio.

**S6.** [harness/incremental.mjs](../harness/incremental.mjs) copies the app to a scratch directory and runs one worker per compiler, so neither inherits the other's heap. Three edits, each applied, timed, then reverted:

- a component's class body: a new signal field;
- a component's external template: one more element;
- the `Item` interface every component imports: a new optional field.

ngc gets a caching compiler host and a new `NgtscProgram` that reuses the previous one, with `getModifiedResourceFiles` for template edits, which is what ngc's watch mode and the CLI do. ngc saves its incremental state only after template type-checking, and S6 rebuilds without type-checking, so the worker saves that state itself after emit. That gives ngc its best case; without it, every ngc rebuild is a full compile. ngp gets one `HybridCompiler` for the session. A rebuild sends the edit to the analyzer (`updateFileContent`), runs `analyzeOptimizedDelta`, and regenerates the `.ts` files the analyzer reports stale. Both sides write output, and ngp's goes through esbuild, so the job matches S2. After each edit's timed rounds, the incremental output is compared byte for byte with a fresh build of the same sources.

**S7.** [harness/ngp-bundle.mjs](../harness/ngp-bundle.mjs) bundles ngp's output with esbuild the way ngp's own `serve` tool does, running Angular's linker over npm packages that ship partially compiled. [harness/boot-check.mjs](../harness/boot-check.mjs) opens each build in headless Chrome and passes only if the root component and the first lazy route render without console errors. S7 is labelled indicative: the ngp pipeline skips stylesheet processing, budgets and asset handling, and runs its steps one after another where the CLI overlaps them.

**S8.** Reproduces the comparison Alex Rickabaugh showed at ViteConf 2026 (see [research.md](research.md#what-the-angular-team-said-at-viteconf-2026)): old ngc against ngp followed by TypeScript 7, for the whole compiler job. The baseline is [harness/ngc-transform.mjs](../harness/ngc-transform.mjs) with `--typecheck`: every diagnostic, then emit, with the S3 option overrides. The candidates run one TypeScript program over ngp's output that type-checks and emits JavaScript with source maps, from the same config as S3/S4 with emit switched on. TypeScript also emits the type-check blocks, which costs the candidates a little. The gate requires a `.js` for every file ngp wrote, and type errors are compared with ngc's as in S3.

**R.** A cold `ng build` of the same apps, development and production, with the CLI cache (`.angular/`) cleared before each run. It reads the CLI's own phase timings (`NG_BUILD_DEBUG_PERF=1`) and splits each build into Angular compilation (the work ngp replaces), type-check (which moves to a separate TypeScript run with ngp) and production optimization (which nothing here changes). Phases overlap because the CLI bundles while it compiles, so the report shows each as a share of the build rather than slices that add up to 100%. Builds pass `--aot`, because an app's development configuration can be a JIT build; Super Productivity's is.

## Phase timing inside ngp

Wall time says how long ngp took, not whether Rust or TypeScript took it, which is what hypothesis 2 needs. [toolchain/patches/ngp-phase-timings.patch](../toolchain/patches/ngp-phase-timings.patch) instruments ngp's own CLI loop. It's off unless `NGP_PHASE_TIMINGS=<file>` is set, and it records these phases in wall-clock milliseconds:

| Phase | What it covers |
|---|---|
| Node start + load | process start until `main()` runs: Node bootstrap and module loading |
| Setup | config reading, analyzer construction, `HybridCompiler` construction |
| Waiting on analyzer | time the TypeScript backend spent blocked on the Rust analyzer's next chunk |
| prepareChunk | binding and cycle analysis per chunk, in TypeScript |
| Process files | reading, generating and writing every file, in TypeScript |
| Diagnostics writes | rewriting `.ngdiag.json` after each chunk |

The backend handles one chunk at a time, so these phases don't overlap and add up to ngp's wall time. "Waiting on analyzer" isn't the analyzer's CPU time, because the analyzer keeps working on its own threads while the backend generates code.

The ngc baselines get their breakdown from `angularCompilerOptions.tracePerformance`, and `ng build` from `NG_BUILD_DEBUG_PERF`. Phase runs are separate from the hyperfine runs, so instrumentation never touches the headline numbers. Each phase run also records peak RSS through `/usr/bin/time`.

## Corpus

**Generated apps** come from [corpus/generate.mjs](../corpus/generate.mjs), which writes a standard Angular CLI workspace from a component count and a seed. The same inputs always produce byte-identical files, and each workspace's `manifest.json` records a SHA-256 over them. The apps are all standalone, with no NgModules, because that's what a new Angular app looks like today.

| Size | Features | Shared components | Pipes and directives | `.ts` files | All files |
|---|---|---|---|---|---|
| 100 | 5 | 10 | 2 + 2 | 113 | 178 |
| 1,000 | 45 | 100 | 20 + 20 | 1,089 | 1,792 |
| 5,000 | 225 | 500 | 100 + 100 | 5,429 | 8,929 |

Each app is a router shell with one lazy route per feature. A feature holds a page, about 20 child components wired as an acyclic graph, and a root-provided signal store. Every child has the same signal inputs (`label`, `count`, `items`) and a `selected` output, so any parent can bind any child. The templates vary, with seeded shares: half use external `.html` files and a fifth external `.css`; they use control flow, `@let`, `@defer (on viewport)`, `@angular/common` pipes, and custom pipes and directives from a shared library; there's two-way binding to a `model()` input, host bindings, and `OnPush` on about 70% of components. Templates compile under `strictTemplates`, so a type error anywhere fails both compilers. Three sizes test hypothesis 1: a single large app can show ngp is faster without showing how the gap grows.

**Real apps** are pinned in [corpus/real/](../corpus/real/) and fetched by [corpus/fetch-real.mjs](../corpus/fetch-real.mjs), which pins every Angular package to `22.3.0-next.2`, the version the ngp toolchain is built from, and installs with the app's own lockfile.

| App | Commit | Kind | Source files | Components | Notes |
|---|---|---|---:|---:|---|
| [Super Productivity](https://github.com/johannesjo/super-productivity) | `65145cd` | Angular CLI, npm workspaces | 1,462 | 252 | `strictTemplates` off; doesn't type-check under TypeScript 7 on its own sources |
| [Ghostfolio](https://github.com/ghostfolio/ghostfolio) | `204f0d8` | Nx monorepo, app plus `libs/` | 521 | 157 | no `angular.json`, so R doesn't apply |
| [Bitwarden web vault](https://github.com/bitwarden/clients/tree/main/apps/web) | `8139eb0` | Nx monorepo, npm workspaces, `apps/web` plus `libs/` | 3,295 | 598 | `strictTemplates` on; built with webpack and `@ngtools/webpack`, so R doesn't apply; migration patch below |

All three install with `--legacy-peer-deps`, because libraries declare peer ranges like `^22.0.0` that npm says a prerelease doesn't satisfy, and with `--min-release-age=0`, because Super Productivity's `.npmrc` refuses packages younger than three days. Bitwarden also installs with `--ignore-scripts`, which skips Electron's binary download and the desktop app's Rust build; the web vault needs neither. S6 and S7 run on generated apps only: S6 picks its edits from the generated layout, and S7's boot check looks for the generated apps' markup.

Bitwarden is the one app here that isn't on Angular 22: its pinned commit uses Angular 21 and TypeScript 5.9. [corpus/real/bitwarden.patch](../corpus/real/bitwarden.patch) is the migration to Angular 22 and TypeScript 6 and nothing more, nine files: the CDK stepper's constructors lost their arguments; `DialogConfig.closeOnNavigation` now also takes strings; NG1054, new in 22, rejects an `@Output() toggledChange` beside a `model()` called `toggled`, which already provides that output, so the duplicate goes; `baseUrl` is deprecated (every alias is already relative to the tsconfig); `esModuleInterop` is on by default, so three `import * as JSZip` become default imports; and `types` defaults to `[]`, so the build tsconfig no longer pulls in the connectors' Jest specs. After it, ngc's full type-check reports nothing, with `strictTemplates` on. `tsgo` still reports two errors in `toggle-group.component.ts` on the app's own sources, which the report attributes to TypeScript 7, not to ngp.

**Golden cases.** Angular's own preprocessor golden tests aren't a performance corpus, but they show whether the locally built ngp produces the output Angular expects before any timing runs. `pnpm smoke` runs all of them on every engine.

## What gets measured

| Metric | Tool | Why |
|---|---|---|
| Wall time, median and p95 | `hyperfine` for whole processes, `performance.now()` for in-process phases and S6 | headline speed |
| CPU time, user plus system | `hyperfine` | shows parallel work that wall time hides |
| Parallelism, CPU over wall | derived | tests hypothesis 4 |
| Peak RSS | `/usr/bin/time -l` on macOS, `/usr/bin/time -v` on Linux | tests hypothesis 6 |
| Type errors, by code and location | both sides' output, mapped back to templates | diagnostics parity |

Each data point uses warm-up runs and measured runs, with outputs wiped before each. Full runs use 2 and 10. The report shows median and p95, and flags a result as noisy when its median absolute deviation exceeds 5% of its median.

## Correctness gates

Every pipeline must finish its job correctly before it's timed. A failed gate is recorded, and that pipeline isn't timed.

1. **It compiles.** ngp exits 0 with no diagnostics, and the engine that loaded is the one requested. On generated apps, ngp writes exactly one output and, with `--optimize`, one type-check block per source file, and esbuild turns each into JavaScript. On real apps the count can sit lower, because ngp skips type-only modules, so what must hold is that every follow-up step succeeds on what ngp wrote.
2. **The type-checker saw ngp's code.** For S3 and S4, `tsc --listFilesOnly` confirms the checker's program contains ngp's output. A clean result on zero files would otherwise look like a fast pass.
3. **Diagnostics are compared.** S3 and S4 map every error in a `.ngtypecheck.ts` file back to its template, using the type-check block's `TCB for <file>` header, its `_tcbN(this: Class)` function and the span comment after the error's position, and compare the result with ngc's errors. On generated apps both sides must be clean. On real apps a difference is a result: the run is timed, and the report lists every error ngp adds or misses, and which extra errors TypeScript 7 also reports on the app's own sources. The negative control in [corpus/check.mjs](../corpus/check.mjs) plants one template type error and passes only if ngc, `tsc` and `tsgo` all report it with the same code at the same file, line and column, for inline and external templates.
4. **It runs.** For S7, the build boots in headless Chrome. A deliberately broken bundle fails this check.
5. **Rebuilds are correct.** For S6, each compiler's incremental output matches a fresh build byte for byte.
6. **The input is unchanged.** Before and after timing, the app's files match the SHA-256 in its manifest, because `ngp --out` overwrites sources when its input path runs through a symlink.

Not implemented yet: comparing bundle sizes between ngc's and ngp's `--optimize` output.

## Environment

Every result file records the Angular commit, the `@angular/compiler-cli`, TypeScript, esbuild, Rust and hyperfine versions, the SHA-256 of `Cargo.lock`, each engine binary and each local patch, the engine that actually loaded, the CPU model, cores, memory and OS, the power source, the load average, and on CI the run, commit and runner image.

Published results come from GitHub Actions ([.github/workflows/bench.yml](../.github/workflows/bench.yml)), so anyone with access can see how a number was produced and rerun it. Each scenario runs as its own job on its own runner, and a final job merges the reports. Standard runners have 2 cores and a different CPU model each time, so a report compares ratios inside one scenario's section and names that section's machine. The generated apps and all compiler output live on a RAM disk (`/dev/shm`): on the runner's network disk, ngp waited on I/O for over a second of a 7-second run, and its medians varied by more than 5%. Real apps keep their `node_modules` on disk.

The native engine sizes its thread pool from `available_parallelism()` and has no override. On 2-core runners it has little room to show its parallelism; testing more cores means larger runners or Linux's `taskset`.

## Layout

```text
toolchain/   build ngp from a pinned Angular SHA: TS backend, native, wasm, sidecar; hyperfine
corpus/      generator, real-app pins and fetcher, the ngc/ngp compile check
harness/     runner, baselines, follow-up steps, S6 workers, boot check, statistics, report
results/     local smoke and run output (CI keeps its results as artifacts)
docs/        research, this methodology
```
