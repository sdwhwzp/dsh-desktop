import { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, session, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Gateway, serverOrigin } from './remote/gateway'
import { FolderStore } from './remote/folder-store'
import { RemoteController } from './remote/controller'
import { executeFile } from './remote/filesystem-process'

app.setName('梯智 AI Desktop')
app.setPath('userData', process.env.DSH_REMOTE_USER_DATA || join(app.getPath('appData'), 'tizhi-ai-desktop'))
let window: BrowserWindow
let view: WebContentsView | undefined
let controller: RemoteController | undefined
let timer: NodeJS.Timeout | undefined
let removeCookieListener: (() => void) | undefined
let showingFolders = false
let stopped = false
const shellFile = join(__dirname, '../remote/index.html')
const shellUrl = pathToFileURL(shellFile).href

function trusted(event: IpcMainInvokeEvent): void {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== shellUrl) throw new Error('只允许桌面管理页调用此操作')
}
function snapshot() {
  return controller?.snapshot() ?? { server: '', companion: '', account: null, folders: [], error: null }
}
function publish(): void {
  if (!stopped && window && !window.isDestroyed()) window.webContents.send('remote:changed', snapshot())
}
function layout(): void {
  if (!view || window.isDestroyed()) return
  const [width = 1000, height = 700] = window.getContentSize()
  view.setBounds({ x: 0, y: 64, width, height: Math.max(0, height - 64) })
  view.setVisible(!showingFolders)
}
function external(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

async function connect(target: string, companion = ''): Promise<void> {
  const origin = serverOrigin(target)
  removeCookieListener?.()
  controller?.dispose()
  clearInterval(timer)
  if (view) { window.contentView.removeChildView(view); view.webContents.close(); view = undefined }
  const partition = `persist:remote-${createHash('sha256').update(origin).digest('hex')}`
  const browserSession = session.fromPartition(partition)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  const store = new FolderStore(join(app.getPath('userData'), 'folders.enc'), safeStorage)
  controller = new RemoteController(new Gateway(origin, browserSession.fetch.bind(browserSession) as typeof fetch, companion), store, executeFile, publish)
  const current = controller
  const cookieChanged = (_event: unknown, cookie: Electron.Cookie) => {
    if (cookie.name !== 'dsh_gateway_token') return
    current.invalidate()
    void current.refresh()
  }
  browserSession.cookies.on('changed', cookieChanged)
  browserSession.webRequest.onBeforeRequest({ urls: [`${origin}/gateway/logout*`] }, (_details, callback) => {
    current.invalidate()
    callback({})
  })
  removeCookieListener = () => {
    browserSession.cookies.removeListener('changed', cookieChanged)
    browserSession.webRequest.onBeforeRequest(null)
  }
  view = new WebContentsView({ webPreferences: {
    session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
  } })
  window.contentView.addChildView(view)
  const remoteView = view
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); external(url) }
  }
  remoteView.webContents.on('will-navigate', guardNavigation)
  remoteView.webContents.on('will-redirect', guardNavigation)
  remoteView.webContents.on('will-attach-webview', event => event.preventDefault())
  remoteView.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) void remoteView.webContents.loadURL(url)
    else external(url)
    return { action: 'deny' }
  })
  remoteView.webContents.on('did-finish-load', () => { void current.refresh() })
  remoteView.webContents.on('render-process-gone', () => { current.invalidate(); publish() })
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(join(app.getPath('userData'), 'server.json'), JSON.stringify({ server: origin, companion }), { mode: 0o600 })
  showingFolders = false
  layout()
  publish()
  timer = setInterval(() => { void current.refresh() }, 5_000)
  try { await remoteView.webContents.loadURL(origin) } catch {
    if (view === remoteView) {
      showingFolders = true
      layout()
      await current.refresh()
      publish()
    }
  }
}

async function bootstrap(): Promise<void> {
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 840, minHeight: 560,
    title: '山东梯智物联 AI', backgroundColor: '#f8fafc',
    webPreferences: { preload: join(__dirname, '../preload/remote.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('resize', layout)
  window.on('close', () => app.quit())
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: '梯智 AI', submenu: [{ role: 'about' as const }, { role: 'quit' as const }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ label: '刷新服务器页面', accelerator: 'CmdOrCtrl+R', click: () => view?.webContents.reload() }, { role: 'togglefullscreen' }, { role: 'minimize' }] }
  ]))
  ipcMain.handle('remote:state', event => { trusted(event); return snapshot() })
  let busy = false
  ipcMain.handle('remote:action', async (event, action: unknown, value: unknown) => {
    trusted(event)
    if (busy) throw new Error('请等待当前操作完成')
    busy = true
    try {
      if (action === 'connect' && value && typeof value === 'object' && 'server' in value && 'companion' in value && typeof value.server === 'string' && typeof value.companion === 'string') await connect(value.server, value.companion)
      else if (action === 'folders' || action === 'home') {
        showingFolders = action === 'folders'
        layout()
      } else if (action === 'reload') view?.webContents.reload()
      else if (action === 'add') await controller?.add(async () => {
        const result = await dialog.showOpenDialog(window, { title: '选择允许当前账号读写的本机目录', properties: ['openDirectory'] })
        return result.canceled ? null : result.filePaths[0] ?? null
      })
      else if ((action === 'enable' || action === 'disable') && typeof value === 'string') await controller?.setEnabled(value, action === 'enable')
      else if (action === 'remove' && typeof value === 'string') await controller?.remove(value)
      else if (action === 'logout' && controller) {
        const origin = controller.gateway.origin
        controller.invalidate()
        await view?.webContents.session.fetch(origin + '/gateway/logout', { method: 'POST', credentials: 'include', headers: { Origin: origin }, redirect: 'follow' })
        await view?.webContents.loadURL(origin + '/gateway/login')
        showingFolders = false
        layout()
      } else throw new Error('未知桌面操作')
      return snapshot()
    } finally { busy = false }
  })
  await window.loadFile(shellFile)
  let target = ''
  let companion = ''
  try {
    const settings = JSON.parse(readFileSync(join(app.getPath('userData'), 'server.json'), 'utf8'))
    target = serverOrigin(settings.server)
    companion = typeof settings.companion === 'string' ? settings.companion : ''
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('服务器设置不可用，请重新填写') }
  if (target) await connect(target, companion)
  else { showingFolders = true; publish() }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.on('before-quit', () => {
    stopped = true
    clearInterval(timer)
    removeCookieListener?.()
    controller?.dispose()
  })
  app.whenReady().then(bootstrap).catch(error => {
    dialog.showErrorBox('桌面端启动失败', error instanceof Error ? error.message : '未知错误')
    app.quit()
  })
}
