// Spike for the Vite-plugin investigation: what ngp emits for component HMR and for
// externalRuntimeStyles, so a plugin knows what it would have to serve.
//
// Usage: node spikes/hmr-styles.mjs --workspace <generated app> --file <component .ts> --class <ClassName>

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import {readConfiguration} from '@angular/compiler-cli';
import {engineEnv, root} from '../harness/lib/paths.mjs';

const {values: args} = parseArgs({
  options: {workspace: {type: 'string'}, file: {type: 'string'}, class: {type: 'string'}},
});
const workspace = await fs.realpath(path.resolve(args.workspace));
const tsconfig = path.join(workspace, 'tsconfig.app.json');
const file = path.join(workspace, args.file);
Object.assign(process.env, engineEnv('native').env);
const ngp = await import(path.join(root, 'toolchain/out/preprocessor/api.js'));
const ngOptions = readConfiguration(tsconfig).options;

async function compile({enableHmr, externalRuntimeStyles}) {
  const analyzer = await ngp.createAnalyzer(tsconfig, {optimize: true, backend: 'native', enableHmr});
  const compiler = new ngp.HybridCompiler(analyzer, {
    optimize: true,
    tcbConfig: ngp.buildTypeCheckingConfig(ngOptions, false),
    rootDir: workspace,
    enableHmr,
    externalRuntimeStyles,
  });
  const code = (await compiler.processFile(file, await fs.readFile(file, 'utf8'))).magicString.toString();
  const update = enableHmr ? await compiler.emitHmrUpdateModule(file, args.class) : null;
  analyzer.close();
  return {code, update};
}

const lines = (s, re, n = 2) =>
  s.split('\n').flatMap((l, i, all) => (re.test(l) ? [all.slice(Math.max(0, i - n), i + n + 1).join('\n'), '…'] : []));

const plain = await compile({enableHmr: false, externalRuntimeStyles: false});
const hmr = await compile({enableHmr: true, externalRuntimeStyles: false});
const styles = await compile({enableHmr: false, externalRuntimeStyles: true});

console.log('### HMR additions to the compiled component (lines not in the plain output)');
const plainSet = new Set(plain.code.split('\n'));
console.log(hmr.code.split('\n').filter((l) => !plainSet.has(l)).join('\n'));
console.log('\n### emitHmrUpdateModule() output' + (hmr.update ? ` (${hmr.update.length} chars), head:` : ': null'));
console.log(hmr.update?.split('\n').slice(0, 25).join('\n'));
console.log('\n### externalRuntimeStyles: style-related lines');
console.log(lines(styles.code, /ExternalStyles|styles:|\.css/).join('\n'));
console.log('\n### plain: style-related lines');
console.log(lines(plain.code, /ExternalStyles|styles:/).join('\n'));
