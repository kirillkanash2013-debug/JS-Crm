// Builds the distributable extension into dist/ and a versioned .zip.
// popup.js is minified (comments stripped, names mangled) so the shipped
// code is compact and gives nothing away — but that is only cosmetic. The
// extension holds no secrets and no business logic: it reads the profile's
// token/cookies/proxy and forwards them to the server with the user's own
// key. All real logic (collection, calculations, storage) lives server-side.
import {minify} from 'terser';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const version = manifest.version;
const dist = path.join(dir, 'dist');

fs.rmSync(dist, {recursive: true, force: true});
fs.mkdirSync(dist, {recursive: true});

// popup.js → minified
const src = fs.readFileSync(path.join(dir, 'popup.js'), 'utf8');
const out = await minify(src, {
  compress: {passes: 2},
  mangle: true,
  format: {comments: false},
});
if (out.error) throw out.error;
fs.writeFileSync(path.join(dist, 'popup.js'), out.code);

// Everything else copied verbatim.
for (const f of ['manifest.json', 'popup.html', 'icon.png']) {
  fs.copyFileSync(path.join(dir, f), path.join(dist, f));
}

// Zip the dist contents (flat, so the extension loads from the archive root).
const zipName = `connector-extension-${version}.zip`;
const zipPath = path.join(dir, zipName);
fs.rmSync(zipPath, {force: true});
execFileSync('zip', ['-j', '-q', zipPath, ...fs.readdirSync(dist).map(f => path.join(dist, f))]);

const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
const min = (out.code.length / 1024).toFixed(1);
console.log(`Built ${zipName} (${kb} KB); popup.js minified ${(src.length / 1024).toFixed(1)} KB → ${min} KB`);
