import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { WebSocketServer } from 'ws'
import { FolderConnection } from '../src/main/remote/connection'
import { RemoteNetwork } from '../src/main/remote/network'

type MockNetworkState = { phase: string; url?: string; loginURL?: string }
const networkMocks = vi.hoisted(() => ({
  start: vi.fn<() => Promise<string>>(), close: vi.fn(async () => {}),
  read: vi.fn(async (): Promise<Record<string, unknown>> => ({ enabled: true })),
  current: { phase: 'disabled' } as MockNetworkState,
  publish: undefined as undefined | ((state: MockNetworkState) => void),
  openExternal: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({ app: { getPath: () => '/fixture', getAppPath: () => '/fixture', isPackaged: false },
  clipboard: {}, dialog: {}, shell: { openExternal: networkMocks.openExternal } }))
vi.mock('../src/main/remote/tsnet', () => ({ readDesktopTsnetConfig: networkMocks.read,
  writeDesktopTsnetAuthKey: vi.fn(),
  writeDesktopTsnetEnabled: vi.fn(), DesktopTsnet: class {
    constructor(_executable: string, _config: unknown, _stateDir: string, publish: (state: MockNetworkState) => void) {
      networkMocks.publish = publish
    }
    start = networkMocks.start
    close = networkMocks.close
    get state() { return networkMocks.current }
  } }))

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

it('waits for the helper before assigning a browser proxy and rejects an enabled network failure', async () => {
  let ready!: (proxy: string) => void
  networkMocks.start.mockImplementationOnce(() => new Promise(resolve => { ready = resolve }))
  const network = new RemoteNetwork()
  disposers.push(() => network.close())
  const browserSession = { setProxy: vi.fn(async () => {}) }
  const preparing = network.prepareSession(browserSession)
  await vi.waitFor(() => expect(networkMocks.start).toHaveBeenCalled())
  expect(browserSession.setProxy).not.toHaveBeenCalled()
  ready('http://127.0.0.1:34567')
  await preparing
  expect(browserSession.setProxy).toHaveBeenCalledWith(expect.objectContaining({ proxyRules: 'http://127.0.0.1:34567' }))
  networkMocks.start.mockRejectedValueOnce(new Error('helper unavailable'))
  const failed = new RemoteNetwork()
  disposers.push(() => failed.close())
  const unusedSession = { setProxy: vi.fn(async () => {}) }
  await expect(failed.prepareSession(unusedSession)).rejects.toThrow('helper unavailable')
  expect(unusedSession.setProxy).not.toHaveBeenCalled()
})

it('publishes sanitized private-network state and opens login only when requested', async () => {
  networkMocks.read.mockResolvedValueOnce({
    enabled: true, hostname: 'fixture', controlURL: 'https://headscale.example.com/',
    routes: [], authKey: 'tskey-auth-private',
  })
  networkMocks.current = { phase: 'connecting' }
  networkMocks.start.mockResolvedValueOnce('http://127.0.0.1:34568')
  const changed = vi.fn()
  const network = new RemoteNetwork(changed)
  disposers.push(() => network.close())
  await network.start()
  expect(network.settings()).toMatchObject({ enabled: true, hasAuthKey: true, phase: 'connecting', error: null })
  expect(JSON.stringify(network.settings())).not.toContain('tskey-auth-private')

  networkMocks.current = { phase: 'needs-login', loginURL: 'https://headscale.example.com/register/device' }
  networkMocks.publish?.(networkMocks.current)
  expect(changed).toHaveBeenCalled()
  expect(network.settings().phase).toBe('needs-login')
  await network.openLogin()
  expect(networkMocks.openExternal).toHaveBeenCalledWith('https://headscale.example.com/register/device')

  networkMocks.current = { phase: 'error' }
  networkMocks.publish?.(networkMocks.current)
  expect(network.settings()).toMatchObject({ phase: 'error', error: expect.stringContaining('连接失败') })
})

it('sends the original companion hostname and port through CONNECT and retains account authorization', async () => {
  const target = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  disposers.push(async () => { for (const peer of target.clients) peer.terminate(); await new Promise<void>(resolve => target.close(() => resolve())) })
  await once(target, 'listening')
  const targetAddress = target.address()
  if (!targetAddress || typeof targetAddress === 'string') throw new Error('Missing WebSocket listener')
  target.on('connection', peer => peer.once('message', raw => {
    expect(JSON.parse(raw.toString())).toMatchObject({ type: 'resume', workspaceId: 'private-folder', shellEnabled: true })
    peer.send(JSON.stringify({ type: 'ready', workspaceId: 'private-folder' }))
  }))
  const proxy = createServer()
  const connections = new Set<import('node:stream').Duplex>()
  const requested: string[] = []
  proxy.on('connect', (request, client, head) => {
    requested.push(request.url ?? '')
    const upstream = connect(targetAddress.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    for (const socket of [client, upstream]) {
      connections.add(socket)
      socket.on('error', () => { client.destroy(); upstream.destroy() })
      socket.once('close', () => { connections.delete(socket); client.destroy(); upstream.destroy() })
    }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  disposers.push(async () => { for (const socket of connections) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())) })
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('Missing proxy listener')
  const agent = new HttpsProxyAgent(`http://127.0.0.1:${address.port}`)
  disposers.push(() => agent.destroy())
  const authorize = vi.fn(async () => {})
  const client = new FolderConnection({ id: 'private-folder', server: 'https://private.example:3081', accountId: 2,
    root: '/fixture', name: 'Fixture', enabled: true, desktopControl: false, token: 't'.repeat(43), endpoint: 'ws://private.example:3082/workspace' },
  authorize, async () => ({}), () => {}, () => {}, { agent })
  disposers.push(() => client.stop())
  await client.connect()
  expect(requested).toEqual(['private.example:3082'])
  expect(authorize).toHaveBeenCalledTimes(2)
  expect(client.snapshot()).toBe('已连接')
})
