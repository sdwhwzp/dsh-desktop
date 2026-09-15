import os from 'node:os'
import WebSocket from 'ws'
import type { FolderGrant } from './folder-store'
import { record } from './gateway'

export type FileOperation = 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'bash' | 'files' | 'screenshot' | 'input'
export type ExecuteFile = (
  root: string,
  operation: FileOperation,
  args: Record<string, unknown>,
  signal: AbortSignal,
  desktopControl: boolean
) => Promise<unknown>
const fileOperations = new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'files'])
/** Operations that observe or drive the screen, admitted only by a granted folder. */
const desktopOperations = new Set(['screenshot', 'input'])
const MAX_FRAME = 3 * 1024 * 1024

/** One outbound, account-bound connection. Stop aborts operations and disables all reconnects. */
export class FolderConnection {
  private socket?: WebSocket
  private timer?: NodeJS.Timeout
  private stopped = false
  private generation = 0
  private running = new Map<string, AbortController>()
  private status = '连接中'
  constructor(
    readonly grant: FolderGrant,
    private readonly authorize: () => Promise<void>,
    private readonly execute: ExecuteFile,
    private readonly save: (grant: FolderGrant) => void,
    private readonly changed: () => void
  ) {}

  snapshot(): string { return this.status }
  stop(): void {
    this.stopped = true
    this.generation++
    clearTimeout(this.timer)
    this.socket?.terminate()
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }

  async connect(code?: string): Promise<void> {
    const generation = ++this.generation
    clearTimeout(this.timer)
    try { await this.authorize() } catch (error) {
      if (!this.stopped && generation === this.generation) {
        this.setStatus('账号验证失败，正在重试')
        if (this.grant.token) this.retry()
      }
      throw error
    }
    if (this.stopped || generation !== this.generation) throw new Error('目录连接已取消')
    this.setStatus('连接中')
    const socket = new WebSocket(this.grant.endpoint, { maxPayload: MAX_FRAME, handshakeTimeout: 10_000, followRedirects: false })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let authenticated = false
      let fatal = false
      const alive = () => !this.stopped && this.socket === socket && generation === this.generation
      const timeout = setTimeout(() => { reject(new Error('本机目录连接超时，请检查服务器目录端口')); socket.terminate() }, 15_000)
      socket.once('open', () => {
        if (!alive()) { socket.terminate(); return }
        socket.send(JSON.stringify({
          type: code ? 'pair' : 'resume', ...(code ? { code } : { token: this.grant.token }),
          protocol: 2, workspaceId: this.grant.id, root: this.grant.root,
          workspaceName: this.grant.name, deviceName: os.hostname().slice(0, 80), platform: process.platform,
          shellEnabled: true, desktopControl: this.grant.desktopControl
        }))
      })
      socket.on('message', raw => {
        if (!alive()) return
        void (async () => {
          const message = record(JSON.parse(raw.toString()))
          if (message.type === 'error') {
            fatal = true
            throw new Error('目录授权失效，请移除此接入后重新选择目录')
          }
          if (message.type === 'ready') {
            if (authenticated || message.workspaceId !== this.grant.id) throw new Error('目录连接身份不匹配')
            if (message.token !== undefined) {
              if (typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{32,300}$/.test(message.token)) throw new Error('目录凭据无效')
              this.grant.token = message.token
            }
            if (!this.grant.token) throw new Error('服务器未返回目录凭据')
            try { await this.authorize() } catch (error) {
              if (!alive()) return
              this.setStatus('账号验证失败，正在重试')
              reject(error)
              socket.terminate()
              return
            }
            if (!alive()) return
            this.save(this.grant)
            authenticated = true
            clearTimeout(timeout)
            this.setStatus('已连接')
            resolve()
            return
          }
          if (!authenticated) throw new Error('服务器在授权完成前请求文件')
          if (message.type === 'cancel' && typeof message.id === 'string') {
            this.running.get(message.id)?.abort()
            return
          }
          if (message.type !== 'request' || typeof message.id !== 'string' || message.id.length > 200 ||
              this.running.has(message.id)) throw new Error('目录请求格式错误')
          const id = message.id
          const controller = new AbortController()
          if (this.running.size >= 8) throw new Error('并发目录请求过多')
          this.running.set(id, controller)
          try {
            const operation = String(message.operation)
            // The grant this socket authenticated with decides what it admits;
            // turning desktop control on replaces the connection rather than
            // widening this one.
            if (desktopOperations.has(operation) && !this.grant.desktopControl) {
              throw new Error('此目录未开启桌面控制')
            }
            if (!fileOperations.has(operation) && !desktopOperations.has(operation)) {
              throw new Error('此接入仅支持文件、终端与桌面操作')
            }
            const args = record(message.args)
            await this.authorize()
            if (!alive() || controller.signal.aborted) return
            const value = await this.execute(
              this.grant.root, operation as FileOperation, args, controller.signal, this.grant.desktopControl
            )
            if (alive() && !controller.signal.aborted) socket.send(JSON.stringify({ type: 'response', id, ok: true, value }))
          } catch (error) {
            if (alive()) socket.send(JSON.stringify({ type: 'response', id, ok: false, code: 'LOCAL_ACCESS_FAILED', error: error instanceof Error ? error.message : '文件操作失败' }))
          } finally { this.running.delete(id) }
        })().catch(error => {
          fatal = true
          this.setStatus(error instanceof Error ? error.message : '目录协议错误')
          reject(error)
          socket.terminate()
        })
      })
      socket.on('error', () => { reject(new Error('无法连接本机目录服务，请检查服务器目录端口')) })
      socket.once('close', () => {
        clearTimeout(timeout)
        for (const controller of this.running.values()) controller.abort()
        this.running.clear()
        reject(new Error('本机目录连接已关闭'))
        if (!alive() || fatal) return
        this.setStatus('连接断开，正在重试')
        if (this.grant.token) this.retry()
      })
    })
  }
  private retry(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (!this.stopped) void this.connect().catch(() => { if (!this.stopped) this.retry() })
    }, 3_000)
  }
  private setStatus(status: string): void { this.status = status; this.changed() }
}
