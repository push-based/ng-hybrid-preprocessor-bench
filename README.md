# ng-hybrid-preprocessor-bench

Angular's new compiler, ngp, turns Angular source into JavaScript 1.5–3.9× faster than ngc, the compiler you use today, with a third to two thirds of its peak memory. With TypeScript 7 it type-checks the real apps here 1.6–2.3× faster, but not yet the largest generated app: on a 4-core CI runner, at 5,000 components, ngp plus `tsgo` takes 32 s where ngc takes 31 s. This repo measures ngp against ngc on builds that do the same work, in CI, with every result checked for correctness before it's timed.

> **Status:** every scenario runs in CI on generated apps of 100, 1,000 and 5,000 components and on three real open-source apps. The numbers below come from one CI run, at one Angular commit (`92e5aa8`, the commit behind `22.3.0-next.2`), on GitHub's standard 4-core runners. ngp is a prototype, and these numbers describe that prototype.

## Results

Every number comes from CI [run 39469262093](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/39469262093): 2 warm-up and 10 measured runs per pipeline, medians, a 6 GB heap limit for every Node process, generated apps and all output on a RAM disk. Each scenario ran on its own GitHub standard runner with 4 cores and 16 GB, and GitHub assigns each runner a different CPU, so compare ratios within a table, not seconds between tables. Every pipeline passed its correctness gates, every app was byte-identical before and after its scenario, and no pipeline's median absolute deviation went above 2.7% of its median. The full report, with phase breakdowns and per-section machines, is in the run's `bench-report` artifact.

"×" means ngc's time divided by ngp's: above 1× ngp's pipeline is faster, below 1× it's slower.

### What these numbers are, and what they aren't

They mostly time the **Angular compiler step**, not a full `ng build`. ngp isn't wired into the Angular CLI yet, so no `ng build` can use it, and the Angular team has said it won't publish numbers until it can compare full CLI builds. What this repo compares is each job ngp takes part in, one job per scenario, with both sides finishing the same job. The `ng build` reference at the end shows how much of a real build each job is.

### What changed from 2 cores to 4

Earlier versions of this README came from [run 38888167669](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/38888167669) and, for S3 and S8, [run 38899025048](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/38899025048), made while this repository was private, on standard runners with 2 cores and 8 GB. Public repositories get 4 cores and 16 GB. Twice the cores mostly helps the pipelines that end in `tsgo`, which is multithreaded: on 2 cores they used 1.4–1.7 of them, here 1.8–2.5.

| Pipeline | App | 2 cores | 4 cores |
|---|---|---:|---:|
| S4: ngp + `tsgo` type-check | 1,000 components | 1.03× | **1.24×** |
| S4: ngp + `tsgo` type-check | 5,000 components | 0.75× | **0.96×** |
| S4: ngp + `tsgo` type-check | Super Productivity | 1.87× | **2.18×** |
| S4: ngp + `tsgo` type-check | Ghostfolio | 2.04× | **2.30×** |
| S8: ngp + `tsgo` check and emit | 1,000 components | 1.28× | **1.59×** |
| S8: ngp + `tsgo` check and emit | 5,000 components | 1.10× | **1.50×** |
| S8: ngp + `tsgo` check and emit | Super Productivity | 2.09× | **2.65×** |
| S8: ngp + `tsgo` check and emit | Ghostfolio | 2.41× | **2.79×** |
| S7: ngp + bundle + `tsgo` | 5,000 components | 1.44× | **1.65×** |

The same pipelines with `tsc` 6, which is mostly single-threaded, barely moved: S3 at 5,000 components went from 0.48× to 0.52×. The compile-only pipelines (S1, S2, S5) moved by −0.26× to +0.44×: down a little at 100 components, up a little at 1,000 and 5,000, both ways on the real apps. Two 4-core runs of Bitwarden on different CPUs differ by 0.33× in S1 alone (2.79× in [run 39463856365](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/39463856365), 2.46× here), so for these pipelines the runner's CPU matters about as much as its cores. The native analyzer didn't pull further ahead of wasm either (S5). ngp's rebuilds after an edit lose by less than they did (S6), 0.81–0.93× at 1,000 components against 0.62–0.68× and 0.74–0.77× at 5,000 against 0.53–0.57×, though both sides rebuild on one thread, so one run per core count can't say why.

### Compiler step: Angular source to JavaScript (S1, S2)

ngc emits JavaScript through its own API ([harness/ngc-transform.mjs](harness/ngc-transform.mjs)), the way the CLI does inside a build, without type-checking. ngp writes TypeScript, and esbuild turns it into JavaScript. S1 compiles each file on its own; S2 adds the cross-file analysis that keeps NgModule bundles small.

| App | Components | S1: ngc → ngp | S1 | S2: ngc → ngp | S2 | Peak memory (S2), ngc → ngp |
|---|---:|---|---:|---|---:|---:|
| generated | 100 | 2.28 → 0.99 s | **2.29×** | 2.91 → 1.29 s | **2.26×** | 403 → 239 MB |
| generated | 1,000 | 7.99 → 4.42 s | **1.81×** | 10.4 → 5.75 s | **1.81×** | 703 → 475 MB |
| generated | 5,000 | 32.2 → 20.1 s | **1.60×** | 38.5 → 25.4 s | **1.51×** | 2,059 → 1,280 MB |
| Super Productivity | 252 | 21.0 → 5.68 s | **3.69×** | 24.8 → 6.41 s | **3.87×** | 1,551 → 565 MB |
| Ghostfolio | 157 | 8.91 → 2.96 s | **3.01×** | 10.9 → 3.65 s | **3.00×** | 1,208 → 456 MB |
| Bitwarden | 598 | 24.0 → 9.76 s | **2.46×** | 28.3 → 12.8 s | **2.21×** | 1,892 → 1,087 MB |

On the generated apps, ngp's lead shrinks as the app grows, from 2.26× at 100 components to 1.51× at 5,000 in S2, which is the opposite of what [hypothesis 1](docs/research.md#what-should-get-faster) predicted. The phase timings say why. At 5,000 components in S2, ngp waits on its Rust analyzer for 2.3 s, while its TypeScript backend, Angular's existing template compiler, spends 12.4 s generating code and 3.5 s in `prepareChunk`. That backend's cost grows with the number of files, and Rust doesn't touch it.

The real apps gain more, 2.2–3.9×, because their ngc time is dominated by TypeScript's own emit: 13.4 s of Super Productivity's 20.8 s, and 14.8 s of Bitwarden's 24.3 s in S1. On the ngp side, esbuild does that job, in 1.0 s and 2.1 s. Bitwarden, the largest real app, gains the least (2.46× in S1, 2.21× in S2): in S2, ngp spends 5.1 s in the backend's code generation, 2.1 s in `prepareChunk` and 1.2 s rewriting `.ngdiag.json`, against 1.3 s waiting on the analyzer.

### Type-checking templates and TypeScript (S3, S4)

ngc type-checks templates inside its own TypeScript 6 program. ngp writes the type-check blocks out as files, and a separate TypeScript run checks them along with everything else: `tsc` 6 (S3) or `tsgo` 7 (S4).

| App | Components | ngc | ngp + `tsc` 6 | × | ngp + `tsgo` 7 | × | Peak memory, ngc / ngp + `tsgo` |
|---|---:|---:|---:|---:|---:|---:|---:|
| generated | 100 | 2.65 s | 3.20 s | **0.83×** | 1.46 s | **1.82×** | 435 / 242 MB |
| generated | 1,000 | 8.89 s | 14.1 s | **0.63×** | 7.16 s | **1.24×** | 758 / 1,005 MB |
| generated | 5,000 | 30.8 s | 58.8 s | **0.52×** | 32.2 s | **0.96×** | 2,162 / 4,713 MB |
| Super Productivity | 252 | 20.5 s | 23.8 s | **0.86×** | 9.40 s | **2.18×** | 1,559 / 1,325 MB |
| Ghostfolio | 157 | 10.9 s | 10.9 s | **1.00×** | 4.73 s | **2.30×** | 1,325 / 531 MB |
| Bitwarden | 598 | 25.0 s | 31.7 s | **0.79×** | 15.3 s | **1.64×** | 1,823 / 1,503 MB |

TypeScript 7 roughly halves ngp's type-check pipeline compared with TypeScript 6, and the TypeScript step itself runs 3–6× faster. That's enough for ngp to beat ngc up to 1,000 components and on every real app, but not at 5,000 components: there, ngp's pipeline takes 32.2 s against ngc's 30.8 s and peaks at 4.7 GB against ngc's 2.2 GB. `tsgo` accounts for only 12.1 s of those 32.2 s; the rest is ngp itself, 12.6 s of it generating code. Bitwarden, the largest real app at 598 components and 3,295 files, lands in between: 1.64× with `tsgo` and 0.79× with `tsc` 6. ngc builds its type-check blocks in memory and checks them in the program it already has; ngp's route means a second, separate program over twice as many files, on the 5,000-component app 5,429 outputs plus 5,429 type-check blocks. Going from 2 to 4 cores moved the `tsgo` column, 0.75× to 0.96× at 5,000 components and 1.03× to 1.24× at 1,000, and left the `tsc` 6 column where it was.

Diagnostics are compared too, after mapping each error in a type-check block back to its template location. On the generated apps both sides report nothing, and a planted error is reported by ngc, `tsc` and `tsgo` with the same code at the same line and column. On the real apps:

- **Ghostfolio:** ngp's type-check blocks report TS2774 ("This condition will always return true since this function is always defined") at `libs/ui/src/lib/page-tabs/page-tabs.component.html:13:12`, the line `@if (tab.onClick) {`. ngc doesn't. It's one of the rare new type errors the Angular team said ngp's output can surface.
- **Super Productivity:** `tsgo` reports two errors in `datetime-picker.component.ts` (TS18046, TS2769). It reports the same two on the app's own sources, before ngp is involved, so they're a TypeScript 7 migration issue in the app, not an ngp difference.
- **Bitwarden:** ngc reports nothing under `strictTemplates`, and ngp's type-check blocks report 34 errors, the same 34 from `tsc` and `tsgo`. Five come from a bug that writes text from the wrong file into a type-check block (see [Findings](#findings-beyond-speed)). The rest are places where ngp's blocks check more strictly than ngc's: 12 TS2344 and 5 TS2322 on generic components (`ChipFilterComponent<T>`, `NgIterable` inferred as `unknown`), 9 TS2367 where an `@if` narrowing is reapplied inside an event listener in the same block, 2 TS2341 on `private` `@HostListener` methods, and 1 TS2872 on `@if ({...})`, an object literal that's always truthy. `tsgo` also reports two TypeScript 7 errors in `toggle-group.component.ts` that it reports on the app's own sources too.

### Analyzer engines (S5)

The S2 job with each engine forced in turn: the native N-API addon, the single-threaded wasm build, and the sidecar, a separate native process that talks JSON over stdio.

| App | Components | ngc | native | wasm | sidecar | Peak memory, native / sidecar |
|---|---:|---:|---:|---:|---:|---:|
| generated | 100 | 2.61 s | 1.22 s (**2.14×**) | 1.45 s (**1.80×**) | 1.20 s (**2.17×**) | 238 / 216 MB |
| generated | 1,000 | 9.89 s | 5.67 s (**1.74×**) | 6.50 s (**1.52×**) | 5.62 s (**1.76×**) | 476 / 343 MB |
| generated | 5,000 | 37.8 s | 24.8 s (**1.52×**) | 30.5 s (**1.24×**) | 24.3 s (**1.56×**) | 1,284 / 648 MB |
| Super Productivity | 252 | 23.0 s | 6.83 s (**3.37×**) | 12.6 s (**1.83×**) | 6.63 s (**3.48×**) | 581 / 341 MB |
| Ghostfolio | 157 | 9.90 s | 3.56 s (**2.78×**) | 4.42 s (**2.24×**) | 3.63 s (**2.72×**) | 459 / 363 MB |
| Bitwarden | 598 | 26.7 s | 12.8 s (**2.09×**) | 18.9 s (**1.41×**) | 12.8 s (**2.08×**) | 1,083 / 584 MB |

wasm is still faster than ngc everywhere, but it gives up a lot: on Super Productivity it takes nearly twice as long as native, and at 5,000 components the backend waits 5.9 s on it against 2.2 s for native. The sidecar is as fast as the in-process addon and needs the least memory of the three, because the analysis lives in a second process. Twice the cores didn't widen the gap between native and wasm: wasm took 1.29× as long as native at 5,000 components on 2 cores and 1.23× here, and 2.0× and 1.84× on Super Productivity. The native analyzer isn't what holds the pipeline back. At 5,000 components the backend waits 2.2 s on it and spends 12.8 s in its own single-threaded code generation, and the native pipelines use 1.2–1.6 of the 4 cores.

### Rebuild after one edit (S6)

How long each compiler takes to bring its output up to date after one changed file, as in watch mode, in one long-running process each. Each edit's output is checked byte for byte against a fresh build; all of them matched.

| Components | Edit | ngc | ngp | × | Files ngc re-emitted | Files ngp regenerated |
|---:|---|---:|---:|---:|---:|---:|
| 100 | component class | 0.06 s | 0.03 s | **2.14×** | 2 | 6 |
| 100 | external template | 0.04 s | 0.03 s | **1.57×** | 1 | 6 |
| 100 | shared type | 0.03 s | 0.02 s | **1.55×** | 1 | 5 |
| 1,000 | component class | 0.16 s | 0.18 s | **0.93×** | 2 | 42 |
| 1,000 | external template | 0.15 s | 0.18 s | **0.83×** | 1 | 42 |
| 1,000 | shared type | 0.15 s | 0.18 s | **0.81×** | 1 | 41 |
| 5,000 | component class | 0.73 s | 0.96 s | **0.77×** | 2 | 202 |
| 5,000 | external template | 0.73 s | 0.95 s | **0.77×** | 1 | 202 |
| 5,000 | shared type | 0.71 s | 0.96 s | **0.74×** | 1 | 201 |

ngp wins the initial build, 1.5–2.9× like S2, then loses every rebuild from 1,000 components up. Its analyzer marks every file that imports the edited one as stale, even for a template-only change, so a one-component edit regenerates 42 files at 1,000 components and 202 at 5,000. ngc re-emits one or two. This comparison gives ngc its best case: ngc saves its incremental state only after template type-checking, and S6 rebuilds without type-checking, so the harness saves that state after emit. Without it, every ngc rebuild would be a full compile.

### Development bundle (S7, indicative)

A development build that has to boot in headless Chrome. `ng build --configuration development --aot` against ngp plus an esbuild bundle with Angular's linker, and the same plus `tsgo`, because `ng build` also type-checks. Indicative only: the ngp pipeline skips stylesheet processing, budgets and asset handling, and runs its steps one after another where the CLI overlaps them.

| Components | `ng build` | ngp + bundle | × | ngp + bundle + `tsgo` | × |
|---:|---:|---:|---:|---:|---:|
| 100 | 3.21 s | 1.72 s | **1.87×** | 2.02 s | **1.59×** |
| 1,000 | 12.5 s | 5.08 s | **2.45×** | 7.16 s | **1.74×** |
| 5,000 | 51.2 s | 19.1 s | **2.68×** | 31.1 s | **1.65×** |

Every build booted, rendered its routes and logged no errors.

### The ViteConf 2026 comparison (S8)

At ViteConf 2026, Alex Rickabaugh reported about 13 s down to 4.5 s, "almost three times faster", for the whole compiler job: old ngc against ngp followed by TypeScript 7 ([talk notes](docs/research.md#what-the-angular-team-said-at-viteconf-2026)). He named neither the app nor the machine. S8 reproduces that job: ngc's full compile, every diagnostic and then emit, against `ngp --optimize` followed by one TypeScript run that type-checks ngp's output and emits JavaScript, with `tsgo` 7 and, for contrast, `tsc` 6.

| App | Components | ngc | ngp + `tsgo` 7 | × | ngp + `tsc` 6 | × | Peak memory, ngc / ngp + `tsgo` |
|---|---:|---:|---:|---:|---:|---:|---:|
| generated | 100 | 3.33 s | 1.56 s | **2.13×** | 3.67 s | **0.91×** | 455 / 238 MB |
| generated | 1,000 | 12.9 s | 8.10 s | **1.59×** | 18.0 s | **0.72×** | 863 / 1,279 MB |
| generated | 5,000 | 54.0 s | 36.0 s | **1.50×** | 77.8 s | **0.69×** | 2,576 / 6,092 MB |
| Super Productivity | 252 | 26.1 s | 9.83 s | **2.65×** | 26.7 s | **0.98×** | 1,716 / 1,671 MB |
| Ghostfolio | 157 | 13.1 s | 4.69 s | **2.79×** | 12.0 s | **1.09×** | 1,362 / 661 MB |
| Bitwarden | 598 | 34.2 s | 16.5 s | **2.07×** | 39.5 s | **0.87×** | 2,017 / 2,067 MB |

On the three real apps, ngp plus TypeScript 7 does the whole compiler job 2.1–2.8× faster than ngc, close to his "almost three times" on a machine he didn't name. Nearly all of that comes from TypeScript 7: with `tsc` 6 the same pipeline only matches ngc, 0.87–1.09×. On the generated apps the gain shrinks with size, as in S4, but stays above 1×: at 5,000 components it's 1.50× here against 0.96× in S4, because emit is part of this job, and ngc spends 22.8 s of its 53.4 s compiling and emitting while `tsgo` checks and emits in 15.4 s. That pipeline needs 6.1 GB, against ngc's 2.6 GB. Type errors differ from ngc's exactly as in S3: Ghostfolio's TS2774 in `page-tabs.component.html`, Super Productivity's two TypeScript 7 errors that its own sources have too, and Bitwarden's 34. Bitwarden's ngp pipeline also needs as much memory as ngc, 2.1 GB against 2.0 GB.

### A full `ng build`, for context (R)

No ngp column: this is a cold `ng build --aot`, split with the CLI's own phase timings, to show how much of a real build each job above is. The CLI bundles while it compiles, so phases overlap and the percentages don't add up to 100%. Ghostfolio has no `angular.json` and Bitwarden builds with webpack, not the CLI, so neither is here.

| App | Components | Development build | Angular compilation | Type-check | Production build |
|---|---:|---:|---:|---:|---:|
| generated | 100 | 4.07 s | 1.84 s (45%) | 1.27 s (31%) | 4.54 s |
| generated | 1,000 | 15.3 s | 7.45 s (48%) | 6.82 s (44%) | 15.6 s |
| generated | 5,000 | 61.9 s | 30.3 s (50%) | 27.5 s (46%) | 62.6 s |
| Super Productivity | 252 | 32.7 s | 26.2 s (79%) | 3.64 s (11%) | 41.6 s |

### What it adds up to

Angular compilation, the part ngp speeds up most, is about half of a development build on the generated apps and four fifths on Super Productivity. Type-checking is the other half on the generated apps, and that's where ngp's lead runs out at scale: with TypeScript 7 on 4 cores it type-checks 1,000 components 1.24× faster than ngc, and 5,000 components at 0.96×. So on a 4-core machine, today's ngp would shorten a small or mid-sized app's build a lot and a large generated app's build little, and its rebuilds after an edit would still be slower than ngc's from 1,000 components up. For the whole compiler job (S8), the real apps come out 2.1–2.8× faster with TypeScript 7, close to what the Angular team showed. Going from 2 to 4 cores helped consistently only where `tsgo` runs. Two things this repo hasn't measured could still change the picture: machines with more than 4 cores, and an ngp that runs inside the CLI in one process.

## Findings beyond speed

- **`ngp --out` can overwrite your sources.** If the path you give ngp runs through a symlink, such as macOS's `/var` → `/private/var`, the analyzer reports real paths, ngp computes output paths against the symlinked root, and the `..` segments land back on the input files. ngp then writes compiled code and source maps over your sources. The harness resolves real paths and checks every app against its hash.
- **ngp lowercases output paths on macOS and Windows.** `ngp.ts` lowercases paths there when computing where an output goes, so `dirtyDeepCopy.ts` comes out as `dirtydeepcopy.ts`. Imports still say `dirtyDeepCopy`, and with `forceConsistentCasingInFileNames` the type-check fails (TS1261). CI runs on Linux, where this doesn't happen.
- **ngp's output fails `noUnusedLocals` and `noUnusedParameters`.** Compiled templates have unused `ctx` parameters and type-check blocks have never-called `_tcbN` functions (TS6133). Both sides of the type-check comparison run with those checks off.
- **ngp's type-check blocks can report errors ngc doesn't.** Ghostfolio's `@if (tab.onClick)` gets TS2774 from ngp's blocks and nothing from ngc's.
- **ngp can copy an input's transform type from the wrong file.** Bitwarden's `InputPasswordComponent` declares `@Input({ transform: (val: string) => ... }) email`. In the type-check block of each component that binds `[email]`, ngp writes the transform's parameter type by slicing the *consuming* component's source at the offsets of `string` in the *declaring* file, so four blocks get `tepper`, `asswor`, `nseale` and `s.chan` where `string` belongs: TS2304 and TS2503. The output for the build itself is unaffected; only type-checking breaks.
- **ngp skips type-only modules.** Super Productivity's `electron/shared-with-frontend/get-dist-channel.ts` exports only types, and ngp writes no output for it.
- **ngp rewrites `.ngdiag.json` after every chunk.** The analyzer streams one file per chunk, so on the 5,000-component app ngp writes that file 5,429 times, 1.1 s of a 25 s run in S2.
- **ngc's incremental state needs a type-check.** ngc saves the state that lets a rebuild skip unchanged files only after template type-checking. A transform-only rebuild loop is always a full compile.
- **ngc's full type-check of a large app doesn't fit Node's default heap on GitHub's 2-core, 8 GB runner.** On the 5,000-component app it aborts with "JavaScript heap out of memory" at a 2 GB heap and peaks at 2.7 GB with more room.
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

`scenarios` picks a subset, for example `-f scenarios=S3`. The merged report goes to the job summary and the `bench-report` artifact. A full run takes about 2 hours of wall time and 8 runner-hours.

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

ngp is a prototype. Its source carries a notice that the Angular team isn't accepting issues or pull requests for it, and `22.3.0-next.2` alone contains fourteen compiler-cli fixes, most of them for ngp. These results describe one Angular commit on 4-core runners. Each report names the commit, the CPU and the runner image.
