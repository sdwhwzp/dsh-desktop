import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { RemoteAccount, RemoteState } from '../../shared/remote'
import { FolderConnection, type ExecuteFile } from './connection'
import { FolderStore, type FolderGrant } from './folder-store'
import { Gateway } from './gateway'

/** Owns directory grants across login, logout, account changes and network loss. */
export class RemoteController {
  private account: RemoteAccount | null = null
  private epoch = 0
  private error: string | null = null
  private connections = new Map<string, FolderConnection>()
  private refreshing?: Promise<void>
  private disposed = false
  constructor(readonly gateway: Gateway, private readonly store: FolderStore,
    private readonly execute: ExecuteFile, private readonly changed: () => void) {}

  snapshot(): RemoteState {
    return { server: this.gateway.origin, companion: this.gateway.endpointOverride, account: this.account, error: this.error,
      folders: this.account ? this.store.list(this.gateway.origin, this.account.id).map(grant => ({
        id: grant.id, root: grant.root, name: grant.name, enabled: grant.enabled,
        desktopControl: grant.desktopControl,
        status: this.connections.get(grant.id)?.snapshot() ?? (grant.enabled ? '等待连接' : '已断开')
      })) : [] }
  }

  /** Invalidating a cookie immediately cancels access, including an in-flight native picker. */
  invalidate(): void {
    this.epoch++
    this.account = null
    for (const connection of this.connections.values()) connection.stop()
    this.connections.clear()
    this.changed()
  }
  dispose(): void { this.disposed = true; this.invalidate() }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const epoch = this.epoch
    this.refreshing = (async () => {
      try {
        const account = await this.gateway.account()
        if (epoch !== this.epoch || this.disposed) return
        if (this.account && this.account.id !== account.id) this.invalidate()
        this.account = account
        this.error = null
        for (const grant of this.store.list(this.gateway.origin, account.id)) {
          if (grant.enabled && !this.connections.has(grant.id)) this.start(grant)
        }
      } catch (error) {
        if (epoch !== this.epoch || this.disposed) return
        this.invalidate()
        this.error = error instanceof Error ? error.message : '无法连接服务器'
      } finally { this.changed() }
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  async add(pick: () => Promise<string | null>): Promise<void> {
    await this.refresh()
    const owner = this.requireAccount()
    const epoch = this.epoch
    const selected = await pick()
    if (!selected) return
    await this.authorize(owner.id, epoch)
    const root = await realpath(selected)
    if (!(await stat(root)).isDirectory()) throw new Error('请选择一个目录')
    const existing = this.store.list(this.gateway.origin, owner.id).find(row => row.root === root)
    if (existing) { await this.setEnabled(existing.id, true); return }
    const pairing = await this.gateway.pair()
    await this.authorize(owner.id, epoch)
    // A new folder never starts with desktop control; the user turns it on for
    // that folder afterwards, which reconnects with the grant in its handshake.
    const grant: FolderGrant = { id: randomUUID(), server: this.gateway.origin, accountId: owner.id,
      root, name: basename(root).slice(0, 120) || root, enabled: true, token: '', endpoint: pairing.endpoint,
      desktopControl: false }
    const connection = this.start(grant, pairing.code)
    try { await connection.ready } catch (error) {
      connection.client.stop()
      this.connections.delete(grant.id)
      // The server may have provisioned the grant before the acknowledgement was lost.
      if (epoch === this.epoch && this.account?.id === owner.id) {
        await this.gateway.request('/api/dsh-passwords/local-workspace/revoke', { id: grant.id }).catch(() => undefined)
      }
      throw error
    } finally { this.changed() }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const owner = this.requireAccount()
    await this.authorize(owner.id, this.epoch)
    const grant = this.ownedGrant(id)
    this.connections.get(id)?.stop()
    this.connections.delete(id)
    grant.enabled = enabled
    this.store.save(grant)
    if (enabled) this.start(grant)
    this.changed()
  }
  /**
   * Turn desktop control on or off for one folder.
   *
   * The grant travels in the companion handshake, so the live connection is
   * replaced rather than updated: a socket that authenticated without the grant
   * must not start answering screen captures.
   * @param id - the folder to change.
   * @param desktopControl - the new grant.
   */
  async setDesktopControl(id: string, desktopControl: boolean): Promise<void> {
    const owner = this.requireAccount()
    await this.authorize(owner.id, this.epoch)
    const grant = this.ownedGrant(id)
    if (grant.desktopControl === desktopControl) return
    grant.desktopControl = desktopControl
    this.store.save(grant)
    if (grant.enabled) {
      this.connections.get(id)?.stop()
      this.connections.delete(id)
      this.start(grant)
    }
    this.changed()
  }

  async remove(id: string): Promise<void> {
    const grant = this.ownedGrant(id)
    await this.setEnabled(id, false)
    await this.gateway.request('/api/dsh-passwords/local-workspace/revoke', { id: grant.id })
    this.store.remove(id)
    this.changed()
  }
  private ownedGrant(id: string): FolderGrant {
    const account = this.requireAccount()
    const grant = this.store.list(this.gateway.origin, account.id).find(row => row.id === id)
    if (!grant) throw new Error('该目录不属于当前账号')
    return grant
  }
  private requireAccount(): RemoteAccount {
    if (!this.account || this.disposed) throw new Error('请先登录账号')
    return this.account
  }
  private async authorize(id: number, epoch: number): Promise<void> {
    if (this.disposed || epoch !== this.epoch || this.account?.id !== id) throw new Error('账号已切换或退出')
    const current = await this.gateway.account()
    if (this.disposed || epoch !== this.epoch || this.account?.id !== id || current.id !== id) {
      throw new Error('账号已切换或退出')
    }
  }
  private start(grant: FolderGrant, code?: string): { client: FolderConnection; ready: Promise<void> } {
    const epoch = this.epoch
    if (this.gateway.endpointOverride) grant.endpoint = this.gateway.endpointOverride
    const client = new FolderConnection(grant, () => this.authorize(grant.accountId, epoch), this.execute,
      row => this.store.save(row), this.changed)
    this.connections.set(grant.id, client)
    const ready = client.connect(code)
    void ready.catch(error => { this.error = error instanceof Error ? error.message : '本机目录连接失败'; this.changed() })
    return { client, ready }
  }
}
