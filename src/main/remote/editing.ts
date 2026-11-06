import type { MenuItemConstructorOptions, WebContents } from 'electron'

type EditTarget = Pick<WebContents, 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'isDestroyed'>

export function remoteEditMenu(
  target: () => EditTarget | undefined,
  platform: NodeJS.Platform,
  locale: string
): MenuItemConstructorOptions {
  const chinese = locale.toLowerCase().startsWith('zh')
  const commands = [
    ['undo', '撤销', 'Undo', 'CmdOrCtrl+Z'],
    ['redo', '重做', 'Redo', platform === 'darwin' ? 'CmdOrCtrl+Shift+Z' : 'Ctrl+Y'],
    ['cut', '剪切', 'Cut', 'CmdOrCtrl+X'],
    ['copy', '复制', 'Copy', 'CmdOrCtrl+C'],
    ['paste', '粘贴', 'Paste', 'CmdOrCtrl+V'],
    ['selectAll', '全选', 'Select all', 'CmdOrCtrl+A']
  ] as const
  const submenu: MenuItemConstructorOptions[] = commands.map(([command, zh, en, accelerator]) => ({
    id: `remote-${command}`,
    label: chinese ? zh : en,
    accelerator,
    click: () => {
      const contents = target()
      if (contents && !contents.isDestroyed()) contents[command]()
    }
  }))
  submenu.splice(2, 0, { type: 'separator' })
  return { label: chinese ? '编辑' : 'Edit', submenu }
}
