// Paths and engine wiring shared by the harness and corpus/check.mjs.
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const enginesDir = path.join(root, 'toolchain/out/engines');
export const ngpMain = path.join(root, 'toolchain/out/preprocessor/main.js');
export const ngcBin = path.join(root, 'node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js');
export const tscBin = path.join(root, 'node_modules/typescript/bin/tsc');
// TypeScript 7, the Go port, installed under an alias because Angular needs typescript@6 by name.
export const tsgoBin = path.join(root, 'node_modules/typescript7/bin/tsc');
export const hyperfineBin = path.join(root, 'toolchain/.cache/tools/bin/hyperfine');

/** Environment variables and extra ngp arguments that force one analyzer engine, with no fallback. */
export function engineEnv(engine) {
  switch (engine) {
    case 'native':
      return {
        env: {
          NG_EXP_COMPILER_BACKEND: 'native',
          NG_EXP_COMPILER_NATIVE_BINDING: path.join(enginesDir, 'native/ng_analyze.node'),
        },
        extraArgs: [],
      };
    case 'wasm':
      return {
        env: {
          NG_EXP_COMPILER_BACKEND: 'wasm',
          NG_EXP_COMPILER_WASM_BINDING: path.join(enginesDir, 'wasm/ng_analyze.js'),
        },
        extraArgs: [],
      };
    case 'sidecar':
      return {env: {}, extraArgs: ['--sidecar', path.join(enginesDir, 'sidecar/ng_analyze_bin')]};
    default:
      throw new Error(`unknown engine ${engine}`);
  }
}
