import type { Session, WebContents } from 'electron'

type PermissionSession = Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>
type PermissionOwner = Pick<WebContents, 'getURL' | 'isDestroyed'>

export function installRemotePermissions(
  session: PermissionSession,
  owner: PermissionOwner,
  server: string
): void {
  const origin = new URL(server).origin
  function allowed(contents: WebContents | null, permission: string, requestingUrl: string, isMainFrame: boolean): boolean {
    if (contents !== owner || owner.isDestroyed() || !isMainFrame || permission !== 'clipboard-sanitized-write') return false
    try {
      return [requestingUrl, owner.getURL()].every(value => {
        const url = new URL(value)
        return (url.protocol === 'https:' || url.protocol === 'http:')
          && url.origin === origin && url.username === '' && url.password === ''
      })
    } catch {
      return false
    }
  }
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowed(contents, permission, requestingOrigin, details.isMainFrame)
      && allowed(contents, permission, details.requestingUrl ?? requestingOrigin, details.isMainFrame))
  session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowed(contents, permission, details.requestingUrl, details.isMainFrame)))
}
