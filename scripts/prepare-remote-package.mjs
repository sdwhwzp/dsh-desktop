/** Assemble only the remote client and its WebSocket dependency for distribution. */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'dist/remote-app');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(resolve(root, 'out'), resolve(target, 'out'), { recursive: true });
function copyDependency(name, from, destination) {
  const source = resolve(createRequire(resolve(from, 'package.json')).resolve(name + '/package.json'), '..');
  const output = resolve(destination, 'node_modules', name);
  cpSync(source, output, { recursive: true, dereference: true, filter: path => !path.slice(source.length).split(/[\\/]/).includes('node_modules') });
  const pkg = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyDependency(dependency, source, output);
}
for (const name of ['ws', 'https-proxy-agent']) copyDependency(name, root, target);
cpSync(resolve(root, 'LICENSE'), resolve(target, 'LICENSE'));
writeFileSync(resolve(target, 'package.json'), JSON.stringify({
  name: 'tizhi-ai-desktop', version: manifest.version, private: true, type: 'module',
  description: 'Tizhi AI desktop client for server 30 and account-owned local folders.',
  author: manifest.author, license: 'MIT', main: 'out/main/index.js',
  dependencies: { ws: manifest.dependencies.ws, 'https-proxy-agent': manifest.dependencies['https-proxy-agent'] }
}, null, 2) + '\n');
