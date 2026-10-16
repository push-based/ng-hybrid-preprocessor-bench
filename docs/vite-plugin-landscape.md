# Who else is building Angular on Vite or ngp

Appendix to [vite-plugin-investigation.md](vite-plugin-investigation.md). Research as of 16 October 2026, from read-only queries of public repos, npm and the Angular and VoidZero blogs.

**Short version:** nobody has a public Vite plugin built on ngp's `HybridCompiler`. The Angular CLI has reserved a slot for an on-demand per-file compiler inside its esbuild plugin, but the slot throws an error. ngp isn't on npm. Analog has nothing ngp-related. VoidZero's `@oxc-angular/vite` is a working Vite plugin, but on its own compiler, without template type-checking.

## Timeline, newest first

| Date | Event |
|---|---|
| 2026-10-16 | oxc-angular-compiler still being committed to (`7c840887`, #581). Not archived. https://github.com/voidzero-dev/oxc-angular-compiler |
| 2026-10-15 | Analog `3.0.0-alpha.94`. Analog commits since 1 October are about Nitro, SSR and Vitest; none touch ngp. |
| 2026-10-15 | angular-cli cuts v22.3.0-next.2 (`00c2509`) with no ngp code. |
| 2026-10-14 | Angular v22.3.0-next.2. Published `@angular/compiler-cli` exports `.`, `./linker`, `./linker/babel`, `./private/*`; no `./preprocessor`, no `ngp` bin. `private/hybrid_analysis` ships. No `@angular/preprocessor` or `@angular/ngp` on npm. |
| 2026-10-14 | angular #71364 marks the `@boundary` diagnostic a known ngp failure: the last preprocessor commit on `main` (`644d691a`). Open: #71343 (full-file goldens), #71316 (extended diagnostics). |
| 2026-10-14 | angular #71331 "implement HMR in preprocessor" (`d348fd88`): `src/hmr.ts`, `enableHmr`, `emitHmrUpdateModule`. Reuses `@angular/compiler`'s `compileHmrUpdateCallback`, so it speaks the same client protocol as ngtsc. |
| 2026-10-14 | angular #71280 cleanup: dead code removed, Bazel wasm and sidecar wired. |
| 2026-10-14 | `@oxc-angular/vite` 0.0.41, matching Angular 22.2.2 emit; peer `vite >=8.0.0`. |
| 2026-10-12 | angular #71283 "port preprocessor serve tool" (`d23ead8d`). |
| 2026-10-12 | angular #71313, "run some of our tests also against NGP"; the "synchronous WASM execution" commit (`4b6788f1`) landed inside it. |
| 2026-10-11 | Treaty (treatyjs/treaty, 18 stars) adds an opt-in bridge from its own Rust compiler to Angular's `ng-analyze` crate, with its own `@treaty/vite`. Doesn't use ngp's TS backend or type-check blocks. Self-reported, unverified. |
| 2026-10-10 | angular #71282: README says ngp is an "early-stage prototype" and the team isn't accepting outside issues or PRs. |
| 2026-10-08 | angular #71259 integrates the hybrid preprocessor into compiler-cli (`4e4ad751`). |
| 2026-09-30 | angular-cli adds a native library builder on Rolldown (`c5b8bf0`). Not ngp. |
| 2026-09-25 | Angular blog, "An update on Angular's TypeScript 7-powered Compiler": CLI build-system integration being prototyped, an experimental release "later this year". |
| 2026-09-08 | angular-cli #34043: type-check diagnostics no longer block esbuild's `onStart`. |
| 2026-08-14 | angular-cli #33862 "decouple compilation abstraction from TypeScript": `AngularCompilationResult`, `FileTransformResult`, an optional `transformFile?(filename, content)` hook, and a `'transform'` mode. When the hook exists, `createCompilerPlugin` skips the upfront emit and transforms per file in esbuild `onLoad`. |
| 2026-08-27 → 09-03 | angular-cli refactors isolating TypeScript behind a `TypeScriptCompilation` subclass: #33953, #33967, #33978, #33979, #34007. |
| 2026-07-14 → 08-04 | angular-cli moves Babel passes to oxc-parser and magic-string: #33568, #33601, #33625 (linker). |
| 2026-07-10 | On angular#69719, the CLI team says TS7 "lacks the necessary APIs to emit Angular code" and a dedicated team is building a new compilation model. |
| 2026-07-02 | Analog #2368 (oxc engine adapter for `fastCompile`) closed unmerged. |
| 2026-06-17 → 06-23 | angular-cli: Rolldown default chunk optimizer (#33397), Vite 8.0.16 (#33430), `optimizeDeps.rolldownOptions` (#33434), `AngularCompilationContext` (#33437). |
| 2026-04-10 | VoidZero launches oxc-angular-compiler as "an experiment for research purposes": no template type-checking, no cross-file optimizations. https://voidzero.dev/posts/oxc-angular-compiler |
| 2026-04-02 | Analog #2221 adds `@analogjs/angular-compiler`, the `fastCompile` engine. |

## How far the Angular CLI is from building with ngp

From code, not blog posts:

- `@angular/build` never imports `@angular/compiler-cli/preprocessor`, `HybridCompiler` or `createAnalyzer`.
- The slot exists and is empty. `factory.ts` on `main` has `if (mode === 'transform') { throw new Error('Transform compilation mode is not supported.'); }`, and a spec asserts that rejection.
- Missing: a `transformFile` backed by ngp, diagnostics through ngp's `.ngtypecheck.ts` files, HMR wiring to `emitHmrUpdateModule`, and a TypeScript 7 peer range (`@angular/build` still declares `typescript >=6.0 <6.1`).
- The intended shape: ngp as a per-file transform inside the existing esbuild `onLoad` plugin, with Vite serving.

## How `ng serve` uses Vite today

Files under `packages/angular/build/src/` at `angular-cli@00c25090`.

- **Vite doesn't transform application sources.** `builders/dev-server/vite/index.ts` runs the esbuild application builder and keeps its output in memory. `builders/dev-server/vite/server.ts` points Vite at a non-existent root (`.angular/vite-root/<project>`), sets `oxc: false`, `configFile: false` and `appType: 'custom'`. `tools/vite/plugins/angular-memory-plugin.ts` answers `resolveId` and `load` from esbuild's output.
- **Vite's real jobs:** middleware, the websocket, CSS HMR, dependency pre-bundling (with a linker transformer) and SSR module loading.

The component HMR protocol a new plugin must match:

- **Compile side:** `_enableHmr` (`compilation/compiler-options.ts` L146); `aot-compilation.ts` L264 calls `emitHmrUpdateModule(node)` per changed component; `build-action.ts` L381 yields a component-update result.
- **Server push:** `dev-server/vite/index.ts` ~L314 stores the update and sends `angular:component-update` with `{id, timestamp}`.
- **Endpoint:** `tools/vite/middlewares/component-middleware.ts` matches `pathname.includes('/@ng/component')`, reads `c`, returns the stored update or an empty body as `text/javascript` with `Cache-Control: no-cache`.
- **Client:** `compileHmrInitializer` in `@angular/compiler` (`r3_hmr_compiler.ts` L55–165) emits `id = encodeURIComponent(filePath + '@' + className)`, `import(ɵɵgetReplaceMetadataURL(id, t, import.meta.url))` and `import.meta.hot.on('angular:component-update', …)`. `ɵɵgetReplaceMetadataURL` (core `render3/hmr.ts` L66) builds `new URL('./@ng/component?c=<id>&t=<ts>', import.meta.url)`, so in an unbundled Vite graph requests arrive relative to each module, for example `/src/app/@ng/component?…`.
- **Failure path:** the runtime sends `angular:invalidate`; the CLI drops the update and sends `full-reload`.
- **Styles:** component CSS HMR uses Vite `css-update` messages with a `?ngcomp=<id>` query and needs `externalRuntimeStyles`.

## ngp on `main` (`92e5aa8`)

- No merged work after 14 October touches serving, Vite, esbuild, bundler integration, HMR or a public API.
- `serve.ts` is a demo: run ngp into `dist-ngp/`, copy `index.html`, one `esbuild.build` with the Babel linker, serve with `http.createServer`. No watch mode, no Vite, no HMR. It's excluded from the npm package.
- Packaging intent: `package.json` names it `@angular/compiler-cli/preprocessor`, version `0.0.0-PLACEHOLDER`, bin `ngp`, peer `typescript >=6.0 <6.1`. The only timeline is the blog's "later this year".

## Others

- **VoidZero `@oxc-angular/vite`:** not archived, 0.0.41, about 239 stars, maintained since July mainly by LongYinan and Ashley Hunter; the README now says "actively seeking maintainers". Its plugin (`napi/angular-compiler/vite-plugin/index.ts`, about 1,600 lines) does per-file Rust compiles in a pre-order `transform`, its own `@ng/component` middleware, `handleHotUpdate` sending `angular:component-update`, plus linker, JIT, build-optimizer, SSR-manifest and styles plugins. It skips template type-checking and cross-file optimizations.
- **Nx `@nx/angular-rspack`** (in the Nx repo since August 2025) depends on the Angular Compilation API. No ngp work.
- **rsbuild:** nothing Angular-specific in 2026.

## Any official Angular Vite plugin?

No public signal. The Angular blog talks about CLI build-system and language-service integration, plus a longer-term interest in "adapting oxc-angular-compiler's port of our template parsing and compilation engine" into ngp. VoidZero's posts (April launch, August and September recaps, Vite+ 1.0) announce no official Angular plugin. The vitejs/vite, angular/angular-cli and angular/angular repos have no related feature request or PR since January 2026.

Not verified: statements on X or Bluesky after 25 September.
