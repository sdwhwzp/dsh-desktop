import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { Gateway, serverOrigin, companionEndpoint } from '../src/main/remote/gateway'
import { FolderStore, type FolderGrant } from '../src/main/remote/folder-store'
import { FolderConnection } from '../src/main/remote/connection'
import { RemoteController } from '../src/main/remote/controller'
import { executeOperation } from '../vendor/local-workspace/local-workspace-cli'

const TEST_SERVER = 'https://server.example:3081'
const roots: string[] = []
const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}, 20_000)
// Match fs/promises.realpath, including Windows short-name expansion in runner temp paths.
function root(): string { const value = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-remote-'))); roots.push(value); return value }
const secrets = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 37)),
  decryptString: (value: Buffer) => Buffer.from(value.map(byte => byte ^ 37)).toString()
}
function grant(folder = root()): FolderGrant {
  return { id: 'workspace-fixture', server: TEST_SERVER, accountId: 2, root: folder, name: 'Fixture', enabled: true, endpoint: 'ws://127.0.0.1:1', token: 't'.repeat(43), desktopControl: false }
}
function config(folder: string) { return { root: folder, server: '', deviceName: '', workspaceId: '', workspaceName: '', shellEnabled: true, desktopControl: false } }
async function wsFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  disposers.push(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Expected TCP listener')
  return { server, endpoint: `ws://127.0.0.1:${address.port}` }
}

describe('remote gateway login', () => {
  it('accepts exact origins and rejects credentials, paths and non-HTTP targets', () => {
    expect(serverOrigin(TEST_SERVER + '/')).toBe(TEST_SERVER)
    for (const value of ['file:///etc', 'http://user:pass@server', TEST_SERVER + '/gateway', TEST_SERVER + '?token=secret']) {
      expect(() => serverOrigin(value)).toThrow()
    }
    expect(companionEndpoint(TEST_SERVER, { port: 3082, secure: true, publicUrl: '' })).toBe('wss://server.example:3082/')
    expect(() => companionEndpoint('https://example.test', { publicUrl: 'ws://example.test' })).toThrow()
  })
  it('validates the authenticated account ID from server state, without accepting a renderer identity', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, me: { username: 'alice', role: 'user' }, users: [{ id: 2, username: 'alice' }] }))
    const gateway = new Gateway(TEST_SERVER, fetcher)
    expect(await gateway.account()).toEqual({ id: 2, username: 'alice', role: 'user' })
    expect(fetcher).toHaveBeenCalledWith(TEST_SERVER + '/api/dsh-passwords/state', expect.objectContaining({ credentials: 'include', redirect: 'error' }))
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, me: { username: 'alice', role: 'user' }, users: [{ id: 3, username: 'bob' }] }))
    await expect(gateway.account()).rejects.toThrow('账号编号')
  })
})

describe('saved local folder grants', () => {
  it('encrypts credentials and isolates the same folder by origin and account', () => {
    const file = join(root(), 'folders.enc')
    const store = new FolderStore(file, secrets)
    const row = grant()
    store.save(row)
    expect(readFileSync(file, 'utf8')).not.toContain(row.token)
    const loaded = new FolderStore(file, secrets)
    expect(loaded.list(TEST_SERVER, 2)).toEqual([row])
    expect(loaded.list(TEST_SERVER, 3)).toEqual([])
    expect(loaded.list('https://other.test', 2)).toEqual([])
    expect(() => new FolderStore(join(root(), 'blocked'), { ...secrets, isEncryptionAvailable: () => false }).save(row)).toThrow('钥匙串')
  })
})

describe('companion connection', () => {
  it('retries a saved folder after the initial account check fails', async () => {
    const { server, endpoint } = await wsFixture()
    const row = { ...grant(), endpoint }
    server.on('connection', peer => peer.once('message', () => {
      peer.send(JSON.stringify({ type: 'ready', workspaceId: row.id }))
    }))
    const authorize = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('temporary network failure'))
    const client = new FolderConnection(row, authorize, vi.fn(), () => {}, () => {})
    disposers.push(() => client.stop())
    await expect(client.connect()).rejects.toThrow('temporary network failure')
    await vi.waitFor(() => expect(client.snapshot()).toBe('已连接'), { timeout: 5000 })
    expect(authorize).toHaveBeenCalledTimes(3)
  }, 7000)
  it('retries when account verification fails after the resume handshake', async () => {
    const { server, endpoint } = await wsFixture()
    const row = { ...grant(), endpoint }
    server.on('connection', peer => peer.once('message', () => {
      peer.send(JSON.stringify({ type: 'ready', workspaceId: row.id }))
    }))
    const authorize = vi.fn(async () => undefined)
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('temporary network failure'))
    const client = new FolderConnection(row, authorize, vi.fn(), () => {}, () => {})
    disposers.push(() => client.stop())
    await expect(client.connect()).rejects.toThrow('temporary network failure')
    await vi.waitFor(() => expect(client.snapshot()).toBe('已连接'), { timeout: 5000 })
  }, 7000)
  it('cancels an account-check retry when the folder is stopped', async () => {
    vi.useFakeTimers()
    try {
      const authorize = vi.fn(async () => { throw new Error('temporary network failure') })
      const client = new FolderConnection(grant(), authorize, vi.fn(), () => {}, () => {})
      disposers.push(() => client.stop())
      await expect(client.connect()).rejects.toThrow('temporary network failure')
      client.stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(authorize).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
  it('pairs with shell enabled, authorizes each operation and cancels work on disconnect', async () => {
    const { server, endpoint } = await wsFixture()
    const row = { ...grant(), endpoint, token: '' }
    let socket!: WebSocket
    const authorize = vi.fn(async () => undefined)
    let pendingSignal: AbortSignal | undefined
    const execute = vi.fn(async (_root, _op, _args, signal: AbortSignal) => {
      pendingSignal = signal
      return { lines: ['fixture'] }
    })
    server.on('connection', peer => {
      socket = peer
      peer.once('message', raw => {
        const hello = JSON.parse(raw.toString())
        expect(hello).toMatchObject({ type: 'pair', code: 'c'.repeat(43), shellEnabled: true, root: row.root })
        peer.send(JSON.stringify({ type: 'ready', workspaceId: row.id, workspacePath: '/virtual/root', token: 't'.repeat(43) }))
      })
    })
    const save = vi.fn()
    const client = new FolderConnection(row, authorize, execute, save, () => {})
    disposers.push(() => client.stop())
    await client.connect('c'.repeat(43))
    expect(save).toHaveBeenCalled()
    const response = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'request', id: 'read', operation: 'read', args: { path: 'fixture.txt' } }))
    expect(JSON.parse((await response)[0].toString())).toMatchObject({ ok: true, value: { lines: ['fixture'] } })
    expect(authorize).toHaveBeenCalledTimes(3)
    const shell = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'request', id: 'shell', operation: 'bash', args: { command: 'git status' } }))
    expect(JSON.parse((await shell)[0].toString()).ok).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(4)
    const blocked = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'request', id: 'unsupported', operation: 'office', args: {} }))
    expect(JSON.parse((await blocked)[0].toString()).ok).toBe(false)
    expect(execute).toHaveBeenCalledTimes(2)
    execute.mockImplementationOnce(async (_root, _op, _args, signal) => {
      pendingSignal = signal
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { lines: [] }
    })
    socket.send(JSON.stringify({ type: 'request', id: 'pending', operation: 'read', args: { path: 'fixture.txt' } }))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3))
    const closed = once(socket, 'close')
    client.stop()
    expect(pendingSignal?.aborted).toBe(true)
    await closed
  })
  it.each(['read', 'bash', 'files'])('refuses %s if authentication changes before a request', async operation => {
    const { server, endpoint } = await wsFixture()
    const row = { ...grant(), endpoint }
    let socket!: WebSocket
    server.on('connection', peer => { socket = peer; peer.once('message', raw => {
      expect(JSON.parse(raw.toString())).toMatchObject({ type: 'resume', shellEnabled: true })
      peer.send(JSON.stringify({ type: 'ready', workspaceId: row.id }))
    }) })
    let allowed = true
    const execute = vi.fn()
    const client = new FolderConnection(row, async () => { if (!allowed) throw new Error('账号已退出') }, execute, () => {}, () => {})
    disposers.push(() => client.stop())
    await client.connect()
    allowed = false
    const response = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'request', id: 'private', operation, args: { path: 'secret', command: 'git status' } }))
    expect(JSON.parse((await response)[0].toString()).ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('account transition', () => {
  it('cancels a native directory selection when the user logs out during the dialog', async () => {
    const gateway = new Gateway(TEST_SERVER, async () => Response.json({ ok: true, me: { username: 'alice', role: 'user' }, users: [{ id: 2, username: 'alice' }] }))
    const controller = new RemoteController(gateway, new FolderStore(join(root(), 'store'), secrets), vi.fn(), () => {})
    disposers.push(() => controller.dispose())
    await controller.refresh()
    let select!: (path: string) => void
    const operation = controller.add(() => new Promise(resolve => { select = resolve }))
    const failure = expect(operation).rejects.toThrow('账号已切换')
    await vi.waitFor(() => expect(select).toBeTypeOf('function'))
    controller.invalidate()
    select(root())
    await failure
    expect(controller.snapshot().folders).toEqual([])
  })
})

describe('selected-folder filesystem operations', () => {
  it('lists and previews selected-folder files without Shell', async () => {
    const folder = root()
    writeFileSync(join(folder, '中文 文件.txt'), 'content')
    const run = (args: Record<string, unknown>) => executeOperation({ ...config(folder), shellEnabled: false }, 'files', args, new AbortController().signal)
    expect(await run({ action: 'list', path: '.' })).toMatchObject({ entries: [{ name: '中文 文件.txt', type: 'file' }] })
    expect(await run({ action: 'readBytes', path: '中文 文件.txt' })).toMatchObject({ data: Buffer.from('content').toString('base64'), eof: true })
    await expect(run({ action: 'readBytes', path: '../outside' })).rejects.toThrow()
  })
  it('reads, creates and edits files while rejecting traversal and outside symlinks', async () => {
    const folder = root()
    const outside = root()
    writeFileSync(join(folder, 'note.txt'), 'first line')
    writeFileSync(join(outside, 'secret.txt'), 'private')
    const invoke = (op: 'read' | 'write' | 'edit' | 'glob', args: Record<string, unknown>) => executeOperation(config(folder), op, args, new AbortController().signal)
    expect(await invoke('read', { path: 'note.txt' })).toMatchObject({ lines: [{ text: 'first line' }] })
    await invoke('write', { path: 'sub/new.txt', content: 'hello' })
    await invoke('edit', { path: 'sub/new.txt', oldString: 'hello', newString: 'updated' })
    expect(readFileSync(join(folder, 'sub/new.txt'), 'utf8')).toBe('updated')
    await expect(invoke('read', { path: '../secret.txt' })).rejects.toThrow()
    await expect(invoke('write', { path: '../outside.txt', content: 'bad' })).rejects.toThrow()
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(folder, 'escape'))
      await expect(invoke('read', { path: 'escape/secret.txt' })).rejects.toThrow()
      await expect(invoke('write', { path: 'escape/new.txt', content: 'bad' })).rejects.toThrow()
    }
  })
})


describe('local workspace terminal', () => {
  it('switches a disposable Git repository to wzp using the platform shell', async () => {
    const folder = root()
    const controller = new AbortController()
    const operation = executeOperation(config(folder), 'bash', {
      command: 'git init -q; git checkout -b wzp; git branch --show-current', timeoutMs: 10000
    }, controller.signal)
    // Stop and join the command before afterEach removes its working directory, including test timeouts.
    disposers.push(async () => { controller.abort(); await Promise.allSettled([operation]) })
    const result = await operation
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
    expect(readFileSync(join(folder, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/wzp\n')
    await expect(executeOperation(config(folder), 'bash', { command: 'git status', workdir: '..' }, new AbortController().signal)).rejects.toThrow()
  // The command owns a 10 s deadline; the test also waits for shell startup and process-tree cleanup.
  }, 20_000)
  it('does not start a command cancelled before execution', async () => {
    const folder = root()
    await expect(executeOperation(config(folder), 'bash', { command: 'echo should-not-run' }, AbortSignal.abort())).rejects.toThrow()
  })
})

describe('desktop control grant', () => {
  it('loads grants written before desktop control existed as ungranted', () => {
    const file = join(root(), 'folders.enc')
    const legacy = { ...grant() } as Partial<FolderGrant>
    delete legacy.desktopControl
    writeFileSync(file, secrets.encryptString(JSON.stringify([legacy])).toString('base64'))
    const loaded = new FolderStore(file, secrets).list(TEST_SERVER, 2)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.desktopControl).toBe(false)
  })

  it('announces the grant in its handshake and refuses desktop operations without it', async () => {
    const { server, endpoint } = await wsFixture()
    const row = { ...grant(), endpoint, desktopControl: false }
    let socket!: WebSocket
    const execute = vi.fn(async () => ({ ok: true }))
    server.on('connection', peer => {
      socket = peer
      peer.once('message', raw => {
        expect(JSON.parse(raw.toString())).toMatchObject({ type: 'resume', desktopControl: false })
        peer.send(JSON.stringify({ type: 'ready', workspaceId: row.id, workspacePath: '/virtual/root' }))
      })
    })
    const client = new FolderConnection(row, async () => undefined, execute, vi.fn(), () => {})
    disposers.push(() => client.stop())
    await client.connect()
    for (const operation of ['screenshot', 'input']) {
      const response = once(socket, 'message')
      socket.send(JSON.stringify({ type: 'request', id: operation, operation, args: {} }))
      expect(JSON.parse((await response)[0].toString())).toMatchObject({ ok: false, error: '此目录未开启桌面控制' })
    }
    // The refusal happens before the worker is asked to do anything.
    expect(execute).not.toHaveBeenCalled()
  })

  it('carries the grant to the worker once the folder has it', async () => {
    const { server, endpoint } = await wsFixture()
    const row = { ...grant(), endpoint, desktopControl: true }
    let socket!: WebSocket
    const execute = vi.fn(async () => ({ cursor: { x: 1, y: 2 } }))
    server.on('connection', peer => {
      socket = peer
      peer.once('message', raw => {
        expect(JSON.parse(raw.toString())).toMatchObject({ desktopControl: true })
        peer.send(JSON.stringify({ type: 'ready', workspaceId: row.id, workspacePath: '/virtual/root' }))
      })
    })
    const client = new FolderConnection(row, async () => undefined, execute, vi.fn(), () => {})
    disposers.push(() => client.stop())
    await client.connect()
    const response = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'request', id: '1', operation: 'input', args: { action: 'left_click' } }))
    expect(JSON.parse((await response)[0].toString())).toMatchObject({ ok: true })
    expect(execute).toHaveBeenCalledWith(row.root, 'input', { action: 'left_click' }, expect.anything(), true)
  })

  it('refuses a desktop operation the companion was not granted', async () => {
    const folder = root()
    const signal = new AbortController().signal
    for (const operation of ['screenshot', 'input'] as const) {
      // Shell being on is deliberately not enough; the grants are separate.
      await expect(executeOperation(config(folder), operation, { action: 'left_click' }, signal))
        .rejects.toMatchObject({ code: 'DESKTOP_CONTROL_DISABLED' })
    }
  })
})
