// Fetches a pinned real Angular app into REAL_DIR (default corpus/real-apps/<name>) and prepares
// it for the benchmark.
//
// 1. Shallow-fetches the commit pinned in corpus/real/<name>.json.
// 2. Pins every @angular/* framework and CLI package to that file's `angularVersion`, the version
//    the ngp toolchain is built from, so ngc, ngp and the app see the same Angular. Libraries that
//    declare a peer range like ^22.0.0 reject prereleases, hence --legacy-peer-deps.
// 3. Runs the app's install commands (which run its own prepare scripts).
// 4. Writes manifest.json: the pin, the source file count ngp should emit, a component count, and
//    a SHA-256 over the sources so the harness can check nothing changed them.
//
// Usage: node corpus/fetch-real.mjs <name>

import {execSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ts from 'typescript';
import {corpusHash} from '../harness/lib/corpus.mjs';
import {root} from '../harness/lib/paths.mjs';

const name = process.argv[2];
if (!name) {
  console.error('Usage: node corpus/fetch-real.mjs <name>');
  process.exit(1);
}
const pin = JSON.parse(await fs.readFile(path.join(root, 'corpus/real', `${name}.json`), 'utf8'));
const realDir = path.resolve(process.env['REAL_DIR'] ?? path.join(root, 'corpus/real-apps'));
const dest = path.join(realDir, name);
const sh = (cmd, cwd = dest) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, {cwd, stdio: 'inherit', env: {...process.env, HUSKY: '0', CI: 'true'}});
};

await fs.rm(dest, {recursive: true, force: true});
await fs.mkdir(dest, {recursive: true});
sh('git init -q');
sh(`git remote add origin ${pin.repo}`);
sh(`git fetch -q --depth 1 origin ${pin.sha}`);
sh('git -c advice.detachedHead=false checkout -q FETCH_HEAD');

const pkgPath = path.join(dest, 'package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
const pinned = [];
for (const field of ['dependencies', 'devDependencies']) {
  for (const dep of Object.keys(pkg[field] ?? {})) {
    if (/^@angular\/(?!.*eslint)/.test(dep) || dep === '@angular-devkit/build-angular') {
      pkg[field][dep] = pin.angularVersion;
      pinned.push(dep);
    }
  }
}
await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`pinned ${pinned.length} packages to ${pin.angularVersion}: ${pinned.join(', ')}`);
for (const cmd of pin.install) sh(cmd);

// The files ngp should emit: every non-declaration source file in the app's TypeScript program
// that lives in the repo, outside node_modules.
const tsconfigApp = path.join(dest, pin.tsconfigApp);
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigApp, {}, {...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {}});
const program = ts.createProgram(parsed.fileNames, parsed.options);
const sources = program
  .getSourceFiles()
  .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/') && sf.fileName.startsWith(dest))
  // resolveJsonModule pulls .json files into the program; they aren't sources ngp compiles.
  .filter((sf) => /\.tsx?$/.test(sf.fileName));
const components = sources.reduce((n, sf) => n + (sf.text.match(/@Component\s*\(/g)?.length ?? 0), 0);

const manifest = {
  name,
  repo: pin.repo,
  sha: pin.sha,
  angularVersion: pin.angularVersion,
  tsconfigApp: pin.tsconfigApp,
  tsconfigRoot: pin.tsconfigRoot ?? pin.tsconfigApp,
  ngpTarget: pin.ngpTarget,
  sourceTs: sources.length,
  components,
  sha256: await corpusHash(dest),
};
await fs.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`${name}: ${sources.length} source files, ${components} components -> ${path.relative(process.cwd(), dest)}`);
