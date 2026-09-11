/** Public desktop state. Device credentials never cross into a renderer. */
export interface RemoteAccount { id: number; username: string; role: 'admin' | 'user' }
export interface RemoteFolder {
  id: string
  root: string
  name: string
  enabled: boolean
  status: string
}
export interface RemoteState {
  server: string
  companion: string
  account: RemoteAccount | null
  folders: RemoteFolder[]
  error: string | null
}
