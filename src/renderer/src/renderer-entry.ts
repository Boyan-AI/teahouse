import type { Component } from 'vue'

export type RendererEntry = 'agents' | 'board' | 'main' | 'settings' | 'capture' | 'image-viewer' | 'remote-view'

type RendererRootModule = { default: Component }

/** 根据本地哈希选择独立根，不加载远程内容。 */
export function resolveRendererEntry(hash: string): RendererEntry {
  if (hash.startsWith('#/agents')) return 'agents'
  if (hash.startsWith('#/board')) return 'board'
  if (hash.startsWith('#/settings')) return 'settings'
  if (hash.startsWith('#/capture')) return 'capture'
  if (hash.startsWith('#/image-viewer')) return 'image-viewer'
  if (hash.startsWith('#/remote-view')) return 'remote-view'
  return 'main'
}

/** 各窗口根显式懒加载，保持资源预算可独立核查。 */
export function loadRendererRoot(entry: RendererEntry): Promise<RendererRootModule> {
  switch (entry) {
    case 'agents': return import('./AgentsApp.vue')
    case 'board': return import('./BoardGameApp.vue')
    case 'remote-view':
      return import('./RemoteViewApp.vue')
    case 'settings':
      return import('./SettingsApp.vue')
    case 'capture':
      return import('./CaptureApp.vue')
    case 'image-viewer':
      return import('./ImageViewerApp.vue')
    case 'main':
      return import('./App.vue')
  }
}
