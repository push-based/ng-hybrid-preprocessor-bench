// Parses TypeScript/ngc diagnostics and maps errors inside ngp's type-check blocks back to the
// template location ngc would report.
//
// A type-check block (.ngtypecheck.ts) starts with `TCB for <component .ts path>`, wraps each
// component's template in `function _tcbN(this: iK.ClassName)`, and follows each expression with
// a span comment `/*start,end*/`. For inline templates the offsets point into the component's .ts
// file; for templateUrl they point into the .html file. ngc reports a binding error at the start
// of the first span after the error's position, so that is what this maps to.

import * as fs from 'node:fs';
import * as path from 'node:path';

const PRETTY = /^(.+?):(\d+):(\d+) - error (TS\d+|NG\d+):/;
const PLAIN = /^(.+?)\((\d+),(\d+)\): error (TS\d+|NG\d+):/;

/**
 * Every error in tsc/tsgo/ngc output. Relative paths are resolved against the first of `cwds`
 * where the file exists: ngc prints paths relative to the tsconfig, tsc relative to its cwd.
 */
export function parseDiagnostics(output, cwds) {
  const resolveFile = (p) =>
    cwds.map((c) => path.resolve(c, p)).find((f) => fs.existsSync(f)) ?? path.resolve(cwds[0], p);
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const out = [];
  for (const line of clean.split('\n')) {
    const m = line.trim().match(PRETTY) ?? line.trim().match(PLAIN);
    if (!m) continue;
    out.push({file: resolveFile(m[1]), line: Number(m[2]), col: Number(m[3]), code: m[4]});
  }
  return out;
}

function offsetToLineCol(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return {line, col: offset - before.lastIndexOf('\n')};
}

/** Maps an error in a .ngtypecheck.ts file to {file, line, col} in the template, or null. */
export function mapTcbDiagnostic(diag) {
  if (!diag.file.endsWith('.ngtypecheck.ts')) return null;
  const tcb = fs.readFileSync(diag.file, 'utf8');
  const componentTs = tcb.match(/TCB for (.+\.ts)/)?.[1]?.trim();
  if (!componentTs || !fs.existsSync(componentTs)) return null;

  const lines = tcb.split('\n');
  const errorLine = lines[diag.line - 1] ?? '';
  const span = [...errorLine.matchAll(/\/\*(\d+),(\d+)\*\//g)].find((m) => m.index >= diag.col - 1);
  if (!span) return null;
  const offset = Number(span[1]);

  let className = null;
  for (let i = diag.line - 1; i >= 0 && !className; i--) {
    className = lines[i].match(/function _tcb\d+\(this: \w+\.(\w+)\)/)?.[1] ?? null;
  }
  if (!className) return null;

  const source = fs.readFileSync(componentTs, 'utf8');
  const classAt = source.search(new RegExp(`class\\s+${className}\\b`));
  if (classAt < 0) return null;
  const decoratorAt = source.lastIndexOf('@Component(', classAt);
  const decorator = decoratorAt >= 0 ? source.slice(decoratorAt, classAt) : '';
  const templateUrl = decorator.match(/templateUrl:\s*['"]([^'"]+)['"]/)?.[1];

  const file = templateUrl ? path.resolve(path.dirname(componentTs), templateUrl) : componentTs;
  const text = templateUrl ? fs.readFileSync(file, 'utf8') : source;
  return {file, ...offsetToLineCol(text, offset), code: diag.code};
}

/** A diagnostic as `relative/path:line:col CODE`, for comparing two compilers' results. */
export function diagnosticKey(d, root) {
  return `${path.relative(root, d.file)}:${d.line}:${d.col} ${d.code}`;
}
