# ng-hybrid-preprocessor-bench

Angular's new compiler, ngp, turns Angular source into JavaScript 1.3–3.6× faster than ngc, the compiler you use today, with a third to two thirds of its peak memory. But on a 2-core CI runner it doesn't yet make large apps type-check faster, even with TypeScript 7: at 5,000 components, ngp plus `tsgo` takes 37 s where ngc takes 28 s. This repo measures ngp against ngc on builds that do the same work, in CI, with every result checked for correctness before it's timed.

> **Status:** every scenario runs in CI on generated apps of 100, 1,000 and 5,000 components and on three real open-source apps. The numbers below come from one Angular commit (`92e5aa8`, the commit behind `22.3.0-next.2`) on GitHub's standard runners: 2-core ones for everything except Bitwarden, which ran later on 4 cores. ngp is a prototype, and these numbers describe that prototype.

## Results

Unless noted, every number comes from CI [run 38888167669](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/38888167669): 2 warm-up and 10 measured runs per pipeline, medians, a 6 GB heap limit for every Node process, generated apps and all output on a RAM disk. Each scenario ran on its own runner, and GitHub assigns each runner a different CPU, so compare ratios within a table, not seconds between tables. Every pipeline passed its correctness gates, and every app was byte-identical before and after its scenario. The full report, with phase breakdowns and per-section machines, is in the run's `bench-report` artifact.

"×" means ngc's time divided by ngp's: above 1× ngp's pipeline is faster, below 1× it's slower.

### What these numbers are, and what they aren't

They mostly time the **Angular compiler step**, not a full `ng build`. ngp isn't wired into the Angular CLI yet, so no `ng build` can use it, and the Angular team has said it won't publish numbers until it can compare full CLI builds. What this repo compares is each job ngp takes part in, one job per scenario, with both sides finishing the same job. The `ng build` reference at the end shows how much of a real build each job is.

### Compiler step: Angular source to JavaScript (S1, S2)

ngc emits JavaScript through its own API ([harness/ngc-transform.mjs](harness/ngc-transform.mjs)), the way the CLI does inside a build, without type-checking. ngp writes TypeScript, and esbuild turns it into JavaScript. S1 compiles each file on its own; S2 adds the cross-file analysis that keeps NgModule bundles small.

| App | Components | S1: ngc → ngp | S1 | S2: ngc → ngp | S2 | Peak memory (S2), ngc → ngp |
|---|---:|---|---:|---|---:|---:|
| generated | 100 | 2.79 → 1.14 s | **2.45×** | 3.64 → 1.53 s | **2.38×** | 423 → 242 MB |
| generated | 1,000 | 9.58 → 5.42 s | **1.77×** | 12.2 → 7.34 s | **1.66×** | 712 → 480 MB |
| generated | 5,000 | 31.7 → 22.3 s | **1.42×** | 42.6 → 32.1 s | **1.32×** | 2,089 → 1,273 MB |
| Super Productivity | 252 | 23.0 → 7.07 s | **3.25×** | 29.8 → 8.48 s | **3.51×** | 1,551 → 568 MB |
| Ghostfolio | 157 | 10.6 → 3.54 s | **2.98×** | 14.2 → 4.93 s | **2.87×** | 988 → 458 MB |
| Bitwarden ³ | 598 | 28.1 → 10.1 s | **2.79×** | 17.0 → 8.44 s | **2.01×** | 1,914 → 1,087 MB |

³ From [run 39463856365](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/39463856365), the Bitwarden web vault's only CI run so far. It ran after this repository went public, and GitHub gives public repositories standard runners with 4 cores and 16 GB, not the 2 cores and 8 GB of every other row. The same run timed the 100-component app on the same runners as a reference, and its ratios came out within 0.25× of the 2-core run's: S1 2.35× (2-core: 2.45×), S2 2.15× (2.38×), S4 1.81× (1.80×), S5 native 2.21× (2.40×), S8 2.21× (2.18×). As everywhere, each scenario ran on its own runner and CPU, so compare Bitwarden's ratios, not its seconds across tables.

On the generated apps, ngp's lead shrinks as the app grows, which is the opposite of what [hypothesis 1](docs/research.md#what-should-get-faster) predicted. The phase timings say why. At 5,000 components in S2, ngp waits on its Rust analyzer for 2.6 s, while its TypeScript backend, Angular's existing template compiler, spends 14.6 s generating code and 3.8 s in `prepareChunk`. That backend's cost grows with the number of files, and Rust doesn't touch it.

The real apps gain more, 2.0–3.6×, because their ngc time is dominated by TypeScript's own emit: 17.9 s of Super Productivity's 29.4 s, and 17.9 s of Bitwarden's 29.1 s in S1. On the ngp side, esbuild does that job, in 1.8 s and 2.4 s. Bitwarden, the largest real app, gains the least in S2 (2.01×): ngp spends 3.1 s in the backend's code generation, 1.8 s in `prepareChunk` and 1.1 s rewriting `.ngdiag.json`, against 0.8 s waiting on the analyzer.

### Type-checking templates and TypeScript (S3, S4)

ngc type-checks templates inside its own TypeScript 6 program. ngp writes the type-check blocks out as files, and a separate TypeScript run checks them along with everything else: `tsc` 6 (S3) or `tsgo` 7 (S4).

| App | Components | ngc | ngp + `tsc` 6 | × | ngp + `tsgo` 7 | × | Peak memory, ngc / ngp + `tsgo` |
|---|---:|---:|---:|---:|---:|---:|---:|
| generated | 100 | 2.65 s | 3.19 s | **0.83×** | 1.47 s | **1.80×** | 461 / 239 MB |
| generated | 1,000 | 8.64 s | 13.8 s | **0.63×** | 8.41 s | **1.03×** | 816 / 1,024 MB |
| generated | 5,000 | 27.8 s | 57.6 s | **0.48×** | 36.9 s | **0.75×** | 2,307 / 4,909 MB |
| Super Productivity ² | 252 | 25.8 s | 28.8 s | **0.90×** | 13.8 s | **1.87×** | 1,716 / 1,362 MB |
| Ghostfolio ² | 157 | 14.2 s | 14.6 s | **0.97×** | 6.96 s | **2.04×** | 1,224 / 537 MB |
| Bitwarden ³ | 598 | 18.9 s | 26.0 s | **0.72×** | 12.0 s | **1.57×** | 1,819 / 1,503 MB |

² From a separate S3 run, [run 38899025048](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/38899025048), where no result varied by more than 2.5%. In the full run, the real apps' ngp pipelines varied by 7–12% from run to run (Ghostfolio's `tsgo` pipeline anywhere from 6.9 s to 13.9 s) while ngc on the same runner stayed within 3%, so those numbers are left out. The rerun matches an earlier 3-run sample (1.85× and 2.06× with `tsgo`) and repeats the generated apps' ratios almost exactly: 1.75×, 1.05× and 0.75× with `tsgo`.

³ Bitwarden comes from [run 39463856365](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/39463856365), on a 4-core runner; see the note under S1 and S2.

TypeScript 7 roughly halves the type-check of ngp's output compared with TypeScript 6. That's enough for ngp to beat ngc on small apps, not on large ones: at 5,000 components, `tsgo` alone takes 18.6 s and ngp's pipeline peaks at 4.9 GB, against ngc's 2.3 GB. Bitwarden, the largest real app at 598 components and 3,295 files, lands in between: 1.57× with `tsgo` and 0.72× with `tsc` 6, even on 4 cores. ngc builds its type-check blocks in memory and checks them in the program it already has; ngp's route means a second, separate program over twice as many files, 5,429 outputs plus 5,429 type-check blocks. `tsgo` is multithreaded and these runners have 2 cores, so more cores should help it, and this repo hasn't measured that yet.

Diagnostics are compared too, after mapping each error in a type-check block back to its template location. On the generated apps both sides report nothing, and a planted error is reported by ngc, `tsc` and `tsgo` with the same code at the same line and column. On the real apps:

- **Ghostfolio:** ngp's type-check blocks report TS2774 ("This condition will always return true since this function is always defined") at `libs/ui/src/lib/page-tabs/page-tabs.component.html:13:12`, the line `@if (tab.onClick) {`. ngc doesn't. It's one of the rare new type errors the Angular team said ngp's output can surface.
- **Super Productivity:** `tsgo` reports two errors in `datetime-picker.component.ts` (TS18046, TS2769). It reports the same two on the app's own sources, before ngp is involved, so they're a TypeScript 7 migration issue in the app, not an ngp difference.
- **Bitwarden:** ngc reports nothing under `strictTemplates`, and ngp's type-check blocks report 34 errors, the same 34 from `tsc` and `tsgo`. Five come from a bug that writes text from the wrong file into a type-check block (see [Findings](#findings-beyond-speed)). The rest are places where ngp's blocks check more strictly than ngc's: 12 TS2344 and 5 TS2322 on generic components (`ChipFilterComponent<T>`, `NgIterable` inferred as `unknown`), 9 TS2367 where an `@if` narrowing is reapplied inside an event listener in the same block, 2 TS2341 on `private` `@HostListener` methods, and 1 TS2872 on `@if ({...})`, an object literal that's always truthy. `tsgo` also reports two TypeScript 7 errors in `toggle-group.component.ts` that it reports on the app's own sources too.

### Analyzer engines (S5)

The S2 job with each engine forced in turn: the native N-API addon, the single-threaded wasm build, and the sidecar, a separate native process that talks JSON over stdio.

| App | Components | ngc | native | wasm | sidecar | Peak memory, native / sidecar |
|---|---:|---:|---:|---:|---:|---:|
| generated | 100 | 3.48 s | 1.45 s (**2.40×**) | 1.87 s (**1.86×**) | 1.47 s (**2.36×**) | 240 / 217 MB |
| generated | 1,000 | 11.9 s | 7.22 s (**1.65×**) | 8.44 s (**1.41×**) | 7.26 s (**1.64×**) | 477 / 341 MB |
| generated | 5,000 | 44.4 s | 31.3 s (**1.42×**) | 40.3 s (**1.10×**) | 31.3 s (**1.42×**) | 1,268 / 641 MB |
| Super Productivity | 252 | 28.7 s | 8.03 s (**3.58×**) | 16.1 s (**1.79×**) | 8.07 s (**3.56×**) | 563 / 340 MB |
| Ghostfolio | 157 | 13.3 s | 4.56 s (**2.91×**) | 5.72 s (**2.32×**) | 4.55 s (**2.92×**) | 451 / 339 MB |
| Bitwarden ³ | 598 | 18.0 s | 8.67 s (**2.08×**) | 12.7 s (**1.42×**) | 8.20 s (**2.20×**) | 1,084 / 588 MB |

³ Bitwarden comes from [run 39463856365](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/39463856365), on a 4-core runner; see the note under S1 and S2.

wasm is still faster than ngc everywhere, but it gives up a lot: on Super Productivity it takes twice as long as native, and at 5,000 components the backend waits 9.1 s on it against 2.5 s for native. The sidecar is as fast as the in-process addon and needs the least memory of the three, because the analysis lives in a second process. On a 2-core runner, native's thread pool has little room to work, so this table understates the gap between native and wasm on a bigger machine.

### Rebuild after one edit (S6)

How long each compiler takes to bring its output up to date after one changed file, as in watch mode, in one long-running process each. Each edit's output is checked byte for byte against a fresh build; all of them matched.

| Components | Edit | ngc | ngp | × | Files ngc re-emitted | Files ngp regenerated |
|---:|---|---:|---:|---:|---:|---:|
| 100 | component class | 0.10 s | 0.06 s | **1.89×** | 2 | 6 |
| 100 | external template | 0.08 s | 0.05 s | **1.43×** | 1 | 6 |
| 100 | shared type | 0.05 s | 0.04 s | **1.19×** | 1 | 5 |
| 1,000 | component class | 0.26 s | 0.39 s | **0.68×** | 2 | 42 |
| 1,000 | external template | 0.24 s | 0.39 s | **0.62×** | 1 | 42 |
| 1,000 | shared type | 0.23 s | 0.37 s | **0.63×** | 1 | 41 |
| 5,000 | component class | 1.14 s | 2.05 s | **0.56×** | 2 | 202 |
| 5,000 | external template | 1.17 s | 2.06 s | **0.57×** | 1 | 202 |
| 5,000 | shared type | 1.11 s | 2.09 s | **0.53×** | 1 | 201 |

ngp wins the initial build, 1.5–2.9× like S2, then loses most rebuilds. Its analyzer marks every file that imports the edited one as stale, even for a template-only change, so a one-component edit regenerates 42 files at 1,000 components and 202 at 5,000. ngc re-emits one or two. This comparison gives ngc its best case: ngc saves its incremental state only after template type-checking, and S6 rebuilds without type-checking, so the harness saves that state after emit. Without it, every ngc rebuild would be a full compile.

### Development bundle (S7, indicative)

A development build that has to boot in headless Chrome. `ng build --configuration development --aot` against ngp plus an esbuild bundle with Angular's linker, and the same plus `tsgo`, because `ng build` also type-checks. Indicative only: the ngp pipeline skips stylesheet processing, budgets and asset handling, and runs its steps one after another where the CLI overlaps them.

| Components | `ng build` | ngp + bundle | × | ngp + bundle + `tsgo` | × |
|---:|---:|---:|---:|---:|---:|
| 100 | 5.82 s | 2.91 s | **2.00×** | 3.51 s | **1.66×** |
| 1,000 | 20.4 s | 8.80 s | **2.31×** | 12.9 s | **1.58×** |
| 5,000 | 76.4 s | 30.8 s | **2.48×** | 52.9 s | **1.44×** |

Every build booted, rendered its routes and logged no errors.

### The ViteConf 2026 comparison (S8)

At ViteConf 2026, Alex Rickabaugh reported about 13 s down to 4.5 s, "almost three times faster", for the whole compiler job: old ngc against ngp followed by TypeScript 7 ([talk notes](docs/research.md#what-the-angular-team-said-at-viteconf-2026)). He named neither the app nor the machine. S8 reproduces that job: ngc's full compile, every diagnostic and then emit, against `ngp --optimize` followed by one TypeScript run that type-checks ngp's output and emits JavaScript, with `tsgo` 7 and, for contrast, `tsc` 6. From [run 38899025048](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/38899025048), on one 2-core runner:

| App | Components | ngc | ngp + `tsgo` 7 | × | ngp + `tsc` 6 | × | Peak memory, ngc / ngp + `tsgo` |
|---|---:|---:|---:|---:|---:|---:|---:|
| generated | 100 | 4.63 s | 2.13 s | **2.18×** | 5.06 s | **0.92×** | 471 / 241 MB |
| generated | 1,000 | 16.9 s | 13.2 s | **1.28×** | 22.4 s | **0.75×** | 836 / 1,249 MB |
| generated | 5,000 | 62.1 s | 56.4 s | **1.10×** | 90.8 s | **0.68×** | 2,968 / 6,032 MB |
| Super Productivity | 252 | 34.6 s | 16.6 s | **2.09×** | 34.3 s | **1.01×** | 1,859 / 1,695 MB |
| Ghostfolio | 157 | 18.2 s | 7.56 s | **2.41×** | 18.2 s | **1.00×** | 1,320 / 668 MB |
| Bitwarden ³ | 598 | 33.8 s | 16.7 s | **2.03×** | 39.4 s | **0.86×** | 2,040 / 2,080 MB |

³ Bitwarden comes from [run 39463856365](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/39463856365), on a 4-core runner; see the note under S1 and S2.

On the three real apps, ngp plus TypeScript 7 does the whole compiler job 2.0–2.4× faster than ngc (Super Productivity and Ghostfolio on 2 cores, Bitwarden 2.03× on 4), in the range of his "almost three times" on a machine he didn't name. Nearly all of that comes from TypeScript 7: with `tsc` 6 the same pipeline only matches ngc. On the generated apps the gain shrinks with size, as in S4, and at 5,000 components ngp plus `tsgo` needs 6 GB, against ngc's 3 GB. Type errors differ from ngc's exactly as in S3: Ghostfolio's TS2774 in `page-tabs.component.html`, Super Productivity's two TypeScript 7 errors that its own sources have too, and Bitwarden's 34. Bitwarden's ngp pipeline also needs as much memory as ngc, 2.1 GB against 2.0 GB.

### A full `ng build`, for context (R)

No ngp column: this is a cold `ng build --aot`, split with the CLI's own phase timings, to show how much of a real build each job above is. The CLI bundles while it compiles, so phases overlap and the percentages don't add up to 100%. Ghostfolio has no `angular.json` and Bitwarden builds with webpack, not the CLI, so neither is here.

| App | Components | Development build | Angular compilation | Type-check | Production build |
|---|---:|---:|---:|---:|---:|
| generated | 100 | 5.86 s | 2.75 s (46%) | 2.08 s (35%) | 6.65 s |
| generated | 1,000 | 20.5 s | 9.77 s (47%) | 9.41 s (46%) | 22.0 s |
| generated | 5,000 | 77.0 s | 40.4 s (52%) | 35.4 s (46%) | 84.4 s |
| Super Productivity | 252 | 44.7 s | 33.8 s (75%) | 6.77 s (15%) | 60.5 s |

### What it adds up to

Angular compilation, the part ngp speeds up most, is about half of a development build on the generated apps and three quarters on Super Productivity. Type-checking is the other half on the generated apps, and that's the part ngp doesn't yet speed up at scale on these runners. So on a 2-core machine, today's ngp would shorten a small app's build a lot and a large generated app's build little, and its rebuilds after an edit would be slower than ngc's from 1,000 components up. For the whole compiler job (S8), the real apps come out 2.0–2.4× faster with TypeScript 7, close to what the Angular team showed. Two things this repo hasn't measured could change that picture: more cores, where both the native analyzer and `tsgo` are built to scale, and an ngp that runs inside the CLI in one process.

## Findings beyond speed

- **`ngp --out` can overwrite your sources.** If the path you give ngp runs through a symlink, such as macOS's `/var` → `/private/var`, the analyzer reports real paths, ngp computes output paths against the symlinked root, and the `..` segments land back on the input files. ngp then writes compiled code and source maps over your sources. The harness resolves real paths and checks every app against its hash.
- **ngp lowercases output paths on macOS and Windows.** `ngp.ts` lowercases paths there when computing where an output goes, so `dirtyDeepCopy.ts` comes out as `dirtydeepcopy.ts`. Imports still say `dirtyDeepCopy`, and with `forceConsistentCasingInFileNames` the type-check fails (TS1261). CI runs on Linux, where this doesn't happen.
- **ngp's output fails `noUnusedLocals` and `noUnusedParameters`.** Compiled templates have unused `ctx` parameters and type-check blocks have never-called `_tcbN` functions (TS6133). Both sides of the type-check comparison run with those checks off.
- **ngp's type-check blocks can report errors ngc doesn't.** Ghostfolio's `@if (tab.onClick)` gets TS2774 from ngp's blocks and nothing from ngc's.
- **ngp can copy an input's transform type from the wrong file.** Bitwarden's `InputPasswordComponent` declares `@Input({ transform: (val: string) => ... }) email`. In the type-check block of each component that binds `[email]`, ngp writes the transform's parameter type by slicing the *consuming* component's source at the offsets of `string` in the *declaring* file, so four blocks get `tepper`, `asswor`, `nseale` and `s.chan` where `string` belongs: TS2304 and TS2503. The output for the build itself is unaffected; only type-checking breaks.
- **ngp skips type-only modules.** Super Productivity's `electron/shared-with-frontend/get-dist-channel.ts` exports only types, and ngp writes no output for it.
- **ngp rewrites `.ngdiag.json` after every chunk.** The analyzer streams one file per chunk, so on the 5,000-component app ngp writes that file 5,429 times, 1.4 s of the run.
- **ngc's incremental state needs a type-check.** ngc saves the state that lets a rebuild skip unchanged files only after template type-checking. A transform-only rebuild loop is always a full compile.
- **ngc's full type-check of a large app doesn't fit Node's default heap on GitHub's standard runner.** On the 5,000-component app it aborts with "JavaScript heap out of memory" at a 2 GB heap and peaks at 2.7 GB with more room.
- **Template errors point at the type-check block.** Plain `tsc` and `tsgo` report a template error at its line in the `.ngtypecheck.ts` file. Mapping it back takes the block's header, its `_tcbN(this: Class)` function and the span comment after the error; [harness/lib/diagnostics.mjs](harness/lib/diagnostics.mjs) does that.

## What ngp is

ngp landed in [angular/angular#71259](https://github.com/angular/angular/pull/71259) on 8 October 2026. It replaces ngc's TypeScript-API frontend with a Rust analyzer built on [oxc](https://oxc.rs), and keeps Angular's existing template compiler, written in TypeScript, as the backend. For each source file it writes two plain TypeScript files: one with your decorators compiled, and one type-check block that TypeScript can check. TypeScript 7 can't support ngc's integration, and the Angular team built ngp so that Angular can run on it. [docs/research.md](docs/research.md) covers the architecture, the three analyzer engines, and why you can't `npm install` ngp yet.

## How the comparisons work

ngp on its own doesn't type-check or emit JavaScript, and ngc does both, so timing `ngp` against `ngc -p` would put half a build against a whole one. Every scenario defines a job first and times pipelines that each finish it. Both sides get the same compiler options, including extended diagnostics off until ngp implements them.

Speed without correctness means nothing for a prototype compiler, so every pipeline passes gates before it's timed: it compiles with no diagnostics, the requested engine actually loaded, the type-checker actually loaded ngp's files, builds boot in Chrome, incremental output matches a fresh build, and the app is unchanged afterwards. [docs/methodology.md](docs/methodology.md) has every scenario, gate and asymmetry.

## Running the benchmark

Results come from CI. [.github/workflows/bench.yml](.github/workflows/bench.yml) builds the toolchain, reruns the golden tests and the corpus checks, then runs each scenario as its own job and merges their reports. Pushes and pull requests run a small sample. For a full run, start the workflow from the Actions tab, or with the GitHub CLI:

```bash
gh workflow run bench.yml -f sizes=100,1000,5000 -f real=super-productivity,ghostfolio,bitwarden -f runs=10 -f warmup=2 -f phase_runs=3
```

`scenarios` picks a subset, for example `-f scenarios=S3`. The merged report goes to the job summary and the `bench-report` artifact. A full run takes about 1½ hours of wall time and 6½ runner-hours.

`pnpm bench` runs the same harness locally. Local runs are sanity checks only: on a laptop, an IDE or Spotlight indexing thousands of new files is enough to make results unusable.

## Building ngp

ngp isn't published anywhere you can install it from. `@angular/compiler-cli@22.3.0-next.2` has no `ngp` binary and no `./preprocessor` export, the `22.3.0-next` GitHub releases carry no assets, and none of Angular's nightly `*-builds` repositories contain the preprocessor or its engines. So this repo builds it from the Angular commit pinned in [toolchain/versions.env](toolchain/versions.env):

```bash
pnpm install
```

```bash
pnpm toolchain
```

`pnpm toolchain` runs these scripts in `toolchain/`, and you can rerun any of them on its own:

| Script | What it does |
|---|---|
| `fetch-angular.sh` | Sparse-fetches `Cargo.toml`, `Cargo.lock` and `packages/compiler-cli/preprocessor` at the pinned SHA |
| `setup-rust.sh` | Installs rustup, Rust and `wasm-bindgen-cli` into `toolchain/.cache/rust`, without touching your system Rust |
| `setup-tools.sh` | Builds hyperfine into `toolchain/.cache/tools` with that Rust |
| `build-backend.sh` | Compiles the TypeScript backend with `tsc` against the npm packages built from the same commit |
| `build-engines.sh` | Builds the analyzer three ways with Cargo: N-API addon, wasm module, sidecar binary |

The build needs no Bazel. Everything lands in `toolchain/out/`:

```text
toolchain/out/preprocessor/            ngp's TypeScript backend, including the ngp CLI (main.js)
toolchain/out/engines/native/          ng_analyze.node
toolchain/out/engines/wasm/            ng_analyze.js + ng_analyze_bg.wasm
toolchain/out/engines/sidecar/         ng_analyze_bin
```

Two local patches are applied to Angular's sources, both opt-in and neither touching how ngp compiles: [test-utils-engine-select.patch](toolchain/patches/test-utils-engine-select.patch) lets Angular's golden-test helpers pick an engine and read this repo's `node_modules`, and [ngp-phase-timings.patch](toolchain/patches/ngp-phase-timings.patch) records phase timings when `NGP_PHASE_TIMINGS` is set.

## Checking the build

```bash
pnpm smoke
```

This runs every golden case in Angular's preprocessor test suite through each engine, using Angular's own `runPipeline` and `compareOutputs` helpers. At `92e5aa8`, all 471 checks across 288 cases pass on the native, wasm and sidecar engines.

## The test apps

```bash
pnpm corpus --components 1000
```

```bash
pnpm corpus:check corpus/generated/standalone-1000-s1 --engine native,wasm,sidecar
```

The generator writes an all-standalone Angular CLI workspace to `corpus/generated/standalone-<n>-s<seed>`, byte-identical for the same size and seed, with lazy routes, signal inputs, control flow, `@defer`, pipes, directives and strict templates. The check compiles it with ngc, then runs `ngp --optimize` and type-checks ngp's output with `tsc` and `tsgo`. With `--negative-control` it plants one template type error and passes only if ngc, `tsc` and `tsgo` all report it with the same code at the same template location.

The real apps are pinned in [corpus/real/](corpus/real/):

```bash
node corpus/fetch-real.mjs super-productivity
```

It shallow-fetches the pinned commit into `corpus/real-apps/`, applies the pin's migration patch if it has one, pins every Angular package to `22.3.0-next.2`, installs, and writes a manifest. Then `--size real:super-productivity` benchmarks it. [Super Productivity](https://github.com/johannesjo/super-productivity) is an Angular CLI app with 252 components; [Ghostfolio](https://github.com/ghostfolio/ghostfolio) is an Nx monorepo with 157; [Bitwarden's web vault](https://github.com/bitwarden/clients/tree/main/apps/web), the app the Angular team is said to have tested ngp on most, is an Nx monorepo with 598 components across 3,295 source files. [docs/methodology.md](docs/methodology.md#corpus) explains the install flags and the Bitwarden patch.

## Requirements

- Node 24.21.0, pinned in [.nvmrc](.nvmrc). The Angular CLI refuses to run below 22.22.3, and ngp declares the same range.
- pnpm 10, `git`, `curl`, and a C toolchain for Cargo (Xcode command-line tools on macOS)
- Chrome, for S7's boot check (`CHROME_PATH` if it's somewhere unusual)
- Linux for core-scaling runs, because macOS can't pin a process to a set of cores

## Caveats

ngp is a prototype. Its source carries a notice that the Angular team isn't accepting issues or pull requests for it, and `22.3.0-next.2` alone contains fourteen compiler-cli fixes, most of them for ngp. These results describe one Angular commit on 2-core runners. Each report names the commit, the CPU and the runner image.
