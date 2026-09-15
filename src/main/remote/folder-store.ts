import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Each grant belongs to one gateway origin and immutable account ID. */
export interface FolderGrant {
  id: string; server: string; accountId: number; root: string; name: string
  enabled: boolean; endpoint: string; token: string
  /** Whether the agent may capture this screen and drive its mouse and keyboard. */
  desktopControl: boolean
}

export interface SecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** OS-encrypted grants; an unavailable keychain fails closed instead of storing plaintext. */
export class FolderStore {
  private rows: FolderGrant[] = []
  constructor(private readonly file: string, private readonly secrets: SecretStorage) {
    let data: string
    try { data = readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed: unknown = JSON.parse(this.secrets.decryptString(Buffer.from(data, 'base64')))
    if (!Array.isArray(parsed) || !parsed.every(isGrant)) throw new Error('本机目录授权记录损坏，请恢复备份')
    this.rows = parsed.map(row => ({ ...row, desktopControl: row.desktopControl === true }))
  }
  list(server: string, accountId: number): FolderGrant[] {
    return this.rows.filter(row => row.server === server && row.accountId === accountId).map(row => ({ ...row }))
  }
  save(grant: FolderGrant): void {
    this.commit([...this.rows.filter(row => row.id !== grant.id), { ...grant }])
  }
  remove(id: string): void { this.commit(this.rows.filter(row => row.id !== id)) }
  private commit(rows: FolderGrant[]): void {
    if (!this.secrets.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法保存本机目录授权')
    const encoded = this.secrets.encryptString(JSON.stringify(rows)).toString('base64')
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, encoded, { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.file)
    this.rows = rows
  }
}

function isGrant(value: unknown): value is FolderGrant {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  // Grants written before desktop control existed omit the field; they load as
  // ungranted rather than being rejected as corrupt.
  return ['id', 'server', 'root', 'name', 'endpoint', 'token'].every(key => typeof row[key] === 'string') &&
    Number.isSafeInteger(row.accountId) && Number(row.accountId) > 0 && typeof row.enabled === 'boolean' &&
    (row.desktopControl === undefined || typeof row.desktopControl === 'boolean')
}
