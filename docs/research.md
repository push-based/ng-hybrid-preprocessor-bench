# What ngp changes, and what it should make faster

Angular merged a second compiler into `main` on 8 October 2026, and nobody outside Google has a number for it yet. The Angular team says so too. Their September blog post answers "Is the new compiler faster?" with "It's too early to say", and they'll wait until they can benchmark a full Angular CLI build. This document collects what the source code and the team's own writing say about the new compiler, so the benchmark tests claims the code actually makes.

Research snapshot: Angular `main` at `92e5aa8` (14 October 2026), which is the commit behind `22.3.0-next.2`.

## Two compilers, one job

`ngc` is the compiler you use today. It is built on TypeScript's compiler API. It creates a `ts.Program`, uses the TypeScript type checker to read decorators and resolve references, generates type-check blocks for templates, and rewrites your classes through `ts.Transformer` while TypeScript emits JavaScript.

TypeScript 7 is a Go port of TypeScript, and that design can't work with it. Alex Rickabaugh of the Angular team wrote that the `ts.Transformer` API "is not available cross-language". Calling into Go from JavaScript would also cost a round trip for every AST query ngc makes.

`ngp`, the Angular Preprocessor, splits the work in two. For every input file it writes two TypeScript files:

| Output | Contents | Who consumes it |
|---|---|---|
| `dashboard.ng.ts` | Your code with `@Component`, `@Pipe` and the other decorators replaced by their compiled definitions | Any bundler or TypeScript, including esbuild |
| `dashboard.ngtypecheck.ts` | The type-check block (TCB): template expressions translated to TypeScript | TypeScript, which reports template type errors through source maps |

ngp does not type-check anything itself. Type-checking becomes an ordinary TypeScript run over the generated files, and that run can be TypeScript 7.

## Where the work runs now

The "hybrid" in the PR title describes the language split:

- **Frontend, in Rust.** The analyzer (`packages/compiler-cli/preprocessor/ng-analyze`) uses oxc 0.144 to parse, bind scopes, find decorated classes, evaluate decorator metadata across files, map NgModule scopes, and read `.d.ts` metadata from Angular Package Format libraries. It streams compilation chunks to the backend.
- **Backend, in TypeScript.** `HybridCompiler` (`src/hybrid_compiler.ts`, `src/processor.ts`) calls the existing `@angular/compiler` template pipeline to generate code, then splices it into your source with `magic-string`. The backend's only external dependencies are `@angular/compiler`, `@angular/compiler-cli`, `typescript` and `magic-string`.

The analyzer ships in three forms, and they are not equivalent:

| Engine | How it loads | Parallelism |
|---|---|---|
| Native | N-API addon (Cargo feature `napi`) | `futures::ThreadPool` sized to `available_parallelism()`, so every core |
| Wasm | `wasm-bindgen` build, target `nodejs` | Thread-local `LocalPool`, so one thread |
| Sidecar | `ng_analyze_bin`, a separate process speaking JSON-RPC over stdio | Native thread pool, plus serialization cost |

The loader tries native first and falls back to wasm. If you benchmark without forcing a backend, you can measure wasm by accident on a platform without a native build.

ngp also has two analysis modes:

- **Default** analyzes each file on its own, much like ngc's `compilationMode: 'experimental-local'`.
- **`--optimize`** adds a second stage that resolves class metadata and NgModule scopes across files. Only this mode writes `.ngtypecheck.ts` files. The blog post says these cross-file optimizations are required to keep non-standalone bundles small.

## What should get faster

Each claim below is a hypothesis the benchmark can confirm or refute. None is a measured result.

1. **Analysis should get much faster, and the gap should widen with project size.** ngc can't analyze a component until TypeScript has built a program and a type checker for the whole project. ngp's analyzer parses files in parallel with oxc and doesn't need a type checker. If this holds, analysis time grows more slowly with file count under ngp than under ngc.

2. **Code generation won't speed up much.** The template compiler is the same TypeScript code in both compilers. On template-heavy apps the TS backend should dominate ngp's time, which caps the overall speedup. The blog post points the same way: the team plans to move template compilation into Rust later, possibly by adapting VoidZero's `oxc-angular-compiler`.

3. **Type-checking is where TypeScript 7 pays off.** ngc type-checks templates inside its own TypeScript program and has to stay on TypeScript 6 (`@angular/compiler-cli` 22 requires `typescript >=6.0 <6.1`). ngp hands its TCB files to a separate TypeScript run, so that run could use `tsgo`. The Angular blog's own FAQ refers to TypeScript 7's "10x speedup". Whether `tsgo` accepts ngp's TCB output today is an open question, and the benchmark has to answer it before any timing means anything.

4. **The native engine should beat wasm by roughly the number of cores the analysis can use.** Wasm runs single-threaded, and the sidecar adds JSON serialization for every chunk. On a single-core runner the native and wasm gap should mostly disappear.

5. **Rebuilds after one edit should get cheaper.** The analyzer exposes `analyzeDelta` and `updateFileContent`, which return only the files whose analysis went stale. ngc's incremental mode still has to update a TypeScript program first.

6. **Peak memory should drop.** ngp's analysis doesn't hold a TypeScript type checker for the whole program. The TypeScript run that checks the TCB files does, so the saving may come back during type-checking.

## What changes besides speed

A faster compiler that emits different code isn't a faster version of the same compiler. These differences decide whether a timing comparison is fair:

- **Output shape.** ngc emits JavaScript. ngp emits TypeScript that still needs a transpiler. A fair comparison puts esbuild or `tsgo` after ngp, or compares ngp with an ngc run that does the same amount of work.
- **Diagnostics coverage.** Extended template diagnostics in the preprocessor were still an open PR (angular/angular#71316) at the research snapshot. ngc runs them by default. If you leave them on in the baseline, ngc does more work, and ngp looks faster than it is.
- **Type-check results.** The Angular team says a few rare cases surface new type errors with ngp's output, and they plan to document them as breaking changes. The benchmark should count diagnostics on both sides, not assume they match.
- **Maturity.** The source directory carries a "Prototype — External Contributions Not Accepted" notice. `22.3.0-next.2` alone carries fourteen `compiler-cli` fixes, most of them in the preprocessor, including HMR, imported `templateUrl` and core-package handling. Expect apps to fail to compile and record the failures as results.

## What you can't do yet

You can't `npm install` ngp. `@angular/compiler-cli@22.3.0-next.2` doesn't export `./preprocessor` or ship an `ngp` binary. The snapshot builds in `angular/compiler-cli-builds` don't either. The `ng-exp-compiler-arch-*` packages on npm are version `0.0.1` from August 2026, published from a private prototype repo. The `darwin-arm64` package is an 823-byte placeholder.

The `22.3.0-next` GitHub releases have no assets, and Angular's nightly `*-builds` repositories (`compiler-cli-builds`, `language-service-builds` and the rest) contain no preprocessor or engine files. The benchmark therefore has to build ngp from a pinned Angular commit. Because the TypeScript backend only imports public packages, it can be built without Bazel. This path worked at `92e5aa8`, and `toolchain/` in this repo automates it:

1. Compile `packages/compiler-cli/preprocessor/*.ts` with `tsc` against `@angular/compiler-cli@22.3.0-next.2`. That version is built from the same `92e5aa8` commit, so `private/hybrid_analysis` matches.
2. Build `ng-analyze` with Cargo three times: `--features napi` for the native addon, the `wasm32` target plus `wasm-bindgen` 0.2.121 for wasm, and the `ng_analyze_bin` binary for the sidecar.
3. Point the loader at each build through its `nativeBinding` and `wasmBinding` options, with `backend` forced so it can't fall back.

The native addon needs no napi-rs CLI: the `cdylib` Cargo builds with `--features napi`, renamed to `.node`, loads through `require()`. If this path breaks on a later commit, the fallback is Angular's own Bazel target `//packages/compiler-cli/preprocessor:main`, which builds only the wasm engine.

## Sources

- [angular/angular#71259](https://github.com/angular/angular/pull/71259), the integration PR, merged 8 October 2026
- [Angular releases](https://github.com/angular/angular/releases), especially `22.3.0-next.2`
- [An update on Angular's TypeScript 7-powered Compiler](https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a), Alex Rickabaugh and Mark Techson, 24 September 2026
- [How we made the Angular Compiler faster using AI](https://voidzero.dev/posts/oxc-angular-compiler), VoidZero, on the separate `oxc-angular-compiler`, which skips template type-checking
- [Ng-News 26/22](https://dev.to/playfulprogramming-angular/ng-news-2622-typescript-71-angular-native-and-polymorpheus-4ej2), on TypeScript 7.1's interop API and the missing transformer API
- Source files read: `preprocessor/main.ts`, `ngp.ts`, `api.ts`, `serve.ts`, `src/analyzer_loader.ts`, `src/hybrid_compiler.ts`, `ng-analyze/Cargo.toml`, `ng-analyze/src/compiler/analyzer.rs`, `ng-analyze/src/wasm.rs`, `ng-analyze/BUILD.bazel`
