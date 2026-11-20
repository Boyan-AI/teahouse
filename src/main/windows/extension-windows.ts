import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IpcChannels, type SettingsView } from '../../shared/ipc'
import { resolveDevRendererUrl } from '../util/renderer-url'
import { applyWindowZoom } from '../util/window-zoom'

/** 扩展窗口统一安全边界；每个房间绑定唯一 webContents，不能跨房间提交动作。 */
export class ExtensionWindows {
  private readonly windows = new Map<string, BrowserWindow>()
  constructor(private readonly deps: {
    settings(): SettingsView
    mayClose(key: string, win: BrowserWindow): boolean
    closed(key: string): void
  }) {}

  /** 独立 renderer 根避免把棋盘和表单资源并入主窗口静态闭包。 */
  open(key: string, route: 'agents' | 'board' | 'stickers', title: string): void {
    const previous = this.windows.get(key)
    if (previous && !previous.isDestroyed()) { previous.show(); previous.focus(); return }
    const settings = this.deps.settings()
    const win = new BrowserWindow({ width: route === 'board' ? 780 : 850, height: 820, minWidth: 580, minHeight: 620,
      show: false, title, backgroundColor: settings.theme === 'dark' ? '#171e29' : '#ffffff',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
    this.windows.set(key, win); win.setMenuBarVisibility(false)
    applyWindowZoom(win.webContents, settings.fontScale)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    let nativeReady = false, appearanceReady = false
    /** 同时等待原生绘制和主题应用，防止首次开窗闪白。 */
    const reveal = (): void => { if (nativeReady && appearanceReady && !win.isDestroyed()) win.show() }
    win.once('ready-to-show', () => { nativeReady = true; reveal() })
    win.webContents.on('ipc-message', (_event, channel) => { if (channel === IpcChannels.uiSettingsReady) { appearanceReady = true; reveal() } })
    win.on('close', event => { if (!this.deps.mayClose(key, win)) event.preventDefault() })
    win.on('closed', () => { this.windows.delete(key); this.deps.closed(key) })
    const hash = '/' + route + (route === 'board' ? '?room=' + encodeURIComponent(key) : '')
    const url = resolveDevRendererUrl(process.env['ELECTRON_RENDERER_URL'], hash, app.isPackaged)
    if (url) void win.loadURL(url)
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }

  /** 跟随全局设置更新已打开窗口的字体倍率。 */
  sync(settings: SettingsView): void {
    for (const win of this.windows.values()) if (!win.isDestroyed()) applyWindowZoom(win.webContents, settings.fontScale)
  }

  /** 所有敏感管理和走子 IPC 必须验证来源窗口，而非只信任参数。 */
  owns(event: IpcMainInvokeEvent, key: string): boolean { return this.windows.get(key)?.webContents === event.sender }
  /** 仅向对应扩展窗口推送状态，不广播 Agent 配置到无关窗口。 */
  send(key: string, channel: string, payload: unknown): void {
    const win = this.windows.get(key)
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
