import { describe, expect, it, vi } from 'vitest'
import type { MenuItem, MenuItemConstructorOptions } from 'electron'
import { remoteEditMenu } from '../src/main/remote/editing'

function target() {
  return { undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), isDestroyed: vi.fn(() => false) }
}

function items(menu: MenuItemConstructorOptions) {
  if (!Array.isArray(menu.submenu)) throw new Error('Expected edit commands')
  return menu.submenu
}

describe('remote edit menu', () => {
  it('directs edits to the currently displayed contents instead of the window shell', () => {
    const server = target()
    const local = target()
    let active = server
    const menu = remoteEditMenu(() => active, 'darwin', 'zh-CN')
    const itemStub: Partial<MenuItem> = {}
    const event = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, triggeredByAccelerator: false }
    for (const command of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const) {
      const item = items(menu).find(item => item.id === `remote-${command}`)
      if (!item?.click) throw new Error('Edit command missing')
      active = server
      item.click(itemStub as MenuItem, undefined, event)
      expect(server[command]).toHaveBeenCalledOnce()
      expect(local[command]).not.toHaveBeenCalled()
      active = local
      item.click(itemStub as MenuItem, undefined, event)
      expect(local[command]).toHaveBeenCalledOnce()
      active.isDestroyed.mockReturnValue(true)
      item.click(itemStub as MenuItem, undefined, event)
      expect(local[command]).toHaveBeenCalledOnce()
      active.isDestroyed.mockReturnValue(false)
    }
  })

  it.each([
    ['darwin', 'zh-CN', '编辑', '复制', 'CmdOrCtrl+Shift+Z'],
    ['win32', 'en-US', 'Edit', 'Copy', 'Ctrl+Y']
  ] as const)('keeps native accelerators and localized menu labels on %s', (platform, locale, label, copyLabel, redo) => {
    const menu = remoteEditMenu(() => undefined, platform, locale)
    expect(menu.label).toBe(label)
    expect(items(menu).find(item => item.id === 'remote-copy')).toMatchObject({ label: copyLabel, accelerator: 'CmdOrCtrl+C' })
    expect(items(menu).find(item => item.id === 'remote-paste')).toMatchObject({ accelerator: 'CmdOrCtrl+V' })
    expect(items(menu).find(item => item.id === 'remote-redo')).toMatchObject({ accelerator: redo })
  })
})
