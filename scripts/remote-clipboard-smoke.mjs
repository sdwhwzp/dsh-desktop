import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'

const development = process.argv[2] === '--development'
assert(process.argv[2], 'Pass an installed executable or --development')
const executablePath = development ? (await import('electron')).default : resolve(process.argv[2])
const root = await mkdtemp(join(tmpdir(), 'tizhi-clipboard-'))
const marker = '梯智复制检查 • clipboard fixture'
const server = createServer((request, response) => {
  if (request.url.startsWith('/api/')) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{}')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Clipboard fixture</title><button id="copy">复制</button><input id="editor">')
})
let client
let clipboardSnapshot
const checks = []

async function remoteEvaluate(source, gesture = false) {
  return client.evaluate(({ webContents }, { source, gesture }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:'))
    if (!contents) throw new Error('Fixture remote view is unavailable')
    return contents.executeJavaScript(source, gesture)
  }, { source, gesture })
}

async function eventually(check) {
  const deadline = Date.now() + 10000
  for (;;) {
    try { await check(); return } catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(50)
    }
  }
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(root, 'server.json'), JSON.stringify({ server: origin, companion: '' }))
  client = await _electron.launch({
    executablePath, args: development ? [fileURLToPath(new URL('../out/main/index.js', import.meta.url))] : [],
    cwd: root, env: { ...process.env, DSH_REMOTE_USER_DATA: root }, timeout: 30000
  })
  const page = await client.firstWindow()
  await page.locator('#folders-page').click()
  await eventually(async () => assert.match(await page.locator('#network-status').textContent(), /内网已关闭|Private network off/))
  checks.push('fresh configuration connects directly with the private network disabled')
  await page.locator('#home').click()
  await eventually(async () => assert.equal(await remoteEvaluate('document.title'), 'Clipboard fixture'))
  await client.evaluate(({ app, BrowserWindow, webContents }) => {
    app.focus({ steal: true })
    BrowserWindow.getAllWindows()[0].focus()
    webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:')).focus()
  })
  await eventually(async () => assert.equal(await remoteEvaluate('document.hasFocus()'), true))
  await client.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const saved = []
    for (const item of items) {
      const values = {}
      for (const type of item.types) values[type] = await item.getType(type)
      saved.push(values)
    }
    globalThis.__dshClipboardSmokeBackup = saved
  })
  clipboardSnapshot = true
  const copied = await remoteEvaluate(`new Promise(resolve => {
    document.querySelector('#copy').onclick = () => navigator.clipboard.writeText(${JSON.stringify(marker)})
      .then(() => resolve({ok: true}), error => resolve({ok: false, name: error.name}));
    document.querySelector('#copy').click();
  })`, true)
  assert.deepEqual(copied, { ok: true }, 'Remote copy button must be allowed')
  assert.equal(await client.evaluate(({ clipboard }) => clipboard.readText()), marker)
  checks.push('remote copy button writes text to the operating-system clipboard')
  assert.equal(await remoteEvaluate('navigator.clipboard.readText().then(() => true, () => false)', true), false)
  checks.push('remote JavaScript cannot read the clipboard')
  await remoteEvaluate(`document.querySelector('#editor').value = 'Selected text'; document.querySelector('#editor').select()`)
  await client.evaluate(({ BrowserWindow, Menu, webContents }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:'))
    contents.focus()
    const item = Menu.getApplicationMenu().getMenuItemById('remote-copy')
    item.click(item, BrowserWindow.getFocusedWindow(), {})
  })
  await eventually(async () => assert.equal(await client.evaluate(({ clipboard }) => clipboard.readText()), 'Selected text'))
  checks.push('native Edit > Copy command copies selected text')
  await remoteEvaluate("document.querySelector('#editor').value = ''; document.querySelector('#editor').focus()")
  await client.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('remote-paste')
    item.click(item, BrowserWindow.getFocusedWindow(), {})
  })
  await eventually(async () => assert.equal(await remoteEvaluate("document.querySelector('#editor').value"), 'Selected text'))
  checks.push('native Edit > Paste inserts text without granting JavaScript clipboard read')
  const report = JSON.stringify({ success: true, platform: process.platform, checks }, null, 2)
  if (process.argv[3]) await writeFile(resolve(process.argv[3]), report + '\n')
  console.log(report)
} finally {
  if (client) {
    try {
      if (clipboardSnapshot) await client.evaluate(async ({ clipboard, ClipboardItem }) => {
        const saved = globalThis.__dshClipboardSmokeBackup
        if (saved.length) await clipboard.write(saved.map(values => new ClipboardItem(values)))
        else clipboard.clear()
        delete globalThis.__dshClipboardSmokeBackup
      })
    } finally {
      await client.close()
    }
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
