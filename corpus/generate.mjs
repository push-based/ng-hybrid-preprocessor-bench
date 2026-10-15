// Generates a synthetic, all-standalone Angular CLI workspace from a seed.
//
// The same --components and --seed always produce byte-identical files; manifest.json records a
// SHA-256 over every file so you can check that. Workspaces have no node_modules of their own:
// they live under this repo and resolve @angular/* from its root node_modules.
//
// Usage: node corpus/generate.mjs --components 1000 [--seed 1] [--out <dir>]
//
// The default output directory is $CORPUS_DIR/<name>, or corpus/generated/<name> without it.
// A workspace written outside this repo gets a node_modules symlink to the repo's, so packages
// still resolve (CI generates onto a RAM disk this way).
//
// Shape of a generated app:
//   src/app/app.ts                 root component: nav + router outlet
//   src/app/app.routes.ts          one lazy route per feature (loadComponent)
//   src/app/features/fNNN/         a page component, ~20 child components, a root-provided store
//   src/app/shared/ui/             shared components every feature can import, plus a model() toggle
//   src/app/shared/pipes|directives/
//
// Every component except the root and pages has the same public surface (label, count, items
// inputs; a selected output), so any parent can bind any child. Variety comes from the template:
// control flow, @let, @defer, pipes, directives, two-way binding, host bindings, external files.

import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {values: args} = parseArgs({
  options: {
    components: {type: 'string'},
    seed: {type: 'string', default: '1'},
    out: {type: 'string'},
  },
});
if (!args.components) {
  console.error('Usage: node corpus/generate.mjs --components <n> [--seed <n>] [--out <dir>]');
  process.exit(1);
}

const N = Number(args.components);
const SEED = Number(args.seed);
if (!Number.isInteger(N) || N < 20) throw new Error('--components must be an integer >= 20');
const name = `standalone-${N}-s${SEED}`;
const corpusDir = path.resolve(process.env['CORPUS_DIR'] ?? path.join(root, 'corpus/generated'));
const outDir = path.resolve(args.out ?? path.join(corpusDir, name));

// Probabilities. Changing any of these changes every generated app, so bump GENERATOR_VERSION.
const GENERATOR_VERSION = 1;
const P = {
  externalTemplate: 0.5,
  externalStyles: 0.2,
  inlineStyles: 0.3,
  onPush: 0.7,
  hostBindings: 0.3,
  injectStore: 0.5,
  deferChild: 0.15,
  extraChildEdge: 0.4,
  extraShared: 0.3,
  extraPipe: 0.3,
  extraDirective: 0.3,
  extraToggle: 0.1,
  ifBlock: 0.5,
  switchBlock: 0.3,
  letBlock: 0.3,
  inputBlock: 0.3,
  dateForBlock: 0.3,
};
const FEATURE_SIZE = 20;

// ---------------------------------------------------------------------------------------------
// Seeded randomness (mulberry32). Never call Math.random or Date in this file.

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const chance = (p) => rand() < p;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const pick = (arr) => arr[int(0, arr.length - 1)];
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = int(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------------------------
// Plan: decide every entity and edge before writing any file.

const pad = (n, width) => String(n).padStart(width, '0');

const sharedCount = Math.max(4, Math.round(N * 0.1)); // includes the toggle
const pipeCount = Math.max(2, Math.round(N / 50));
const directiveCount = Math.max(2, Math.round(N / 50));
const featureComponentCount = N - 1 - sharedCount;
const featureCount = Math.max(1, Math.ceil(featureComponentCount / FEATURE_SIZE));

const fw = String(featureCount).length;
const sw = String(sharedCount).length;
const pw = String(pipeCount).length;
const dw = String(directiveCount).length;

const pipes = Array.from({length: pipeCount}, (_, i) => ({
  cls: `Truncate${pad(i, pw)}Pipe`,
  name: `appTruncate${pad(i, pw)}`,
  file: `src/app/shared/pipes/truncate-${pad(i, pw)}.pipe.ts`,
}));
const directives = Array.from({length: directiveCount}, (_, i) => ({
  cls: `Highlight${pad(i, dw)}Directive`,
  attr: `appHighlight${pad(i, dw)}`,
  file: `src/app/shared/directives/highlight-${pad(i, dw)}.directive.ts`,
}));

function newComponent(props) {
  return {
    children: [], // components rendered via the uniform binding
    deferred: new Set(), // subset of children wrapped in @defer
    pipes: new Set(),
    directives: new Set(),
    toggle: false,
    ...props,
  };
}

const toggle = {
  cls: 'ToggleComponent',
  selector: 'app-toggle',
  file: 'src/app/shared/ui/toggle.ts',
};

const shared = Array.from({length: sharedCount - 1}, (_, i) =>
  newComponent({
    kind: 'shared',
    cls: `Shared${pad(i, sw)}Component`,
    selector: `app-shared-${pad(i, sw)}`,
    file: `src/app/shared/ui/shared-${pad(i, sw)}.ts`,
  }),
);

const features = [];
{
  const base = Math.floor(featureComponentCount / featureCount);
  let extra = featureComponentCount % featureCount;
  for (let f = 0; f < featureCount; f++) {
    const size = base + (extra-- > 0 ? 1 : 0);
    const id = `f${pad(f, fw)}`;
    const dir = `src/app/features/${id}`;
    const cw = String(size).length;
    const store = {cls: `F${pad(f, fw)}Store`, file: `${dir}/${id}.store.ts`};
    const comps = [
      newComponent({
        kind: 'page',
        feature: f,
        cls: `F${pad(f, fw)}PageComponent`,
        selector: `app-${id}-page`,
        file: `${dir}/${id}-page.ts`,
        store,
      }),
    ];
    for (let c = 1; c < size; c++) {
      comps.push(
        newComponent({
          kind: 'child',
          feature: f,
          cls: `F${pad(f, fw)}C${pad(c, cw)}Component`,
          selector: `app-${id}-c${pad(c, cw)}`,
          file: `${dir}/${id}-c${pad(c, cw)}.ts`,
          store,
        }),
      );
    }
    // A DAG inside the feature: every child gets one parent with a lower index, so the page
    // reaches all of them, plus some extra forward edges.
    for (let c = 1; c < size; c++) comps[int(0, c - 1)].children.push(comps[c]);
    for (let c = 0; c < size - 1; c++) {
      if (chance(P.extraChildEdge)) {
        const target = comps[int(c + 1, size - 1)];
        if (!comps[c].children.includes(target)) comps[c].children.push(target);
      }
    }
    features.push({id, index: f, dir, store, comps});
  }
}

const featureComps = features.flatMap((f) => f.comps);
const allUsers = [...featureComps, ...shared];

// Every shared component, pipe and directive is used at least once, so all of them sit in the
// import graph that starts at main.ts. Shared components are only used by feature components,
// which keeps the graph acyclic.
for (const s of shared) pick(featureComps).children.push(s);
pick(featureComps).toggle = true;
for (const p of pipes) pick(allUsers).pipes.add(p);
for (const d of directives) pick(allUsers).directives.add(d);
for (const c of featureComps) {
  if (chance(P.extraShared)) {
    const s = pick(shared);
    if (!c.children.includes(s)) c.children.push(s);
  }
  if (chance(P.extraToggle)) c.toggle = true;
}
for (const c of allUsers) {
  if (chance(P.extraPipe)) c.pipes.add(pick(pipes));
  if (chance(P.extraDirective)) c.directives.add(pick(directives));
  for (const child of c.children) if (chance(P.deferChild)) c.deferred.add(child);
  c.externalTemplate = chance(P.externalTemplate);
  c.styles = chance(P.externalStyles) ? 'external' : chance(P.inlineStyles) ? 'inline' : 'none';
  c.onPush = chance(P.onPush);
  c.host = chance(P.hostBindings);
  c.injectStore = c.kind === 'page' || (c.kind === 'child' && chance(P.injectStore));
  c.extras = {
    if: chance(P.ifBlock),
    switch: chance(P.switchBlock),
    let: chance(P.letBlock),
    input: chance(P.inputBlock),
    dateFor: chance(P.dateForBlock),
  };
}

// ---------------------------------------------------------------------------------------------
// Code generation.

const files = new Map(); // relative path -> content
const write = (rel, content) => files.set(rel, content.endsWith('\n') ? content : content + '\n');

function importPath(fromFile, toFile) {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile).replace(/\.ts$/, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

const indent = (text, spaces) =>
  text
    .split('\n')
    .map((l) => (l ? ' '.repeat(spaces) + l : l))
    .join('\n');

function bindingFor(child, n) {
  return `<${child.selector} [label]="label() + ' / ${n}'" [count]="count() + ${n}" [items]="items()" (selected)="onSelected($event)" />`;
}

// Builds the template and records which @angular/common pipes it needs.
function renderTemplate(c) {
  const common = new Set(['DecimalPipe']);
  const blocks = [];
  blocks.push(`<h3>{{ label() }} <small>{{ count() | number }}</small></h3>`);

  c.children.forEach((child, i) => {
    const binding = bindingFor(child, i + 1);
    blocks.push(
      c.deferred.has(child)
        ? `@defer (on viewport) {\n  ${binding}\n} @placeholder {\n  <p>Loading ${child.selector}</p>\n}`
        : binding,
    );
  });
  if (c.toggle) blocks.push(`<${toggle.selector} [(checked)]="flag" />`);
  for (const p of c.pipes) {
    blocks.push(
      `<ul>\n  @for (item of items(); track item.id) {\n    <li [class.even]="$even" (click)="onSelected(item)">{{ item.name | ${p.name}: 12 }}</li>\n  } @empty {\n    <li>No items</li>\n  }\n</ul>`,
    );
  }
  for (const d of c.directives) {
    blocks.push(`<span [${d.attr}]="active() ? 'gold' : 'transparent'">{{ label() }}</span>`);
  }
  if (c.extras.if) {
    common.add('CurrencyPipe');
    blocks.push(
      `@if (items().length > 0) {\n  <p>{{ items().length }} items, total {{ total() | currency: 'EUR' }}</p>\n} @else {\n  <p>Empty</p>\n}`,
    );
  }
  if (c.extras.switch) {
    blocks.push(
      `@switch (count() % 3) {\n  @case (0) {\n    <em>zero</em>\n  }\n  @case (1) {\n    <em>one</em>\n  }\n  @default {\n    <em>two</em>\n  }\n}`,
    );
  }
  if (c.extras.let) {
    blocks.push(`@let doubled = count() * 2;\n<p>Doubled: {{ doubled }}</p>`);
  }
  if (c.extras.input) {
    blocks.push(`<input [value]="query()" (input)="onInput($event)" />`);
  }
  if (c.extras.dateFor) {
    common.add('DatePipe');
    blocks.push(
      `@for (item of items(); track item.id; let i = $index) {\n  <time>{{ i }}: {{ item.createdAt | date: 'shortDate' }}</time>\n}`,
    );
  }
  // The heading always comes first; the rest are shuffled so templates differ in structure.
  const [head, ...rest] = blocks;
  return {template: [head, ...shuffle(rest)].join('\n'), common: [...common].sort()};
}

function renderComponent(c) {
  const {template, common} = renderTemplate(c);
  const base = path.posix.basename(c.file, '.ts');
  const core = new Set(['Component', 'computed', 'signal']);
  if (c.onPush) core.add('ChangeDetectionStrategy');
  if (c.kind !== 'page') {
    core.add('input');
    core.add('output');
  }
  if (c.injectStore) core.add('inject');

  const importLines = [];
  importLines.push(`import {${[...core].sort().join(', ')}} from '@angular/core';`);
  importLines.push(`import {${common.join(', ')}} from '@angular/common';`);
  const decoratorImports = [...common];
  const seen = new Set();
  const addImport = (cls, file) => {
    if (seen.has(cls)) return;
    seen.add(cls);
    importLines.push(`import {${cls}} from '${importPath(c.file, file)}';`);
    decoratorImports.push(cls);
  };
  for (const child of c.children) addImport(child.cls, child.file);
  if (c.toggle) addImport(toggle.cls, toggle.file);
  for (const p of c.pipes) addImport(p.cls, p.file);
  for (const d of c.directives) addImport(d.cls, d.file);
  importLines.push(
    `import {Item} from '${importPath(c.file, 'src/app/shared/models.ts')}';`,
  );
  if (c.injectStore) {
    importLines.push(`import {${c.store.cls}} from '${importPath(c.file, c.store.file)}';`);
  }

  const meta = [`selector: '${c.selector}'`, `imports: [${decoratorImports.join(', ')}]`];
  if (c.externalTemplate) {
    meta.push(`templateUrl: './${base}.html'`);
    write(path.posix.join(path.posix.dirname(c.file), `${base}.html`), template);
  } else {
    meta.push(`template: \`\n${indent(template, 2)}\n\``);
  }
  const css = `:host {\n  display: block;\n  padding: ${int(2, 12)}px;\n}\n.even {\n  background: #f${int(0, 9)}f${int(0, 9)}f${int(0, 9)};\n}`;
  if (c.styles === 'external') {
    meta.push(`styleUrl: './${base}.css'`);
    write(path.posix.join(path.posix.dirname(c.file), `${base}.css`), css);
  } else if (c.styles === 'inline') {
    meta.push(`styles: \`\n${indent(css, 2)}\n\``);
  }
  if (c.onPush) meta.push('changeDetection: ChangeDetectionStrategy.OnPush');
  if (c.host) meta.push(`host: {'[class.active]': 'active()', '(click)': 'toggle()'}`);

  const members = [];
  if (c.kind === 'page') {
    members.push(`private readonly store = inject(${c.store.cls});`);
    members.push(`protected readonly label = signal('Feature ${c.feature}');`);
    members.push(`protected readonly count = signal(${int(0, 9)});`);
    members.push(`protected readonly items = this.store.items;`);
  } else {
    if (c.injectStore) members.push(`private readonly store = inject(${c.store.cls});`);
    members.push(`readonly label = input.required<string>();`);
    members.push(`readonly count = input<number>(0);`);
    members.push(`readonly items = input<readonly Item[]>([]);`);
    members.push(`readonly selected = output<Item>();`);
  }
  members.push(`protected readonly active = signal(false);`);
  members.push(`protected readonly flag = signal(false);`);
  members.push(`protected readonly query = signal('');`);
  members.push(
    `protected readonly total = computed(() =>\n  this.items().reduce((sum, item) => sum + item.price, this.count()),\n);`,
  );
  members.push(`protected toggle(): void {\n  this.active.update((value) => !value);\n}`);
  const onSelectedBody = [
    c.kind !== 'page' ? 'this.selected.emit(item);' : null,
    c.injectStore ? 'this.store.select(item);' : null,
  ].filter(Boolean);
  members.push(
    `protected onSelected(item: Item): void {\n${indent(onSelectedBody.join('\n') || 'void item;', 2)}\n}`,
  );
  members.push(
    `protected onInput(event: Event): void {\n  this.query.set((event.target as HTMLInputElement).value);\n}`,
  );

  write(
    c.file,
    `${importLines.join('\n')}

@Component({
${indent(meta.join(',\n'), 2)},
})
export class ${c.cls} {
${indent(members.join('\n\n'), 2)}
}`,
  );
}

// Shared building blocks.
write(
  'src/app/shared/models.ts',
  `export interface Item {
  readonly id: number;
  readonly name: string;
  readonly price: number;
  readonly tags: readonly string[];
  readonly createdAt: Date;
}

export function createItems(seed: number, count: number): Item[] {
  return Array.from({length: count}, (_, i) => ({
    id: seed * 1000 + i,
    name: \`Item \${seed}-\${i} with a deliberately long name\`,
    price: ((seed + 1) * (i + 3)) % 97,
    tags: i % 2 === 0 ? ['even'] : ['odd', 'sale'],
    createdAt: new Date(2026, i % 12, (seed % 27) + 1),
  }));
}`,
);

write(
  toggle.file,
  `import {Component, model} from '@angular/core';

@Component({
  selector: '${toggle.selector}',
  template: \`
    <button type="button" [attr.aria-pressed]="checked()" (click)="checked.set(!checked())">
      {{ checked() ? 'On' : 'Off' }}
    </button>
  \`,
})
export class ${toggle.cls} {
  readonly checked = model(false);
}`,
);

for (const p of pipes) {
  write(
    p.file,
    `import {Pipe, PipeTransform} from '@angular/core';

@Pipe({name: '${p.name}'})
export class ${p.cls} implements PipeTransform {
  transform(value: string, max = 10): string {
    return value.length > max ? value.slice(0, max) + '…' : value;
  }
}`,
  );
}

for (const d of directives) {
  write(
    d.file,
    `import {Directive, input} from '@angular/core';

@Directive({
  selector: '[${d.attr}]',
  host: {'[style.background-color]': '${d.attr}()'},
})
export class ${d.cls} {
  readonly ${d.attr} = input<string>('');
}`,
  );
}

for (const f of features) {
  write(
    f.store.file,
    `import {Injectable, signal} from '@angular/core';
import {Item, createItems} from '${importPath(f.store.file, 'src/app/shared/models.ts')}';

@Injectable({providedIn: 'root'})
export class ${f.store.cls} {
  readonly items = signal<readonly Item[]>(createItems(${f.index}, ${int(3, 12)}));
  readonly selected = signal<Item | null>(null);

  select(item: Item): void {
    this.selected.set(item);
  }
}`,
  );
}

for (const c of [...shared, ...featureComps]) renderComponent(c);

// App shell.
write(
  'src/app/app.routes.ts',
  `import {Routes} from '@angular/router';

export const routes: Routes = [
${features
  .map(
    (f) =>
      `  {\n    path: '${f.id}',\n    loadComponent: () =>\n      import('./features/${f.id}/${f.id}-page').then((m) => m.${f.comps[0].cls}),\n  },`,
  )
  .join('\n')}
  {path: '', pathMatch: 'full', redirectTo: '${features[0].id}'},
];`,
);
write(
  'src/app/app.config.ts',
  `import {ApplicationConfig} from '@angular/core';
import {provideRouter} from '@angular/router';
import {routes} from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};`,
);
write(
  'src/app/app.ts',
  `import {Component} from '@angular/core';
import {RouterLink, RouterOutlet} from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  template: \`
    <nav>
      @for (feature of features; track feature) {
        <a [routerLink]="feature">{{ feature }}</a>
      }
    </nav>
    <router-outlet />
  \`,
})
export class App {
  protected readonly features = [${features.map((f) => `'${f.id}'`).join(', ')}];
}`,
);
write(
  'src/main.ts',
  `import {bootstrapApplication} from '@angular/platform-browser';
import {appConfig} from './app/app.config';
import {App} from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));`,
);
write(
  'src/index.html',
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${name}</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>`,
);
write('src/styles.css', `body {\n  font-family: system-ui, sans-serif;\n}`);

// Workspace config, following what \`ng new\` writes for a v22 standalone app.
const rootPkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const v = (pkg) => rootPkg.devDependencies[pkg];
write(
  'package.json',
  JSON.stringify(
    {
      name,
      private: true,
      description: `Generated by corpus/generate.mjs v${GENERATOR_VERSION}; resolves dependencies from the bench repo root.`,
      dependencies: Object.fromEntries(
        ['@angular/common', '@angular/compiler', '@angular/core', '@angular/platform-browser', '@angular/router', 'rxjs', 'tslib'].map((p) => [p, v(p)]),
      ),
      devDependencies: Object.fromEntries(
        ['@angular/build', '@angular/cli', '@angular/compiler-cli', 'typescript'].map((p) => [p, v(p)]),
      ),
    },
    null,
    2,
  ),
);
write(
  'angular.json',
  JSON.stringify(
    {
      $schema: './node_modules/@angular/cli/lib/config/schema.json',
      version: 1,
      newProjectRoot: 'projects',
      cli: {analytics: false},
      projects: {
        [name]: {
          projectType: 'application',
          root: '',
          sourceRoot: 'src',
          prefix: 'app',
          architect: {
            build: {
              builder: '@angular/build:application',
              options: {
                browser: 'src/main.ts',
                index: 'src/index.html',
                tsConfig: 'tsconfig.app.json',
                styles: ['src/styles.css'],
              },
              configurations: {
                production: {outputHashing: 'all'},
                development: {optimization: false, extractLicenses: false, sourceMap: true},
              },
              defaultConfiguration: 'production',
            },
          },
        },
      },
    },
    null,
    2,
  ),
);
write(
  'tsconfig.json',
  JSON.stringify(
    {
      compileOnSave: false,
      compilerOptions: {
        strict: true,
        noImplicitOverride: true,
        noPropertyAccessFromIndexSignature: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        skipLibCheck: true,
        isolatedModules: true,
        experimentalDecorators: true,
        importHelpers: true,
        target: 'ES2022',
        module: 'preserve',
      },
      angularCompilerOptions: {
        enableI18nLegacyMessageIdFormat: false,
        strictInjectionParameters: true,
        strictInputAccessModifiers: true,
        strictTemplates: true,
      },
      files: [],
      references: [{path: './tsconfig.app.json'}],
    },
    null,
    2,
  ),
);
write(
  'tsconfig.app.json',
  JSON.stringify(
    {
      extends: './tsconfig.json',
      // TypeScript 6 requires rootDir whenever outDir is set (TS5011).
      compilerOptions: {outDir: './out-tsc/app', rootDir: './src', types: []},
      include: ['src/**/*.ts'],
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------------------------------------
// Write, then record what was written.

const sorted = [...files.keys()].sort();
const hash = createHash('sha256');
for (const rel of sorted) hash.update(rel + '\0' + files.get(rel) + '\0');

const count = (pred) => sorted.filter(pred).length;
const manifest = {
  name,
  generatorVersion: GENERATOR_VERSION,
  seed: SEED,
  components: N,
  breakdown: {
    root: 1,
    pages: features.length,
    featureChildren: featureComps.length - features.length,
    shared: shared.length + 1,
    pipes: pipes.length,
    directives: directives.length,
    stores: features.length,
  },
  files: {
    total: sorted.length,
    ts: count((f) => f.endsWith('.ts')),
    html: count((f) => f.endsWith('.html')),
    css: count((f) => f.endsWith('.css')),
  },
  templateFeatures: {
    deferBlocks: allUsers.reduce((n, c) => n + c.deferred.size, 0),
    externalTemplates: allUsers.filter((c) => c.externalTemplate).length,
    onPush: allUsers.filter((c) => c.onPush).length,
  },
  sha256: hash.digest('hex'),
};
write('manifest.json', JSON.stringify(manifest, null, 2));

await fs.rm(outDir, {recursive: true, force: true});
for (const [rel, content] of files) {
  const abs = path.join(outDir, rel);
  await fs.mkdir(path.dirname(abs), {recursive: true});
  await fs.writeFile(abs, content);
}
if (path.relative(root, outDir).startsWith('..')) {
  await fs.symlink(path.join(root, 'node_modules'), path.join(outDir, 'node_modules'), 'dir');
}

const totalComponents =
  1 + manifest.breakdown.pages + manifest.breakdown.featureChildren + manifest.breakdown.shared;
if (totalComponents !== N) throw new Error(`generated ${totalComponents} components, expected ${N}`);

console.log(
  `${name}: ${N} components (${features.length} features), ${pipes.length} pipes, ` +
    `${directives.length} directives, ${manifest.files.total} files -> ${path.relative(process.cwd(), outDir)}`,
);
console.log(`sha256 ${manifest.sha256}`);
