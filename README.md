# ng-hybrid-preprocessor-bench

Angular has a second compiler on `main`, and the Angular team hasn't published a single number for it. This repo measures ngp, the new Rust-and-TypeScript preprocessor, against ngc, the compiler you use today, on builds that do the same amount of work.

> **Status: the transform-only scenarios (S1, S2) run in CI.** Type-checking, engine and rebuild scenarios are next. [Results so far](#results-so-far).

## What ngp is

ngp landed in [angular/angular#71259](https://github.com/angular/angular/pull/71259) on 8 October 2026. The `22.3.0-next.2` changelog lists fixes to it, but the npm packages don't include it yet. It replaces ngc's TypeScript-API frontend with a Rust analyzer built on [oxc](https://oxc.rs), and keeps Angular's existing template compiler, written in TypeScript, as the backend. For each source file it writes two plain TypeScript files: one with your decorators compiled, and one type-check block that TypeScript can check. TypeScript 7 can't support ngc's integration, and the Angular team built ngp so that Angular can run on it.

[docs/research.md](docs/research.md) covers the architecture, the three analyzer engines, and why you can't `npm install` ngp yet.

## What this repo will measure

The Angular team's [blog post](https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a) declines to say whether ngp is faster until the full CLI build can be compared. This bench answers narrower questions now, one per scenario:

- Does analysis in Rust scale better with project size than analysis through TypeScript's type checker?
- How much of ngp's time is still spent in the TypeScript backend?
- Does pairing ngp with `tsgo` (TypeScript 7) type-check templates faster than ngc on TypeScript 6?
- How much does the single-threaded wasm engine give up against the native one?
- Is a rebuild after a one-file edit faster?

Each question maps to a scenario in [docs/methodology.md](docs/methodology.md), with the baseline it's compared against, the corpus, the metrics, and the correctness gates a run has to pass before its timing counts.

## Why the comparisons are built this way

ngp on its own doesn't type-check or emit JavaScript, and ngc does both. Timing `ngp` against `ngc -p` would put half a build up against a whole one. Every scenario therefore defines a job first, for example "type-check every template", and times two pipelines that each finish it. ngc gets the same compiler options as ngp, including extended diagnostics switched off until ngp implements them.

Speed without correctness means nothing for a prototype compiler. A run that fails to compile, emits different diagnostics, or produces a bigger bundle gets reported as such, next to the timings.

## Building ngp

ngp isn't published anywhere you can install it from. `@angular/compiler-cli@22.3.0-next.2` has no `ngp` binary and no `./preprocessor` export, the `22.3.0-next` GitHub releases carry no assets, and none of Angular's nightly `*-builds` repositories contain the preprocessor or its engines. So this repo builds it from the Angular commit pinned in [toolchain/versions.env](toolchain/versions.env):

```bash
pnpm install
```

```bash
pnpm toolchain
```

`pnpm toolchain` runs four scripts in `toolchain/`, and you can rerun any of them on its own:

| Script | What it does |
|---|---|
| `fetch-angular.sh` | Sparse-fetches `Cargo.toml`, `Cargo.lock` and `packages/compiler-cli/preprocessor` at the pinned SHA |
| `setup-rust.sh` | Installs rustup, Rust and `wasm-bindgen-cli` into `toolchain/.cache/rust`, without touching your system Rust |
| `build-backend.sh` | Compiles the TypeScript backend with `tsc` against the npm packages built from the same commit |
| `build-engines.sh` | Builds the analyzer three ways with Cargo: N-API addon, wasm module, sidecar binary |

The build needs no Bazel. On an M-series MacBook the engines take about 75 seconds after the first Rust install, and `toolchain/.cache` grows to about 1 GB. Everything lands in `toolchain/out/`:

```text
toolchain/out/preprocessor/            ngp's TypeScript backend, including the ngp CLI (main.js)
toolchain/out/engines/native/          ng_analyze.node
toolchain/out/engines/wasm/            ng_analyze.js + ng_analyze_bg.wasm
toolchain/out/engines/sidecar/         ng_analyze_bin
```

One local change is applied to Angular's sources: [toolchain/patches/test-utils-engine-select.patch](toolchain/patches/test-utils-engine-select.patch). It lets Angular's golden-test helpers pick the native or sidecar engine and read `@angular/*` from this repo's `node_modules`, because upstream they're hard-wired to Bazel's layout and the wasm engine. ngp's compiler code is unchanged.

## Checking the build

```bash
pnpm smoke
```

This runs every golden case in Angular's preprocessor test suite through each engine, using Angular's own `runPipeline` and `compareOutputs` helpers. Results go to `results/smoke/golden.json`.

At `92e5aa8`, all 471 checks across 288 cases pass on the native, wasm and sidecar engines. Two controls back that up. With `NG_EXP_DEBUG_LOADER=1`, the loader log shows each engine loading from `toolchain/out/` with no fallback. When the analyzer can't see the `@angular` packages, 3 optimize-mode cases fail, so the comparison catches changed output.

The golden cases are tiny, and the timing it prints says nothing about performance.

## Generating the test apps

```bash
pnpm corpus --components 1000
```

```bash
pnpm corpus:check corpus/generated/standalone-1000-s1 --engine native,wasm,sidecar
```

The generator writes an all-standalone Angular CLI workspace to `corpus/generated/standalone-<n>-s<seed>`. A workspace has an `angular.json`, strict tsconfigs and lazy routes, and `ng build` builds it. It has no `node_modules` of its own and resolves packages from this repo's root. Pass `--seed` for a different app of the same size. [docs/methodology.md](docs/methodology.md#corpus) describes what goes into the templates.

The check compiles the workspace with `ngc`, then runs `ngp --optimize` and type-checks ngp's output with `tsc`. Add `--negative-control` to plant one template type error, and the check passes only if every pipeline rejects it. Results are appended to `results/smoke/corpus.json`.

At `92e5aa8`, all three sizes compile with zero errors on ngc and on ngp with every engine, and both negative controls are caught. The check's timings come from one run each, so treat them as orientation, not results.

## Running the benchmark

Results come from CI. [.github/workflows/bench.yml](.github/workflows/bench.yml) builds the toolchain, reruns the golden tests and the corpus checks, then benchmarks. Pushes and pull requests run a small sample: 100 components, 5 measured runs. For a full run, start the workflow by hand from the Actions tab, or with the GitHub CLI:

```bash
gh workflow run bench.yml -f sizes=100,1000,5000 -f runs=10 -f warmup=2 -f phase_runs=3
```

Each run puts its report in the job summary and uploads the raw data as the `bench-results` artifact. The harness, [harness/run.mjs](harness/run.mjs), does three things per scenario and size:

1. A correctness gate: both pipelines emit one file per source file, ngp reports no diagnostics, the requested engine actually loaded, and the app's files still match the generator's hash.
2. hyperfine runs of both pipelines, with output wiped before each run.
3. Instrumented runs that break ngp's and ngc's time into phases and record peak memory.

In CI, the generated apps and all compiler output live on a RAM disk (`/dev/shm`). On the runner's network disk, ngp spent over a second of a 7-second run waiting on I/O, because it writes more files than ngc, and its medians varied by more than 5%. On the RAM disk, the median absolute deviation is 0.7–1.4% for ngp and under 1% for ngc.

`pnpm bench` runs the same harness locally. Local runs are sanity checks only: on a laptop, an IDE or Spotlight indexing thousands of new files was enough to make results unusable.

## Results so far

### What these numbers are, and what they aren't

They time the **Angular compiler step**, not a full `ng build`. ngp isn't wired into the Angular CLI yet, so no `ng build` can use it, and the Angular team has said it won't publish numbers until it can compare full CLI builds. What this repo can compare now is the one step ngp replaces: turning Angular source into JavaScript.

- **ngc side**: [harness/ngc-transform.mjs](harness/ngc-transform.mjs) drives ngc's own API the way the CLI does inside a build: create the TypeScript program, analyze Angular decorators, emit JavaScript.
- **ngp side**: ngp, then esbuild to turn its TypeScript output into JavaScript.
- **Not included on either side**: type-checking, bundling, stylesheets, minification, `index.html` and assets.

So "1.5× faster" means the compiler step is 1.5× faster. How much that shortens a real build depends on how much of the build that step is, which is what the `ng build` reference (R) measures. R is in every CI run from now on; [TK: R results from the next full run].

### Compiler step

From [run 38725798376](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/38725798376): GitHub's standard runner (2 cores, AMD EPYC 9V45, 8 GB), Angular `92e5aa8`, native engine, 2 warm-up and 10 measured runs, compiler output on a RAM disk. Times are medians.

| Scenario | Components | ngc | ngp + esbuild | ngc ÷ ngp | Peak memory, ngc → ngp |
|---|---:|---:|---:|---:|---:|
| S1, transform only | 100 | 2.31 s | 0.94 s | 2.45× | 435 → 228 MB |
| S1, transform only | 1,000 | 7.64 s | 4.80 s | 1.59× | 701 → 405 MB |
| S1, transform only | 5,000 | 26.3 s | 17.9 s | 1.48× | 1,660 → 929 MB |
| S2, with cross-file optimization | 100 | 2.44 s | 1.04 s | 2.34× | 452 → 243 MB |
| S2, with cross-file optimization | 1,000 | 7.85 s | 4.96 s | 1.58× | 721 → 477 MB |
| S2, with cross-file optimization | 5,000 | no result | | | |

S2 at 5,000 components has no result because ngc ran out of memory during the untimed correctness check, which includes its full template type-check. Node's default heap on this 8 GB runner is about 2 GB, and the check needs 2.7 GB. Every Node process now gets the same 6 GB limit, on both sides, and the next full run fills this row.

Run-to-run variation stayed at or below 2.1% for every result, and each app was unchanged after its scenario. GitHub assigns a different CPU model to each run, so compare ratios, not seconds, across runs.

ngp's lead shrinks as the app grows, which is the opposite of what [hypothesis 1](docs/research.md#what-should-get-faster) predicted. Its phase timings say where the time goes. At 5,000 components, ngp's TypeScript backend spends 8.4 s generating code and 2.3 s in `prepareChunk`, while it waits on the Rust analyzer for 1.2 s. esbuild adds another 5.7 s. That backend is Angular's existing template compiler, and its cost grows with the number of files. ngc's fixed costs, like building the TypeScript program, get spread over more files as the app grows. This runner has 2 cores, so the native analyzer, which uses every core, has little room to show its parallelism.

## Findings beyond speed

- **`ngp --out` can overwrite your sources.** If the path you give ngp runs through a symlink, such as macOS's `/var` → `/private/var`, the analyzer reports real paths and ngp computes output paths against the symlinked root. The `..` segments resolve back onto the input files, which ngp then overwrites. The harness resolves real paths and checks each app against its hash before and after timing.
- **Template errors point at the type-check block.** ngc reports a template type error at its place in the template, such as `f0-c01.html:9:41`. ngp plus `tsc` reports it at line 34 of `f0-c01.ngtypecheck.ts`, because `tsc` doesn't map type-check blocks back to templates.
- **ngc's full type-check of a large app doesn't fit Node's default heap on GitHub's standard runner.** On the 5,000-component app it aborts with "JavaScript heap out of memory" at a 2 GB heap and peaks at 2.7 GB with more room. This affects ngc, not ngp, but it's what a team with an app this size would hit in CI.
- **ngp rewrites `.ngdiag.json` after every chunk.** The analyzer streams one file per chunk, so on the 1,000-component app ngp writes that file 1,089 times. That's 160 ms on a RAM disk and 370 ms on the runner's disk.

## Requirements

- Node 24.21.0, pinned in [.nvmrc](.nvmrc). The Angular CLI refuses to run below 22.22.3, and ngp declares the same range.
- pnpm 10, `git`, `curl`, and a C toolchain for Cargo (Xcode command-line tools on macOS). hyperfine 1.20.0 is built locally by `pnpm toolchain`.
- Linux for core-scaling runs, because macOS can't pin a process to a set of cores.

## Caveats

ngp is a prototype. Its source carries a notice that the Angular team isn't accepting issues or pull requests for it, and `22.3.0-next.2` alone contains fourteen compiler-cli fixes, most of them for ngp. Results from this repo describe one Angular commit on one kind of machine. GitHub assigns a different CPU model to each run, so compare ratios within a run, not absolute times across runs. Each report names the commit, the CPU and the runner image.
