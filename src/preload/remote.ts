import { ipcRenderer } from 'electron'
import type { RemoteState } from '../shared/remote'

window.addEventListener('DOMContentLoaded', () => {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const server = element<HTMLInputElement>('server')
  const companion = element<HTMLInputElement>('companion')
  const folders = element<HTMLDivElement>('folders')
  const notice = element<HTMLParagraphElement>('notice')
  let busy = false
  let actionError: string | undefined
  let state: RemoteState | undefined

  function render(next?: RemoteState): void {
    const previous = state
    if (next) state = next
    if (!state) return
    if (!previous || previous.server !== state.server) server.value = state.server
    if (!previous || previous.companion !== state.companion) companion.value = state.companion
    element('account').textContent = state.account ? `${state.account.username} · ${state.account.role === 'admin' ? '管理员' : '普通账号'}` : '未登录'
    element<HTMLButtonElement>('add').disabled = busy || !state.account
    element<HTMLButtonElement>('logout').disabled = busy || !state.account
    element('connection').textContent = state.error ? '连接需检查' : state.account ? '服务器已连接' : state.server ? '等待登录' : '请填写服务器'
    notice.textContent = actionError ?? state.error ?? (state.account ? '选择目录后，可在服务器工作区列表中使用。' : state.server ? '请点击「返回会话」，使用原有账号和密码登录。' : '填写服务器地址并连接，然后使用已有账号登录。')
    folders.replaceChildren()
    if (!state.folders.length) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '还没有接入本机目录'
      folders.appendChild(empty)
    }
    for (const folder of state.folders) {
      const row = document.createElement('article')
      row.className = 'folder'
      const details = document.createElement('div')
      const name = document.createElement('strong')
      name.textContent = folder.name
      const path = document.createElement('p')
      path.className = 'path'
      path.textContent = folder.root
      const status = document.createElement('p')
      status.className = folder.status === '已连接' ? 'online' : 'muted'
      status.textContent = folder.status
      details.append(name, path, status)
      const actions = document.createElement('div')
      actions.className = 'actions'
      const toggle = document.createElement('button')
      toggle.textContent = folder.enabled ? '断开' : '连接'
      toggle.disabled = busy
      toggle.onclick = () => { void act(folder.enabled ? 'disable' : 'enable', folder.id) }
      const remove = document.createElement('button')
      remove.textContent = '移除接入'
      remove.disabled = busy
      remove.onclick = () => { void act('remove', folder.id) }
      actions.append(toggle, remove)
      row.append(details, actions)
      folders.appendChild(row)
    }
  }
  async function act(action: string, value?: unknown): Promise<void> {
    if (busy) return
    busy = true
    actionError = undefined
    render()
    try { render(await ipcRenderer.invoke('remote:action', action, value)) }
    catch (error) { actionError = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败' }
    finally { busy = false; render() }
  }
  for (const id of ['home', 'folders-page', 'reload', 'add', 'logout']) {
    element(id).addEventListener('click', () => { void act(id === 'folders-page' ? 'folders' : id) })
  }
  element('server-form').addEventListener('submit', event => { event.preventDefault(); void act('connect', { server: server.value.trim(), companion: companion.value.trim() }) })
  ipcRenderer.on('remote:changed', (_event, next: RemoteState) => render(next))
  void ipcRenderer.invoke('remote:state').then(render)
})
