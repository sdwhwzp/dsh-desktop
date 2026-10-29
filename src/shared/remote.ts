/** Public desktop state. Device credentials never cross into a renderer. */
export interface RemoteAccount { id: number; username: string; role: 'admin' | 'user' }
export interface RemoteFolder {
  id: string
  root: string
  name: string
  enabled: boolean
  /** Whether the agent may capture this screen and drive its mouse and keyboard. */
  desktopControl: boolean
  status: string
}
/** Sanitized private-network settings; authentication keys never cross into the renderer. */
export interface RemoteNetworkSettings {
  enabled: boolean
  hasAuthKey: boolean
  hostname: string
  controlURL: string
  error: string | null
}
export interface RemoteControllerState {
  server: string
  companion: string
  account: RemoteAccount | null
  folders: RemoteFolder[]
  error: string | null
}
export interface RemoteState extends RemoteControllerState {
  network: RemoteNetworkSettings
}
