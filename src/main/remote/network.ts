/** Private-network ownership shared by the remote page and the directory WebSocket. */
import { app, clipboard, dialog, shell, type Session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { DesktopTsnet, readDesktopTsnetConfig, writeDesktopTsnetEnabled, type DesktopTsnetConfig } from './tsnet'

export class RemoteNetwork {
  private client?: DesktopTsnet
  private config?: DesktopTsnetConfig
  private proxy?: string
  private failure?: string
  private dialogOpen = false
  private startup?: Promise<void>
  private closed = false
  agent?: HttpsProxyAgent<string>

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('内网连接已关闭，请重启应用'))
    return this.startup ??= this.initialize()
  }

  private async initialize(): Promise<void> {
    try {
      this.config = await readDesktopTsnetConfig(app.getPath('userData'))
      if (!this.config.enabled) return
      const helper = app.isPackaged ? join(process.resourcesPath, 'tsnet') : join(app.getAppPath(), 'build/tsnet')
      this.client = new DesktopTsnet(join(helper, process.platform === 'win32' ? 'dsh-tsnet.exe' : 'dsh-tsnet'),
        this.config, join(app.getPath('userData'), 'desktop/tsnet'), () => {})
      this.proxy = await this.client.start()
      this.agent = new HttpsProxyAgent(this.proxy)
    } catch (error) {
      this.failure = error instanceof Error ? error.message : '内网连接启动失败'
      throw error
    }
  }

  async prepareSession(browserSession: Pick<Session, 'setProxy'>): Promise<void> {
    await this.start()
    if (this.failure) throw new Error(this.failure)
    if (!this.proxy) return
    await browserSession.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy,
      proxyBypassRules: 'localhost;127.0.0.1;[::1]' })
  }

  async show(): Promise<void> {
    if (this.dialogOpen) return
    this.dialogOpen = true
    try {
      const state = this.client?.state
      const actions: Array<{ label: string; run: () => Promise<void> }> = []
      let message = '内网连接已关闭'
      let detail = '内置官方 tsnet，不需要安装系统 VPN 或管理员权限。'
      if (this.failure) { message = '内网连接启动失败'; detail = this.failure }
      else if (state?.phase === 'online') { message = '内网已连接'; detail = state.url }
      else if (state?.phase === 'needs-login') {
        message = '请登录内网账号'
        actions.push({ label: '打开登录页面', run: () => shell.openExternal(state.loginURL) },
          { label: '复制登录链接', run: async () => { clipboard.writeText(state.loginURL) } })
      } else if (state?.phase === 'needs-approval') message = '等待管理员批准此设备'
      else if (state?.phase === 'connecting') message = '正在连接内网'
      else if (state?.phase === 'error') { message = '内网连接失败'; detail = '请检查网络配置，然后重启应用。' }
      actions.push({ label: '打开网络配置', run: async () => {
        const path = join(app.getPath('userData'), 'desktop/tailscale.json')
        if (!existsSync(path)) await writeDesktopTsnetEnabled(app.getPath('userData'), this.config?.enabled ?? false)
        const error = await shell.openPath(path)
        if (error) throw new Error(error)
      } }, { label: this.config?.enabled ? '关闭并重启' : '启用并重启', run: async () => {
        const enabled = !this.config?.enabled
        await writeDesktopTsnetEnabled(app.getPath('userData'), enabled)
        app.relaunch()
        app.quit()
      } })
      const result = await dialog.showMessageBox({ title: '内网连接', message, detail,
        buttons: [...actions.map(action => action.label), '关闭'], cancelId: actions.length, defaultId: actions.length })
      await actions[result.response]?.run()
    } catch (error) {
      dialog.showErrorBox('内网连接', error instanceof Error ? error.message : '操作失败')
    } finally { this.dialogOpen = false }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.startup?.catch(() => {})
    this.agent?.destroy()
    await this.client?.close()
  }
}
