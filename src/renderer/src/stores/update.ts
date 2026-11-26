import { defineStore } from 'pinia'
import type { UpdateAvailability } from '../../../shared/ipc'
import type { CabinetUpdateState } from '../../../shared/cabinet-update'

// 局域网自更新提示（决议 #166 第一步：发现与提示）。
// 主进程在节点变化时推送当前可用更新源（同平台、版本更高、声明可作源的在线节点）；无则 null。
export const useUpdateStore = defineStore('update', {
  state: () => ({
    available: null as UpdateAvailability | null,
    cabinet: null as CabinetUpdateState | null,
    initialized: false
  }),
  actions: {
    /** 同步既有 P2P 与文件柜更新状态，每个窗口只注册一次订阅。 */
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      window.pantry.onCabinetUpdate(state => { this.cabinet = state })
      this.cabinet = await window.pantry.getCabinetUpdate()
      this.available = await window.pantry.checkUpdate()
      window.pantry.onUpdateAvailable((info) => {
        this.available = info
      })
    }
  }
})
