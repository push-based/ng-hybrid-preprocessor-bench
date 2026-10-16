// Second half of the S7 candidate: bundle ngp's output into a runnable development build.
//
// Follows ngp's own `serve` tool (packages/compiler-cli/preprocessor/serve.ts at the pinned
// commit): esbuild bundles from ngp's main.ts with code splitting, and Angular's linker runs over
// npm packages that ship partially compiled (`ɵɵngDeclare*`), as the CLI does. Then index.html
// gets the bundle's script tag and the global stylesheet is copied.
//
// What it deliberately skips, unlike `ng build --configuration development`: type-checking,
// stylesheet preprocessing, asset globs beyond `public/`, budgets and license extraction.
//
// Usage: node harness/ngp-bundle.mjs <ngp-out-dir> --workspace <dir> --out <dist-dir>

import {existsSync, readFileSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import * as esbuild from 'esbuild';
import {root} from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {workspace: {type: 'string'}, out: {type: 'string'}},
});
const ngpOut = path.resolve(positionals[0]);
const workspace = path.resolve(args.workspace);
const dist = path.resolve(args.out);

const LINKER_PREFIX = 'ɵɵngDeclare';
let createLinkerPlugin;
const linker = {
  name: 'angular-linker',
  setup(build) {
    build.onLoad({filter: /\.[cm]?js$/}, async ({path: file}) => {
      // Angular's own compiler and core runtime never need linking.
      if (/[\\/]@angular[\\/](?:compiler|core)[\\/]/.test(file)) return undefined;
      const source = await fs.readFile(file, 'utf8');
      if (!source.includes(LINKER_PREFIX)) return undefined;
      createLinkerPlugin ??= (await import('@angular/compiler-cli/linker/babel')).createEs2015LinkerPlugin;
      const babel = require('@babel/core');
      const result = await babel.transformAsync(source, {
        filename: file,
        configFile: false,
        babelrc: false,
        compact: false,
        plugins: [
          createLinkerPlugin({
            linkerJitMode: false,
            sourceMapping: false,
            fileSystem: {
              resolve: path.resolve,
              exists: existsSync,
              dirname: path.dirname,
              relative: path.relative,
              readFile: readFileSync,
            },
          }),
        ],
      });
      return {contents: result.code, loader: 'js'};
    });
  },
};

await fs.rm(dist, {recursive: true, force: true});
await esbuild.build({
  entryPoints: [{in: path.join(ngpOut, 'src/main.ts'), out: 'main'}],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  outdir: dist,
  tsconfig: path.join(workspace, 'tsconfig.json'),
  nodePaths: [path.join(root, 'node_modules')],
  conditions: ['es2020', 'es2015', 'module'],
  mainFields: ['es2020', 'es2015', 'browser', 'module', 'main'],
  logLevel: 'error',
  plugins: [linker],
});

let html = await fs.readFile(path.join(workspace, 'src/index.html'), 'utf8');
html = html.replace('</head>', '  <link rel="stylesheet" href="styles.css">\n</head>');
html = html.replace('</body>', '  <script type="module" src="main.js"></script>\n</body>');
await fs.writeFile(path.join(dist, 'index.html'), html);
await fs.copyFile(path.join(workspace, 'src/styles.css'), path.join(dist, 'styles.css'));
if (existsSync(path.join(workspace, 'public'))) {
  await fs.cp(path.join(workspace, 'public'), dist, {recursive: true});
}
