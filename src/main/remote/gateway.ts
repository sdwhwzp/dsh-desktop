import type { RemoteAccount } from '../../shared/remote'

/** Only a complete HTTP(S) origin is a desktop connection target. */
export function serverOrigin(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('请输入完整服务器地址，例如 https://server.example:3081')
  return url.origin
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器响应格式错误')
  return value as Record<string, unknown>
}

/** Resolve the existing companion endpoint without changing the selected gateway. */
export function companionEndpoint(server: string, fields: Record<string, unknown>): string {
  const url = new URL(server)
  if (fields.publicUrl) {
    if (typeof fields.publicUrl !== 'string') throw new Error('本机目录连接地址无效')
    const explicit = new URL(fields.publicUrl)
    if (!['ws:', 'wss:'].includes(explicit.protocol) || explicit.username || explicit.password || explicit.hash) {
      throw new Error('本机目录连接地址无效')
    }
    if (url.protocol === 'https:' && explicit.protocol !== 'wss:') throw new Error('HTTPS 服务器需要 WSS 目录连接')
    return explicit.href
  }
  if (!Number.isInteger(fields.port) || Number(fields.port) < 1 || Number(fields.port) > 65535) {
    throw new Error('服务器未配置本机目录端口')
  }
  url.protocol = fields.secure === true ? 'wss:' : 'ws:'
  url.port = String(fields.port)
  if (server.startsWith('https:') && url.protocol !== 'wss:') throw new Error('HTTPS 服务器需要 WSS 目录连接')
  return url.href
}

/** Requests use the BrowserView's authenticated cookie jar and never accept a renderer token. */
export class Gateway {
  constructor(readonly origin: string, private readonly fetcher: typeof fetch, readonly endpointOverride = '') {
    if (endpointOverride) companionEndpoint(origin, { publicUrl: endpointOverride })
  }

  async request(path: string, body?: object): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.origin + path, {
      method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error',
      headers: { Origin: this.origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000), cache: 'no-store'
    })
    if (response.status === 401 || response.status === 403) throw new Error('请先登录有权限的 30 服务器账号')
    if (!response.ok) throw new Error(`服务器请求失败（HTTP ${response.status}）`)
    const result = record(await response.json())
    if (result.ok !== true) throw new Error('服务器未确认操作成功')
    return result
  }

  async account(): Promise<RemoteAccount> {
    const result = await this.request('/api/dsh-passwords/state')
    const me = record(result.me)
    if (typeof me.username !== 'string' || !['admin', 'user'].includes(String(me.role)) || !Array.isArray(result.users)) {
      throw new Error('无法确认登录账号')
    }
    const user = result.users.map(record).find(row => row.username === me.username)
    if (!user || !Number.isSafeInteger(user.id) || Number(user.id) < 1) throw new Error('无法确认登录账号编号')
    return { id: Number(user.id), username: me.username, role: me.role as RemoteAccount['role'] }
  }

  async pair(): Promise<{ code: string; endpoint: string }> {
    const result = record((await this.request('/api/dsh-passwords/local-workspace/pair', {})).pairing)
    if (typeof result.code !== 'string' || !/^[A-Za-z0-9_-]{32,200}$/.test(result.code)) throw new Error('目录授权码无效')
    return { code: result.code, endpoint: companionEndpoint(this.origin, this.endpointOverride ? { publicUrl: this.endpointOverride } : result) }
  }
}
