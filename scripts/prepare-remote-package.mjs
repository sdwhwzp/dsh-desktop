/** Assemble only the remote client and its WebSocket dependency for distribution. */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'dist/remote-app');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(resolve(root, 'out'), resolve(target, 'out'), { recursive: true });
cpSync(resolve(root, 'node_modules/ws'), resolve(target, 'node_modules/ws'), { recursive: true, dereference: true });
cpSync(resolve(root, 'LICENSE'), resolve(target, 'LICENSE'));
writeFileSync(resolve(target, 'package.json'), JSON.stringify({
  name: 'tizhi-ai-desktop', version: manifest.version, private: true, type: 'module',
  description: 'Tizhi AI desktop client for server 30 and account-owned local folders.',
  author: manifest.author, license: 'MIT', main: 'out/main/index.js',
  dependencies: { ws: manifest.dependencies.ws }
}, null, 2) + '\n');
