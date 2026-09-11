/** Verify an installed remote client against isolated HTTP/WS fixtures and real file workers. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright';
import { WebSocketServer } from 'ws';

const executablePath = resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Pass the installed desktop executable path');
const reportPath = process.argv[3] && resolve(process.argv[3]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'tizhi-package-smoke-')));
const profile = join(root, 'profile');
const folder = join(root, 'selected-folder');
const code = 'fixture-pair-code-'.repeat(3);
const token = 'fixture-directory-token-'.repeat(3);
const grants = new Map();
let activeSocket;
let client;
const results = [];
const account = request => /dsh_gateway_token=(alice|bob)/.exec(request.headers.cookie || '')?.[1];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const user = account(request);
  if (url.pathname === '/gateway/login' && request.method === 'POST') {
    const name = url.searchParams.get('user');
    assert.ok(name === 'alice' || name === 'bob');
    response.writeHead(200, { 'Set-Cookie': `dsh_gateway_token=${name}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
    response.end('logged in');
  } else if (url.pathname === '/gateway/logout') {
    response.writeHead(200, { 'Set-Cookie': 'dsh_gateway_token=; Path=/; HttpOnly; Max-Age=0' });
    response.end('logged out');
  } else if (url.pathname.startsWith('/api/')) {
    response.setHeader('Content-Type', 'application/json');
    if (!user) { response.statusCode = 401; response.end('{}'); return; }
    if (url.pathname === '/api/dsh-passwords/state') {
      response.end(JSON.stringify({ ok: true, me: { username: user, role: 'user' }, users: [{ id: user === 'alice' ? 2 : 3, username: user }] }));
    } else if (url.pathname.endsWith('/pair')) {
      response.end(JSON.stringify({ ok: true, pairing: { code, port: server.address().port, secure: false } }));
    } else { response.statusCode = 404; response.end('{}'); }
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Remote login fixture</title><h1>Fixture server</h1>');
  }
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', peer => {
  peer.once('message', raw => {
    const hello = JSON.parse(raw.toString());
    assert.equal(hello.protocol, 2);
    assert.equal(hello.shellEnabled, false);
    assert.equal(hello.platform, process.platform);
    assert.equal(hello.root, folder);
    if (hello.type === 'pair') {
      assert.equal(hello.code, code);
      grants.set(hello.workspaceId, token);
    } else {
      assert.equal(hello.type, 'resume');
      assert.equal(hello.token, grants.get(hello.workspaceId));
    }
    activeSocket = peer;
    peer.send(JSON.stringify({ type: 'ready', workspaceId: hello.workspaceId, token }));
  });
});

async function eventually(check) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { await check(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await delay(100);
  }
}
async function remoteEvaluate(expression) {
  return client.evaluate(({ webContents }, source) => {
    const remote = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('http://127.0.0.1:'));
    if (!remote) throw new Error('Fixture view is missing');
    return remote.executeJavaScript(source);
  }, expression);
}
async function launch() {
  client = await _electron.launch({ executablePath, cwd: root, env: { ...process.env, DSH_REMOTE_USER_DATA: profile }, timeout: 30_000 });
  const page = await client.firstWindow();
  await page.locator('#account').waitFor();
  await page.locator('#folders-page').click();
  await client.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, folder);
  return page;
}
async function login(page, user) {
  await remoteEvaluate(`fetch('/gateway/login?user=${user}', {method:'POST'}).then(r => r.text())`);
  await eventually(async () => assert.match(await page.locator('#account').textContent(), new RegExp(user)));
}
async function fileRequest(operation, args) {
  const id = `${operation}-${Date.now()}`;
  const response = once(activeSocket, 'message', { signal: AbortSignal.timeout(15_000) });
  activeSocket.send(JSON.stringify({ type: 'request', id, operation, args }));
  const value = JSON.parse((await response)[0].toString());
  assert.equal(value.id, id);
  return value;
}

try {
  await mkdir(profile); await mkdir(folder);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let page = await launch();
  assert.equal(await page.locator('#server').inputValue(), '');
  assert.equal(await page.locator('#companion').inputValue(), '');
  assert.deepEqual(await client.evaluate(({ webContents }) => webContents.getAllWebContents().map(c => c.getURL()).filter(url => /^https?:/.test(url))), []);
  results.push('first launch leaves both addresses empty and opens no remote page');
  await page.locator('#server').fill(origin);
  await page.locator('#companion').fill(origin.replace('http:', 'ws:'));
  await page.locator('#server-form button').click();
  await eventually(async () => assert.equal(await remoteEvaluate('location.origin'), origin));
  await eventually(async () => assert.match(await page.locator('#account').textContent(), /未登录/));
  await login(page, 'alice');
  await page.locator('#folders-page').click();
  assert.equal(await remoteEvaluate('typeof require'), 'undefined');
  assert.equal(await remoteEvaluate('typeof process'), 'undefined');
  const preferences = await client.evaluate(({ webContents }) => {
    const prefs = webContents.getAllWebContents().find(c => c.getURL().startsWith('http:')).getLastWebPreferences();
    return { sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, preload: prefs.preload || '' };
  });
  assert.deepEqual(preferences, { sandbox: true, nodeIntegration: false, contextIsolation: true, preload: '' });
  results.push('account login and sandboxed remote page');
  await page.locator('#add').click();
  await eventually(async () => assert.equal(await page.locator('.online').textContent(), '已连接'));
  assert.equal((await fileRequest('write', { path: '验收/hello.txt', content: 'native worker verified' })).ok, true);
  assert.equal(await readFile(join(folder, '验收/hello.txt'), 'utf8'), 'native worker verified');
  assert.equal((await fileRequest('read', { path: '验收/hello.txt' })).ok, true);
  assert.equal((await fileRequest('write', { path: '../escape.txt', content: 'must not write' })).ok, false);
  assert.equal((await fileRequest('bash', { command: 'echo forbidden' })).ok, false);
  results.push('native worker read/write; directory traversal and local shell denied');
  const encrypted = await readFile(join(profile, 'folders.enc'), 'utf8');
  assert.ok(!Buffer.from(encrypted, 'base64').toString().includes(token));
  const closed = once(activeSocket, 'close');
  await page.locator('#logout').click(); await closed;
  await eventually(async () => assert.match(await page.locator('#account').textContent(), /未登录/));
  await login(page, 'bob');
  assert.equal(await page.locator('.folder').count(), 0);
  await login(page, 'alice');
  await eventually(async () => assert.equal(await page.locator('.online').textContent(), '已连接'));
  results.push('logout disconnects folders; accounts remain isolated; same account resumes');
  await client.close(); client = undefined;
  page = await launch();
  await eventually(async () => assert.equal(await page.locator('.online').textContent(), '已连接'));
  assert.equal((await fileRequest('read', { path: '验收/hello.txt' })).ok, true);
  results.push('encrypted grants and file access survive app restart');
  const report = { platform: process.platform, arch: process.arch, results, verifiedAt: new Date().toISOString() };
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
} finally {
  try { await client?.close(); }
  finally {
    for (const peer of sockets.clients) peer.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
