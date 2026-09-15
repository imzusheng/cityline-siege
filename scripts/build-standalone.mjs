// Bundles dist/index.html plus its JS/CSS into a single portable file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

html = html.replace(/<link[^>]*href="([^"]+\.css)"[^>]*>/g, (_m, href) => {
  const file = path.join(DIST, href.replace(/^\.?\//, ''));
  return '<style>\n' + fs.readFileSync(file, 'utf8') + '\n</style>';
});
html = html.replace(/<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/g, (_m, src) => {
  const file = path.join(DIST, src.replace(/^\.?\//, ''));
  const js = fs.readFileSync(file, 'utf8');
  return '<script type="module">\n' + js + '\n</script>';
});
html = html.replace('<title>', '<!-- CITYLINE standalone build: everything inlined, no server required -->\n<title>');
const out = path.join(ROOT, 'standalone.html');
fs.writeFileSync(out, html);
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`standalone.html written (${kb} KB)`);
