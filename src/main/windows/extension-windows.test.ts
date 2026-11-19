import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsView } from '../../shared/ipc'
import { IpcChannels } from '../../shared/ipc'
const mocks = vi.hoisted(() => {
  const instances: any[] = []
  return { instances, BrowserWindow: vi.fn(function(this: any, options: unknown) {
    this.options = options; this.handlers = new Map(); const webHandlers = new Map()
    this.webContents = { on: (e: string, f: unknown) => webHandlers.set(e, f), handlers: webHandlers, setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn() }
    this.once = this.on = (e: string, f: unknown) => this.handlers.set(e, f)
    this.setMenuBarVisibility = vi.fn(); this.loadURL = vi.fn(); this.loadFile = vi.fn(); this.show = vi.fn(); this.focus = vi.fn(); this.isDestroyed = () => false
    instances.push(this)
  }) }
})
vi.mock('electron', () => ({ BrowserWindow: mocks.BrowserWindow, app: { isPackaged: true } }))
import { ExtensionWindows } from './extension-windows'
beforeEach(() => { mocks.instances.length = 0 })

/** 原生窗口桩验证生产安全配置、主题门控及调用者归属。 */
function harness() {
  const closed = vi.fn(), mayClose = vi.fn(() => true)
  const windows = new ExtensionWindows({ settings: () => ({ theme: 'dark', fontScale: 100 } as SettingsView), closed, mayClose })
  return { windows, closed, mayClose }
}
describe('扩展独立窗口安全', () => {
  it('只加载本地入口、保持沙箱隔离并等待主题与绘制信号', () => {
    const h = harness(); h.windows.open('r1', 'board', '棋盘')
    const win = mocks.instances[0]
    expect(win.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(win.loadFile).toHaveBeenCalledWith(expect.any(String), { hash: '/board?room=r1' })
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    const preventDefault = vi.fn(); win.webContents.handlers.get('will-navigate')({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce()
    win.handlers.get('ready-to-show')(); expect(win.show).not.toHaveBeenCalled()
    win.webContents.handlers.get('ipc-message')({}, IpcChannels.uiSettingsReady); expect(win.show).toHaveBeenCalledOnce()
  })
  it('房间按窗口复用并隔离调用者，关闭取消不退出对局', () => {
    const h = harness(); h.windows.open('r1', 'board', '棋盘'); h.windows.open('agents', 'agents', 'Agent')
    const win = mocks.instances[0], agent = mocks.instances[1]
    h.windows.open('r1', 'board', '棋盘'); expect(mocks.instances).toHaveLength(2)
    expect(h.windows.owns({ sender: win.webContents } as never, 'r1')).toBe(true)
    expect(h.windows.owns({ sender: agent.webContents } as never, 'r1')).toBe(false)
    h.mayClose.mockReturnValue(false); const preventDefault = vi.fn(); win.handlers.get('close')({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce()
    win.handlers.get('closed')(); expect(h.closed).toHaveBeenCalledWith('r1')
    expect(h.windows.owns({ sender: win.webContents } as never, 'r1')).toBe(false)
  })
})
