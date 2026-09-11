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
    assert.equal(hello.shellEnabled, true);
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
async function fileRequest(operation, args, timeout = 15000) {
  const id = `${operation}-${Date.now()}`;
  const socket = activeSocket;
  const response = new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', receive); };
    const receive = raw => {
      const value = JSON.parse(raw.toString());
      if (value.id === id) { cleanup(); resolve(value); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No response for ${id}`)); }, timeout);
    socket.on('message', receive);
  });
  socket.send(JSON.stringify({ type: 'request', id, operation, args }));
  return await response;
}


async function startLongCommand(id) {
  const script = `${id}.cjs`;
  const pidPath = join(folder, `${id}.pid`);
  await writeFile(join(folder, script), `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`);
  // POSIX wait leaves a distinct shell leader, proving descendants are stopped too.
  const command = process.platform === 'win32' ? `node ${script}` : `node ${script} & wait`;
  activeSocket.send(JSON.stringify({ type: 'request', id, operation: 'bash', args: { command, timeoutMs: 60000 } }));
  let pid;
  await eventually(async () => { pid = Number(await readFile(pidPath, 'utf8')); assert.ok(pid > 0); });
  return pid;
}
async function expectStopped(pid) {
  await eventually(async () => {
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  });
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
  const git = await fileRequest('bash', { command: 'git init -q; git checkout -b wzp; git branch --show-current' });
  assert.equal(git.ok, true);
  assert.equal(git.value.exitCode, 0);
  assert.equal(git.value.timedOut, false);
  assert.equal(await readFile(join(folder, '.git/HEAD'), 'utf8'), 'ref: refs/heads/wzp\n');
  assert.equal((await fileRequest('bash', { command: 'git status', workdir: '..' })).ok, false);
  results.push('native file operations and Git branch switch; initial workdir and file traversal rejected');
  await writeFile(join(folder, 'long-command.cjs'), 'setTimeout(() => console.log("long-command-complete"), 31000)');
  const long = await fileRequest('bash', { command: 'node long-command.cjs', timeoutMs: 60000 }, 70000);
  assert.equal(long.ok, true);
  assert.equal(long.value.exitCode, 0);
  assert.equal(long.value.timedOut, false);
  assert.match(long.value.stdout, /long-command-complete/);
  const timed = await fileRequest('bash', { command: 'node long-command.cjs', timeoutMs: 100 });
  assert.equal(timed.ok, true);
  assert.equal(timed.value.timedOut, true);
  results.push('shell can run beyond file-worker 30 s limit and honors its own timeout');
  const cancelledPid = await startLongCommand('cancel-command');
  activeSocket.send(JSON.stringify({ type: 'cancel', id: 'cancel-command' }));
  await expectStopped(cancelledPid);
  results.push('explicit cancellation terminates the running command tree');
  const encrypted = await readFile(join(profile, 'folders.enc'), 'utf8');
  assert.ok(!Buffer.from(encrypted, 'base64').toString().includes(token));
  const logoutPid = await startLongCommand('logout-command');
  const closed = once(activeSocket, 'close');
  await page.locator('#logout').click(); await closed;
  await expectStopped(logoutPid);
  await eventually(async () => assert.match(await page.locator('#account').textContent(), /未登录/));
  await login(page, 'bob');
  assert.equal(await page.locator('.folder').count(), 0);
  await login(page, 'alice');
  await eventually(async () => assert.equal(await page.locator('.online').textContent(), '已连接'));
  results.push('logout disconnects folders; accounts remain isolated; same account resumes');
  const quitPid = await startLongCommand('quit-command');
  await client.close(); client = undefined;
  await expectStopped(quitPid);
  results.push('logout and application quit stop in-flight commands');
  page = await launch();
  await eventually(async () => assert.equal(await page.locator('.online').textContent(), '已连接'));
  assert.equal((await fileRequest('read', { path: '验收/hello.txt' })).ok, true);
  assert.equal((await fileRequest('bash', { command: 'git branch --show-current' })).value.stdout.trim(), 'wzp');
  results.push('encrypted grants, file access and terminal capability survive app restart');
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
