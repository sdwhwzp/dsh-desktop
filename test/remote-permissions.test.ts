import { describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'
import { installRemotePermissions } from '../src/main/remote/permissions'

const origin = 'https://server.example:3081'

function fixture() {
  const currentUrl = vi.fn(() => origin + '/conversation')
  const destroyed = vi.fn(() => false)
  const stub: Partial<WebContents> = { getURL: currentUrl, isDestroyed: destroyed }
  const owner = stub as WebContents
  const session = {
    setPermissionCheckHandler: vi.fn<Session['setPermissionCheckHandler']>(),
    setPermissionRequestHandler: vi.fn<Session['setPermissionRequestHandler']>()
  }
  installRemotePermissions(session, owner, origin)
  const check = session.setPermissionCheckHandler.mock.calls[0]?.[0]
  const request = session.setPermissionRequestHandler.mock.calls[0]?.[0]
  if (!check || !request) throw new Error('Permission handlers were not installed')
  return { owner, currentUrl, destroyed, check, request }
}

describe('remote page clipboard permissions', () => {
  it('allows copy through both permission handlers for the configured main page', () => {
    const { owner, check, request } = fixture()
    expect(check(owner, 'clipboard-sanitized-write', origin, {
      requestingUrl: origin + '/conversation', isMainFrame: true
    })).toBe(true)
    const callback = vi.fn()
    request(owner, 'clipboard-sanitized-write', callback, {
      requestingUrl: origin + '/conversation', isMainFrame: true
    })
    expect(callback).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each(['clipboard-read', 'media', 'geolocation', 'notifications'] as const)('keeps %s denied', permission => {
    const { owner, check, request } = fixture()
    expect(check(owner, permission, origin, { isMainFrame: true })).toBe(false)
    const callback = vi.fn()
    request(owner, permission, callback, { requestingUrl: origin, isMainFrame: true })
    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  })

  it.each([
    'https://other.example:3081',
    'https://server.example:3082',
    'http://server.example:3081',
    'https://user:password@server.example:3081',
    'invalid-url'
  ])('rejects copy from a different or invalid requesting URL: %s', requestingUrl => {
    const { owner, check, request } = fixture()
    expect(check(owner, 'clipboard-sanitized-write', origin, { requestingUrl, isMainFrame: true })).toBe(false)
    expect(check(owner, 'clipboard-sanitized-write', requestingUrl, { requestingUrl: origin, isMainFrame: true })).toBe(false)
    const callback = vi.fn()
    request(owner, 'clipboard-sanitized-write', callback, { requestingUrl, isMainFrame: true })
    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('denies subframes and unowned contents, including workers', () => {
    const { owner, check, request } = fixture()
    expect(check(owner, 'clipboard-sanitized-write', origin, { isMainFrame: false })).toBe(false)
    expect(check(null, 'clipboard-sanitized-write', origin, { isMainFrame: true })).toBe(false)
    const other = fixture().owner
    expect(check(other, 'clipboard-sanitized-write', origin, { isMainFrame: true })).toBe(false)
    for (const [contents, isMainFrame] of [[owner, false], [other, true]] as const) {
      const callback = vi.fn()
      request(contents, 'clipboard-sanitized-write', callback, { requestingUrl: origin, isMainFrame })
      expect(callback).toHaveBeenCalledExactlyOnceWith(false)
    }
  })

  it('revokes copy when the owner navigates away or is destroyed', () => {
    const { owner, currentUrl, destroyed, check, request } = fixture()
    for (const url of ['https://other.example', 'about:blank']) {
      currentUrl.mockReturnValue(url)
      expect(check(owner, 'clipboard-sanitized-write', origin, { isMainFrame: true })).toBe(false)
      const callback = vi.fn()
      request(owner, 'clipboard-sanitized-write', callback, { requestingUrl: origin, isMainFrame: true })
      expect(callback).toHaveBeenCalledExactlyOnceWith(false)
    }
    currentUrl.mockReturnValue(origin)
    destroyed.mockReturnValue(true)
    expect(check(owner, 'clipboard-sanitized-write', origin, { isMainFrame: true })).toBe(false)
    const callback = vi.fn()
    request(owner, 'clipboard-sanitized-write', callback, { requestingUrl: origin, isMainFrame: true })
    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  })
})
