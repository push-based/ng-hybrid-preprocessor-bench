# A Vite-native Angular plugin on ngp: investigation

Nobody has built a Vite plugin on ngp yet, and the Angular CLI isn't building one either. ngp's API can compile Angular the way Vite expects: one module at a time, from the code Vite hands over, with output byte-identical to a full build. A plugin built on it could drop most of the workarounds in `@analogjs/vite-plugin-angular`. Two conditions apply. The plugin has to use ngp's optimize mode and skip the whole-program delta pass the CLI path runs. And it has to work around one analyzer inefficiency that makes every edit cost time proportional to the project's size.

This page is for deciding whether to build that plugin. It covers who else is close, what Analog does today and why, what ngp's API actually does under a dev-server workload, what a plugin would still have to build itself, and the risks.

Snapshot: 16 October 2026. Angular `main` at `92e5aa8` (`22.3.0-next.2`), `@analogjs/vite-plugin-angular` 2.8.1 at `58a9df6`, `angular-cli` at `00c2509`.

## Where the race stands

| Who | Working code | Uses ngp? | Vite transforms your source modules? |
|---|---|---|---|
| Angular team | ngp, HMR codegen (angular/angular#71331, 14 Oct), language-service prototype, a one-shot esbuild demo (`serve.ts`) | yes | no Vite integration |
| Angular CLI | a per-file `transformFile` hook in its esbuild plugin (angular/angular-cli#33862, 14 Aug). The `'transform'` mode that would use it throws `Transform compilation mode is not supported.` | no code yet | no: `ng serve` runs esbuild and serves its output through Vite middleware with Vite's own TS transform switched off |
| Analog | `@analogjs/vite-plugin-angular` on ngtsc, plus its own opt-in per-file compiler `fastCompile` | no mention anywhere in issues, PRs, discussions or source | partly, see below |
| VoidZero | `@oxc-angular/vite` 0.0.41 (14 Oct), a real per-file Vite plugin, still committed to | no, its own Rust compiler | yes, but no template type-checking and no cross-file optimization |
| Treaty | its own Rust compiler with an opt-in bridge to ngp's Rust analyzer crate | analyzer crate only, self-reported | its own `@treaty/vite` |

The CLI's code points one way: ngp goes in as a per-file transform inside the existing esbuild plugin, and Vite stays a file server. A plugin that lets Vite own the module graph is a different product from what the CLI is heading toward, and nobody has announced one.

The window has two edges. The Angular blog says the team aims to ship an experimental ngp "later this year". Analog's Compilation-API path calls the CLI's compilation factory, so if the CLI implements `'transform'` mode with ngp, Analog could pick it up with little work.

## What Analog does today, and why

The audit found 15 places where Analog's plugin departs from the standard Vite plugin model. Most of them trace back to one fact: ngtsc can't compile a file until it has built a `ts.Program` and analyzed every decorator in it, and it emits through TypeScript's own emit pipeline.

| Workaround in 2.8.1 | Root cause | What users see | Does a per-file compiler remove the cause? |
|---|---|---|---|
| Compiles the whole program in `buildStart`; `transform` returns cached output and ignores the `code` Vite passes | ngtsc is whole-program | Slow cold start; other plugins' edits to `.ts` are dropped; "several GB" of memory on large apps (8 GB heap exhausted in analogjs/analog#2603) | **Yes.** Measured below: ngp compiles per request from Vite's code |
| Turns off Vite's own TS transform | ngtsc emits JavaScript itself | `.ts` outside the tsconfig left untranspiled; broken source maps (#2505) | **Yes.** ngp returns TypeScript and a map, and Vite's transform runs after it |
| Overrides `handleHotUpdate`: recompiles the program per change, invalidates the module graph by hand, falls back to full reloads; `liveReload` off by default | Output exists only after a program recompile; templates and styles aren't Vite modules | Edits become full reloads; one user measured 1–8 s per compile, 52 s for 10 changed files (#2588) | **Mostly.** Edits cost milliseconds per file, measured below |
| Batches hot updates by wrapping Vite's HMR channels (100 ms debounce) | Each recompile is whole-program | ≥100 ms on every update; other plugins' HMR messages pass through Analog's wrapper | **Yes**, once a recompile is cheap |
| Component styles go through the TS host and are inlined; a regex encapsulates Vite's internal CSS output | ngtsc reads resources itself; `externalRuntimeStyles` is fixed per program | SCSS partial edits missed; `:host` and keyframe bugs (#2492, #2049); ~12 style issues | **Partly.** ngp's `externalRuntimeStyles` makes styles Vite modules; encapsulation is still the plugin's job |
| Imports private `@angular/build` and compiler-cli APIs, with constructor shims per Angular version | No public per-file Angular API | Breaks on Angular minors (#2574, #2575, #2581 on 22.2) | **Yes**, if ngp's API becomes public and stable. Today it's a prototype |
| Vitest: JIT by default, whole-program emit before tests | Program can't be scoped to the requested tests | Focused runs compile every spec; OOM and hangs (#2325, #2589) | **Yes.** Compile only what Vitest requests |
| One program shared and locked across Vite environments | Program state is global and costly | Client and SSR builds compile twice, serially; an earlier race corrupted builds (#2103) | **Partly** |
| Type-checks in-process on the compile path | Template type-checking is whole-program | Blocks the event loop during HMR (#2602: 7.9 s vs 3.1 s) | **Partly.** The check can move off-thread; it stays whole-program |
| Links `node_modules` libraries in the dep optimizer | Libraries ship partially compiled | Slow pre-bundling, leaking workers (#2415, #2371) | **No.** Every Angular plugin needs a linker |

Analog's own answer to the per-file problem is `fastCompile`, a reimplementation of Angular's compiler front end on oxc. Its own docs list no type-checking, no template source maps and an "87%+" Ivy instruction match, and there are about eight open correctness issues. An ngp plugin would replace that reimplementation with Angular's own analyzer and template compiler.

The full audit, with file and line links for every row and the issue themes behind them, is in [vite-plugin-analog-audit.md](vite-plugin-analog-audit.md). The landscape research, with a dated timeline, is in [vite-plugin-landscape.md](vite-plugin-landscape.md).

## What ngp's API does under a dev-server workload

Four experiments, all in [spikes/](../spikes): local, on an M2 Max, native engine, the generated all-standalone apps. Each one checks correctness against a fresh full build, not just speed.

### 1. Modules compile on request, with no whole-program pass

[spikes/lazy-start.mjs](../spikes/lazy-start.mjs) compiles every module in the order a browser would request it, starting from `main.ts`, by calling `processFile(file, code)` on a fresh compiler with no analysis run first.

| Mode | Modules | CLI path: first module / all | On request: first module / all | Output identical to the CLI path |
|---|---:|---|---|---|
| optimize | 113 | 20 ms / 312 ms | **5 ms** / 208 ms | all |
| optimize | 1,089 | 125 ms / 1.8 s | **39 ms** / 1.6 s | all |
| optimize | 5,429 | 668 ms / 9.0 s | **164 ms** / 9.1 s | all |
| local | 1,089 | 86 ms / 1.6 s | 33 ms / 1.5 s | **745 differ** |

ngp's Rust analyzer answers per file on demand, so a dev server can serve its first module in 164 ms on a 5,000-component app.

Local mode isn't safe on this path. Compiled per file, components lost `changeDetection: ChangeDetectionStrategy.OnPush`, and `@defer` dependencies turned into dynamic imports that the streamed build doesn't produce. Dropping OnPush changes runtime behavior. A plugin should run optimize mode for dev and for production.

### 2. An edit costs milliseconds, if the plugin skips the delta

The CI benchmark S6 (rebuild after one edit) uses the path the CLI would use: `updateFileContent`, then the `analyzeOptimizedDelta` pass, then regenerate every file the analyzer marked stale. On that path ngp is slower than ngc once apps grow: 0.37–0.39 s against 0.23–0.26 s at 1,000 components, and 2.05–2.09 s against 1.11–1.17 s at 5,000.

[spikes/edit-anatomy.mjs](../spikes/edit-anatomy.mjs) splits that cost apart and tries the Vite way: tell the analyzer about the edit, then regenerate only the modules Vite asks for, without the delta. Medians of 3 rounds, four edits per size: a class field, an external template, a shared type every component imports, and a selector rename that changes the parent component's output.

| Size | `updateFileContent` | Delta pass (CLI path only) | Regenerate the edited file | Regenerate every stale file | Stale → actually changed |
|---|---:|---:|---:|---:|---|
| 113 | 3.6 ms | 9–10 ms | 0.2–3 ms | 1.5–6.5 ms (5–6 files) | 1, or 2 for the selector |
| 1,089 | 34 ms | 90–104 ms | 0.4–3.8 ms | 17–35 ms (41–42 files) | 1, or 2 for the selector |
| 5,429 | 172 ms | 465–471 ms | 0.5–2.9 ms | 213–219 ms (201–202 files) | 1, or 2 for the selector |

- Every regenerated file, edited or stale, matched a fresh build byte for byte, including the selector rename where the parent page's output changes. The analyzer's stale set always covered the files that actually changed.
- The stale set over-approximates: 202 files marked, 1 or 2 changed, at 5,000 components. A plugin should invalidate stale modules in Vite's module graph and let Vite re-request the ones the page still uses, instead of regenerating all of them.
- The delta pass re-streams every file in the program after every edit. A plugin doesn't need it.

That leaves `updateFileContent` growing with project size: 172 ms for a one-line change at 5,000 components. The cause is in the analyzer. After every update it calls `re_resolve_entrypoints()`, which reloads the tsconfig and re-expands its `include` globs, walking the whole source tree (8,929 files at 5k), and it always evicts the whole-program `ComponentMapping` query. The code itself marks that as unfinished: `TODO(parity): avoid evicting ComponentMapping on changes that do not affect @Component/@NgModule declarations`. With a tsconfig that lists only `files: ["src/main.ts"]`, nothing is left to glob, and the same update takes **0.9–1.0 ms** at 5,000 components, still with identical output.

So on a 5,000-component app, a plugin can turn a one-file edit into about 1 ms of analyzer update plus about 3 ms of regeneration. The fix upstream is to re-resolve entry points only when files are created or deleted. Until then, the plugin can hand the analyzer a generated tsconfig that extends the user's and lists only the entry point.

### 3. HMR uses the CLI's protocol, written against `import.meta.hot`

With `enableHmr`, ngp's output contains the same initializer the CLI's compiler emits ([spikes/hmr-styles.mjs](../spikes/hmr-styles.mjs)):

- `import.meta.hot.on('angular:component-update', …)`, which is Vite's own HMR API, with no custom websocket;
- `import(ɵɵgetReplaceMetadataURL(id, t, import.meta.url))`, which requests `<module dir>/@ng/component?c=<id>&t=<timestamp>`;
- `emitHmrUpdateModule(file, className)`, which returns the update module (about 7.9 KB for a mid-size component).

A plugin needs an `/@ng/component` middleware that matches by `includes`, since requests come relative to each module's URL, and a `server.ws.send('angular:component-update', {id, timestamp})` after an edit. Two details matter for a large app. Every component requests its update module once at startup (`HmrLoad(Date.now())`), so the endpoint must answer instantly with an empty module when nothing changed. And in HMR mode all dependencies are eager, so `@defer` doesn't split code in dev, the same as the CLI.

### 4. External styles arrive as absolute paths

With `externalRuntimeStyles`, a component's `styleUrl` comes out as `ɵɵExternalStylesFeature(['/absolute/path/to/x.css'])`. The plugin has to rewrite that to a URL Vite serves, and apply Angular's emulated encapsulation (`_ngcontent-%COMP%`) in Vite's CSS pipeline, keyed by component id. Inline `styles:` stay inline, already compiled and encapsulated. That works for plain CSS, but ngp has no hook to run inline styles through a preprocessor, so inline SCSS isn't possible yet.

## What the plugin would still have to build

| Piece | Why | Existing reference |
|---|---|---|
| Linker for `node_modules` | Angular libraries ship partially compiled (`ɵɵngDeclare*`) | `@angular/compiler-cli/linker/babel`; the CLI moved its linker to oxc and magic-string (angular/angular-cli#33625) |
| `/@ng/component` endpoint and HMR wiring | ngp generates update modules; serving them is the host's job | `@angular/build` `component-middleware.ts`, `@oxc-angular/vite` |
| Style URLs and encapsulation | ngp emits file paths, not URLs | `encapsulateStyle` in `@angular/compiler`; the CLI's `?ngcomp=` handling |
| Type-checking | Not in the transform path by design | ngp's `.ngtypecheck.ts` output plus `tsc`/`tsgo`, which this repo measures in S3/S4 |
| Shipping ngp | Not on npm; native binaries per platform | This repo's `toolchain/` builds it without Bazel |
| SSR, i18n, Vitest | Out of scope for a first version | |

## Risks

- **ngp isn't published.** A plugin has to build or vendor it, including a native binary per platform, with wasm as the fallback. Its `package.json` name is `@angular/compiler-cli/preprocessor`, so it will likely ship inside compiler-cli.
- **The API is a prototype.** Fourteen compiler-cli fixes landed in `22.3.0-next.2` alone, and the README says the team won't take outside issues or pull requests, so the analyzer fix above can't be sent upstream as a PR.
- **ngp pins TypeScript to `>=6.0 <6.1`.** That's for its own backend; type-checking its output can still run on `tsgo`.
- **Optimize mode is required,** so production cross-file optimization and dev share one code path. That's good for consistency, but the analyzer's whole-program queries (`ComponentMapping`, `ProgramFiles`) still rerun on edits.
- **The window.** The Angular team's experimental release, or Analog adopting the CLI's `'transform'` mode, could close it.

## Recommendation

Build it. The evidence answers the questions that decide feasibility. Per-file compilation from Vite's code is correct and fast. Edits stay in milliseconds even at 5,000 components, once the plugin skips the delta and keeps the analyzer away from the glob. HMR speaks the protocol the Angular runtime already understands. The first version is a set of known pieces, not an open research problem.

A first version, in order:

1. `transform` (`enforce: 'pre'`) calls `processFile(id, code)` in optimize mode, after `updateFileContent` when Vite's `code` differs from disk. It returns ngp's TypeScript and map, and Vite's own transform strips the types.
2. `hotUpdate` sends the edit to the analyzer, invalidates the stale modules Vite has loaded, and for templates maps `.html` to its component with `getTsFileForTemplate`.
3. The analyzer reads a generated tsconfig that lists only the entry point.
4. Production build through the same transform.
5. Then: component HMR, external styles with encapsulation, the linker, and a type-check worker.

What to measure once it runs: dev-server cold start to first paint, edit-to-update latency, and production build time, against `ng serve`, Analog's default path and `@oxc-angular/vite`, on this repo's generated apps and its two real apps.

## Sources

- Competitive landscape research: angular/angular PRs #71259, #71276, #71283, #71313, #71331, #71316, #71343, #71364; angular/angular-cli PRs #33437, #33862, #33953, #33967, #33978, #33979, #34007, #34043, #33625; [oxc-angular-compiler](https://github.com/voidzero-dev/oxc-angular-compiler); [Treaty's ng-analyze bridge](https://github.com/treatyjs/treaty/tree/main/libs/treaty-ivy/ng-analyze-bridge); [An update on Angular's TypeScript 7-powered Compiler](https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a)
- `@angular/build` dev server at `00c2509`: `builders/dev-server/vite/server.ts`, `tools/vite/plugins/angular-memory-plugin.ts`, `tools/vite/middlewares/component-middleware.ts`
- Analog audit: [`@analogjs/vite-plugin-angular` at 58a9df6](https://github.com/analogjs/analog/tree/58a9df609050ba9d43bcc062316a477216a03015/packages/vite-plugin-angular), issues cited by number in the table above
- ngp source at `92e5aa8`: `preprocessor/src/hybrid_compiler.ts` (`runUpdate`, `processFile`, `emitHmrUpdateModule`), `preprocessor/src/processor.ts` (external styles, HMR), `ng-analyze/src/compiler/analyzer.rs` (`update_file_content_core`, `re_resolve_entrypoints`), `ng-analyze/src/query/engine.rs` (`invalidate_file_id`)
- Experiments: [spikes/](../spikes); S6 numbers from CI run [38888167669](https://github.com/push-based/ng-hybrid-preprocessor-bench/actions/runs/38888167669)
