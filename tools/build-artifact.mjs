// Builds a single-file page for publishing as an Artifact.
//
//   node tools/build-artifact.mjs [out.html]
//
// The modules are concatenated rather than bundled: imports are stripped, and
// no two modules may declare the same top-level name (checked below). The worker's modules become a string that
// runs from a blob: URL; the page's modules become one inline script.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'dist', 'headwaters.html');

const WORKER_MODULES = ['rng', 'terrain', 'climate', 'landscape', 'species', 'life', 'dams', 'disasters', 'weather', 'tools', 'sim', 'host', 'worker'];
const PAGE_MODULES = ['render', 'save', 'view3d', 'app'];
const WORKER_CALL = "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })";

function load(name) {
  return readFileSync(join(root, 'src', `${name}.js`), 'utf8');
}

function strip(name, src) {
  return src
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .split('\n')
    .filter((line) => !/^export\s*\{.*\}\s*(from\s+['"].*['"])?;?\s*$/.test(line))
    .map((line) => line.replace(/^export\s+(?=(const|let|function|class|async)\b)/, ''))
    .join('\n');
}

function concat(names) {
  const seen = new Map();
  const parts = [];
  for (const name of names) {
    const src = strip(name, load(name));
    for (const m of src.matchAll(/^(?:const|let|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1])) throw new Error(`duplicate top-level "${m[1]}" in ${name}.js and ${seen.get(m[1])}.js`);
      seen.set(m[1], name);
    }
    parts.push(`// --- ${name}.js ---\n${src}`);
  }
  return parts.join('\n');
}

const workerSrc = concat(WORKER_MODULES);
let pageSrc = concat(PAGE_MODULES);
if (!pageSrc.includes(WORKER_CALL)) throw new Error('worker call site not found in app.js');
pageSrc = pageSrc.replace(WORKER_CALL,
  "new Worker(URL.createObjectURL(new Blob([HEADWATERS_WORKER], { type: 'text/javascript' })))");

const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'style.css'), 'utf8');
const title = html.match(/<title>.*<\/title>/)[0];
const viewport = html.match(/<meta name="viewport"[^>]*>/)[0];
const fonts = [...html.matchAll(/<link rel="(?:preconnect|stylesheet)" href="https:\/\/fonts[^>]*>/g)].map((m) => m[0]);
const body = html.slice(html.indexOf('<!-- app:start -->'), html.indexOf('<!-- app:end -->'));

const page = [
  '<meta charset="UTF-8" />',
  viewport,
  title,
  ...fonts,
  `<style>\n${css}\n</style>`,
  body,
  '<script>',
  `const HEADWATERS_WORKER = ${JSON.stringify(workerSrc)};`,
  '(() => {',
  pageSrc,
  '})();',
  '</script>',
  '',
].join('\n');

import('node:fs').then(({ mkdirSync }) => {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page);
  console.log(`wrote ${out} — ${(page.length / 1024).toFixed(0)} KB`);
});
