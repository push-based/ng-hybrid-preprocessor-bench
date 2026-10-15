# ng-hybrid-preprocessor-bench

Angular has a second compiler on `main`, and the Angular team hasn't published a single number for it. This repo measures ngp, the new Rust-and-TypeScript preprocessor, against ngc, the compiler you use today, on builds that do the same amount of work.

> **Status: ngp builds, passes Angular's golden tests, and compiles the generated 100, 1,000 and 5,000-component apps. The benchmark harness isn't built.** There are no timing results yet.

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

One difference showed up already. ngc reports a template type error in the template, such as `f0-c01.html:9:41`. ngp plus `tsc` reports it at line 34 of `f0-c01.ngtypecheck.ts`, because `tsc` doesn't map type-check blocks back to templates.

## Requirements

- Node 24.21.0, pinned in [.nvmrc](.nvmrc). The Angular CLI refuses to run below 22.22.3, and ngp declares the same range.
- pnpm 10, `git`, `curl`, and a C toolchain for Cargo (Xcode command-line tools on macOS)
- For the benchmark, once it exists: [hyperfine](https://github.com/sharkdp/hyperfine), and Linux for core-scaling runs, because macOS can't pin a process to a set of cores

## Caveats

ngp is a prototype. Its source carries a notice that the Angular team isn't accepting issues or pull requests for it, and `22.3.0-next.2` alone contains fourteen compiler-cli fixes, most of them for ngp. Results from this repo describe one Angular commit on one machine. Each result file names both.
