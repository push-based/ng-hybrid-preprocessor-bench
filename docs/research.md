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

## What the Angular team said at ViteConf 2026

Alex Rickabaugh, the Angular team's technical lead, presented ngp at [ViteConf 2026](https://youtu.be/PfyIEgLzNYI?t=32555) on 15 October 2026 (the talk runs from 9:02:35 to 9:22:05 of the stream). What follows is a summary in this repo's words, checked against the code where that's possible. The stream's auto-captions misspell several names; the corrected ones are Rickabaugh, ViteConf, Vite, Oxc, Boshen (Oxc's creator), Volar, napi-rs, Rolldown and NgModules.

**Why ngc is built the way it is** ([9:06:48](https://youtu.be/PfyIEgLzNYI?t=32808)). ngc was designed in 2016 to see the whole program: every file and every dependency. That makes build time grow with project size, and it makes ngc depend on a full TypeScript build. He lists the limitations Angular removed one release at a time: compiling libraries together with apps (gone in Angular 4), the runtime's reliance on the compiler's pre-work (Ivy, Angular 9), NgModules (standalone components, Angular 14), and whole-program analysis (experimental local compilation, Angular 16; the `experimental-local` mode landed in angular/angular#49846 in April 2023). The last one is the S1 baseline here.

**Why a preprocessor** ([9:10:20](https://youtu.be/PfyIEgLzNYI?t=33020)). ngc was meant as a drop-in replacement for `tsc`, but build tools stopped running TypeScript in the critical path, so Angular has been hard to integrate. The preprocessor compiles only the Angular parts, writes TypeScript with decorators replaced by runtime code plus a separate output for type-checking, and leaves type-checking off the edit-refresh path. Any bundler can take its output. TypeScript 7 turned this from a backlog idea into a necessity, because it has no transform API and ngc is built on one.

**Why the split falls where it does** ([9:14:55](https://youtu.be/PfyIEgLzNYI?t=33295)). Porting Angular's template code generator to another language would be a large job: it carries a decade of edge cases, internationalization and bugs that apps depend on, and it also runs in browsers for just-in-time compilation. His observation is that the code generator is already fast and works one file at a time, while the front end, which parses the whole app, finds decorators, traces references and evaluates constants, is where the complexity and the time are. So only the front end moved to Rust. They chose Rust because of Oxc, which he describes as stable, well maintained and fast.

**How the analyzer works** ([9:16:33](https://youtu.be/PfyIEgLzNYI?t=33393)). The analyzer, `ng-analyze`, reads the tsconfig and hands the Node-based code generator only the metadata it needs, including the source offsets to replace, so the generator never parses TypeScript. It answers queries and, when a file changes, invalidates only the queries whose answers could change. It has single-file and whole-program modes, runs multithreaded on Rust futures, and streams results so files are written while it is still parsing. All of this matches the source read for this repo; the streaming is what the "Waiting on analyzer" phase measures.

**Three ways to load it** ([9:18:36](https://youtu.be/PfyIEgLzNYI?t=33516)): a native Node module through napi-rs for the best performance, WebAssembly where no native build exists or in a browser playground, and at Google a separate process over JSON-RPC, the sidecar. S5 compares the three.

**The numbers he showed** ([9:19:29](https://youtu.be/PfyIEgLzNYI?t=33569)). For the compiler step alone, old ngc against the preprocessor followed by TypeScript 7, he reported about 13 s down to 4.5 s, "almost three times faster": about 3 s of Angular processing and 1.5 s of TypeScript 7 type-checking and emit. He named neither the app nor the machine, said the compiler isn't finished, and said they have barely optimized it. The team is testing it on every Angular app at Google, checking output against golden tests and against what ngc emitted before.

### His claims, and where this repo tests them

| Claim | Tested by | What this repo found |
|---|---|---|
| ngp plus TypeScript 7 is almost 3× faster than ngc for the whole compiler job | S8, which reproduces the comparison: `ngc` full compile against `ngp --optimize` then `tsgo` type-check and emit | first local run, Ghostfolio: 6.6 s against 2.3 s, 2.9×. CI numbers pending. |
| The code generator is fast; the front end is where the time goes | phase timings in S1, S2, S3 and S5 | true of ngc. Inside ngp, the Node code generator now dominates: on Super Productivity, ngp waits on the analyzer for 0.3–0.8 s and spends 3–4 s generating code |
| Type-checking leaves the edit-refresh path | S7 times a development bundle with and without `tsgo` | `tsgo` adds about 0.5 s to the 100-component bundle |
| The analyzer invalidates only what a change affects | S6 | correct output after every edit, but ngp regenerates every file that imports the edited one (6 files at 100 components; 42 at 1,000 in a local run) where ngc re-emits 1–2 |
| Native, wasm and sidecar share one engine | S5 | all three pass the same gates with the same file counts; wasm is 1.2–2× slower than native, the sidecar matches native |

## Sources

- [angular/angular#71259](https://github.com/angular/angular/pull/71259), the integration PR, merged 8 October 2026
- [Angular releases](https://github.com/angular/angular/releases), especially `22.3.0-next.2`
- [An update on Angular's TypeScript 7-powered Compiler](https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a), Alex Rickabaugh and Mark Techson, 24 September 2026
- [How we made the Angular Compiler faster using AI](https://voidzero.dev/posts/oxc-angular-compiler), VoidZero, on the separate `oxc-angular-compiler`, which skips template type-checking
- [ViteConf 2026 stream](https://youtu.be/PfyIEgLzNYI?t=32555), Alex Rickabaugh's talk on ngp, 9:02:35–9:22:05, 15 October 2026
- [Ng-News 26/22](https://dev.to/playfulprogramming-angular/ng-news-2622-typescript-71-angular-native-and-polymorpheus-4ej2), on TypeScript 7.1's interop API and the missing transformer API
- Source files read: `preprocessor/main.ts`, `ngp.ts`, `api.ts`, `serve.ts`, `src/analyzer_loader.ts`, `src/hybrid_compiler.ts`, `ng-analyze/Cargo.toml`, `ng-analyze/src/compiler/analyzer.rs`, `ng-analyze/src/wasm.rs`, `ng-analyze/BUILD.bazel`
