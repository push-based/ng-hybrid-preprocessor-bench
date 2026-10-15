// Records everything a result depends on: versions, binaries, machine, and conditions
// that make timings unreliable (battery power, load, wrong Node).

import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {enginesDir, hyperfineBin, root} from './paths.mjs';

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch {
    return null;
  }
};
const sha256 = async (file) =>
  createHash('sha256').update(await fs.readFile(file)).digest('hex');
const pkgVersion = async (name) =>
  JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

export async function captureEnvironment() {
  const versionsEnv = await fs.readFile(path.join(root, 'toolchain/versions.env'), 'utf8');
  const pinned = Object.fromEntries([...versionsEnv.matchAll(/^(\w+)=(.+)$/gm)].map((m) => [m[1], m[2]]));
  const angularDir = path.join(root, 'toolchain/.cache/angular');
  const nvmrc = (await fs.readFile(path.join(root, '.nvmrc'), 'utf8').catch(() => '')).trim();
  const cpus = os.cpus();
  const cores = os.availableParallelism();

  let power = null;
  if (process.platform === 'darwin') {
    const batt = sh('pmset', ['-g', 'batt']) ?? '';
    power = batt.includes("'AC Power'") ? 'ac' : batt.includes("'Battery Power'") ? 'battery' : null;
  }

  const cpuModel = cpus[0]?.model ?? 'unknown';
  const gha = process.env['GITHUB_ACTIONS'] === 'true';
  const env = {
    date: new Date().toISOString(),
    // A tag for the run id that describes the machine without exposing its hostname.
    hostTag: `${gha ? 'gha-' : ''}${cpuModel.replace(/\(.*?\)|Apple|Intel|AMD|CPU|Core|Processor/gi, '').trim().replace(/[^A-Za-z0-9]+/g, '').toLowerCase()}-${cores}c`,
    machine: {
      cpuModel,
      cores,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
      os: `${os.type()} ${os.release()}`,
      osVersion: process.platform === 'darwin' ? sh('sw_vers', ['-productVersion']) : sh('uname', ['-r']),
      arch: process.arch,
      power,
      loadAverage1m: os.loadavg()[0],
    },
    versions: {
      node: process.version,
      nvmrc,
      angularSha: sh('git', ['-C', angularDir, 'rev-parse', 'HEAD']),
      angularShaPinned: pinned.ANGULAR_SHA,
      compilerCli: await pkgVersion('@angular/compiler-cli'),
      typescript: await pkgVersion('typescript'),
      esbuild: await pkgVersion('esbuild'),
      rustc: pinned.RUST_TOOLCHAIN,
      hyperfine: sh(hyperfineBin, ['--version']),
    },
    artifacts: {
      cargoLockSha256: await sha256(path.join(angularDir, 'Cargo.lock')),
      nativeSha256: await sha256(path.join(enginesDir, 'native/ng_analyze.node')).catch(() => null),
      wasmSha256: await sha256(path.join(enginesDir, 'wasm/ng_analyze_bg.wasm')).catch(() => null),
      sidecarSha256: await sha256(path.join(enginesDir, 'sidecar/ng_analyze_bin')).catch(() => null),
      patches: Object.fromEntries(
        await Promise.all(
          (await fs.readdir(path.join(root, 'toolchain/patches')))
            .sort()
            .map(async (p) => [p, await sha256(path.join(root, 'toolchain/patches', p))]),
        ),
      ),
    },
    // Set on GitHub Actions: which commit, run and runner image produced this result.
    ci: gha
      ? {
          provider: 'github-actions',
          repository: process.env['GITHUB_REPOSITORY'],
          sha: process.env['GITHUB_SHA'],
          ref: process.env['GITHUB_REF'],
          runId: process.env['GITHUB_RUN_ID'],
          runAttempt: process.env['GITHUB_RUN_ATTEMPT'],
          runnerName: process.env['RUNNER_NAME'],
          runnerImage: `${process.env['ImageOS'] ?? ''} ${process.env['ImageVersion'] ?? ''}`.trim() || null,
        }
      : null,
    warnings: [],
  };

  if (nvmrc && `v${nvmrc}` !== process.version) {
    env.warnings.push(`running on Node ${process.version}, but .nvmrc pins ${nvmrc}`);
  }
  if (env.versions.angularSha !== pinned.ANGULAR_SHA) {
    env.warnings.push(`Angular checkout is ${env.versions.angularSha}, versions.env pins ${pinned.ANGULAR_SHA}`);
  }
  if (power === 'battery') env.warnings.push('running on battery power; timings may be throttled');
  if (env.machine.loadAverage1m > cores * 0.25) {
    env.warnings.push(`1-minute load average is ${env.machine.loadAverage1m.toFixed(1)} on ${cores} cores`);
  }
  return env;
}
