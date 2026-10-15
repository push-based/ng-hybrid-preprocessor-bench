// Verifies a generated workspace still matches the SHA-256 in its manifest.json.
//
// Mirrors corpus/generate.mjs: every generated file, sorted by relative path, hashed as
// `path \0 content \0`. Build outputs and tool artifacts are skipped. The harness checks this
// before and after timing because ngp --out can overwrite sources (see harness/run.mjs).

import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', 'out-tsc']);
const SKIP_FILE = (name) => name === 'manifest.json' || name.endsWith('.ngdiag.json');

export async function corpusHash(workspace) {
  const files = [];
  async function walk(dir, rel) {
    for (const e of await fs.readdir(dir, {withFileTypes: true})) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (!SKIP_FILE(e.name)) files.push(r);
    }
  }
  await walk(workspace, '');
  files.sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f + '\0' + (await fs.readFile(path.join(workspace, f), 'utf8')) + '\0');
  return hash.digest('hex');
}

export async function verifyCorpus(workspace, manifest) {
  return (await corpusHash(workspace)) === manifest.sha256;
}
