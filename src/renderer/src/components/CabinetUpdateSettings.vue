<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, NSelect, NSwitch } from 'naive-ui'
import { useUpdateStore } from '../stores/update'
import { usePeersStore } from '../stores/peers'
import { cabinetPeerName } from '../stores/cabinet'
import { useShareBrowser } from '../utils/share-browser'
import { tr, language } from '../utils/i18n'
import { formatBytes } from '../utils/format'
import { CAPS } from '../../../shared/protocol'
import { CABINET_UPDATE_ERROR_TEXT, type CabinetUpdateState } from '../../../shared/cabinet-update'
import PantryIcon from './PantryIcon.vue'

// 关于页内的更新设置沿用文件柜目录浏览与主题控件，只提交节点身份和柜内相对目录。
const update = useUpdateStore()
const pantry = window.pantry
const peers = usePeersStore()
const source = ref('')
const directory = ref('')
const browsing = ref(false)
const saving = ref(false)
const actionError = ref('')
const browser = useShareBrowser(() => source.value || null)
const state = computed(() => update.cabinet)
const busy = computed(() => !!state.value && ['checking', 'downloading', 'verifying', 'installing'].includes(state.value.status))
const options = computed(() => {
  const choices = peers.peers.filter(peer => peer.caps.includes(CAPS.fileCabinet)).map(peer => ({ value: peer.nodeId,
    label: cabinetPeerName(peer) + (peer.online ? '' : tr('（离线）')) }))
  if (state.value?.config.nodeId && !choices.some(choice => choice.value === state.value!.config.nodeId)) {
    choices.push({ value: state.value.config.nodeId, label: (state.value.sourceName || state.value.config.nodeId) + tr('（离线）') })
  }
  return choices
})
const folders = computed(() => browser.entries.value.filter(entry => entry.isDir))
const statusText = computed(() => {
  const value = state.value
  if (!value) return tr('正在加载')
  if (value.status === 'error') return tr(CABINET_UPDATE_ERROR_TEXT[value.error ?? ''] ?? CABINET_UPDATE_ERROR_TEXT['update-failed'])
  if (value.status === 'checking') return tr('正在检查更新清单…')
  if (value.status === 'downloading') return tr('正在下载 {0} / {1}', { 0: formatBytes(value.bytes), 1: formatBytes(value.manifest?.size ?? 0) })
  if (value.status === 'verifying') return tr('正在校验安装包…')
  if (value.status === 'installing') return tr('正在准备安装并重启…')
  if (value.packageReady) return tr('安装包已就绪')
  if (value.status === 'latest') return tr('该目录中没有更高版本')
  if (value.status === 'available') return tr('可更新至 v{0}', { 0: value.manifest?.version ?? '' })
  return value.config.nodeId ? tr('尚未检查') : tr('选择可信发布者的文件柜与更新目录。')
})

/** 统一处理 IPC 错误，操作失败不丢失当前来源设置。 */
async function action(operation: () => Promise<CabinetUpdateState | null>): Promise<void> {
  actionError.value = ''
  try { const next = await operation(); if (next) update.cabinet = next }
  catch { actionError.value = tr('操作失败，请重试。') }
}

/** 切换候选来源时清空目录浏览，不改变已保存的固定发布者。 */
function selectSource(nodeId: string | null): void {
  source.value = nodeId ?? ''
  directory.value = ''
  browsing.value = false
  browser.resetBrowse()
}

/** 浏览器沿用普通文件柜权限与分页，选择的只是目录位置。 */
async function browse(): Promise<void> {
  browsing.value = true
  await browser.load(directory.value)
}

/** 用户确认采用当前浏览目录，随后通过保存动作生效。 */
function useDirectory(): void { directory.value = browser.path.value; browsing.value = false }

/** 保存只传配置字段，主进程再次规范化并撤销旧来源任务。 */
async function save(): Promise<void> {
  saving.value = true
  try { await action(() => window.pantry.configureCabinetUpdate({ nodeId: source.value, directory: directory.value, autoCheck: state.value?.config.autoCheck ?? true })) }
  finally { saving.value = false }
}

/** 自动检查开关即时保存，不会同时提交尚未保存的来源草稿。 */
async function toggleAutomatic(autoCheck: boolean): Promise<void> {
  if (state.value) await action(() => window.pantry.configureCabinetUpdate({ ...state.value!.config, autoCheck }))
}

onMounted(async () => {
  await Promise.all([update.init(), peers.init()])
  source.value = state.value?.config.nodeId ?? ''
  directory.value = state.value?.config.directory ?? ''
})
</script>

<template>
  <section class="cabinet-update-settings" aria-labelledby="cabinet-update-heading">
    <h3 id="cabinet-update-heading">{{ tr('文件柜更新') }}</h3>
    <p class="hint">{{ tr('仅使用你信任的发布者。下载与安装前会请你确认。') }}</p>
    <div class="source-fields">
      <label for="cabinet-update-source">{{ tr('发布者') }}</label>
      <NSelect id="cabinet-update-source" :value="source || null" :options="options" :placeholder="tr('选择文件柜')"
        :disabled="busy || saving" clearable filterable @update:value="selectSource" />
      <label for="cabinet-update-directory">{{ tr('更新目录') }}</label>
      <div class="directory-field">
        <NInput id="cabinet-update-directory" v-model:value="directory" :placeholder="tr('留空使用文件柜根目录')" :disabled="busy || saving" />
        <NButton :disabled="!source || busy || saving" @click="browse">{{ tr('浏览') }}</NButton>
      </div>
    </div>
    <div v-if="browsing" class="folder-picker" :aria-busy="browser.loading.value">
      <div class="folder-toolbar">
        <NButton size="small" :disabled="!browser.path.value || browser.loading.value" @click="browser.goUp">{{ tr('上一级') }}</NButton>
        <span>{{ browser.path.value || tr('文件柜根目录') }}</span>
        <NButton size="small" :disabled="browser.loading.value || !!browser.failReason.value" @click="useDirectory">{{ tr('使用此目录') }}</NButton>
      </div>
      <p v-if="browser.failText.value" role="alert">{{ browser.failText.value }}</p>
      <p v-else-if="browser.loading.value">{{ tr('正在加载') }}</p>
      <ul v-else class="folder-list">
        <li v-for="folder in folders" :key="folder.name"><button type="button" @click="browser.load(browser.childPath(folder.name))">
          <PantryIcon name="folder" :size="16" /><span>{{ folder.name }}</span>
        </button></li>
        <li v-if="!folders.length" class="hint">{{ tr('当前页没有子目录') }}</li>
      </ul>
      <NButton v-if="browser.hasMore.value" size="small" :loading="browser.loadingMore.value" @click="browser.loadMore">{{ tr('加载更多') }}</NButton>
      <p v-if="browser.moreFailText.value" role="alert">{{ browser.moreFailText.value }}</p>
    </div>
    <div class="save-row"><NButton :disabled="busy" :loading="saving" @click="save">{{ tr('保存更新源') }}</NButton></div>
    <div class="automatic-row">
      <div><label for="cabinet-auto-check">{{ tr('自动检查更新') }}</label><p class="hint">{{ tr('启动后检查，运行期间每 30 分钟检查一次。') }}</p></div>
      <NSwitch id="cabinet-auto-check" :value="state?.config.autoCheck ?? true" :disabled="busy || saving" @update:value="toggleAutomatic" />
    </div>
    <div class="update-status" aria-live="polite" :aria-busy="busy">
      <strong>{{ statusText }}</strong>
      <small v-if="state?.checkedAt">{{ tr('上次检查 {0}', { 0: new Date(state.checkedAt).toLocaleString(language) }) }}</small>
      <p v-if="state?.manifest && ['available', 'ready'].includes(state.status)" class="release-notes">{{ state.manifest.notes }}</p>
      <progress v-if="state?.status === 'downloading'" :value="state.bytes" :max="state.manifest?.size || 1" :aria-label="tr('更新下载进度')" />
      <p v-if="actionError" role="alert">{{ actionError }}</p>
    </div>
    <div class="actions">
      <NButton :disabled="busy || !state?.config.nodeId" @click="action(pantry.checkCabinetUpdate)">{{ tr('立即检查') }}</NButton>
      <NButton v-if="state?.packageReady" type="primary" :disabled="busy" @click="action(pantry.installCabinetUpdate)">{{ tr('安装并重启') }}</NButton>
      <NButton v-else-if="state?.manifest && state.status !== 'latest'" type="primary" :disabled="busy" @click="action(pantry.downloadCabinetUpdate)">{{ tr('下载并更新') }}</NButton>
      <NButton v-if="busy && state?.status !== 'installing'" @click="action(pantry.cancelCabinetUpdate)">{{ tr('取消') }}</NButton>
    </div>
  </section>
</template>

<style scoped>
.cabinet-update-settings { margin: 16px 20px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--text-1); font-size: 13px; }
h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
p { margin: 6px 0; line-height: 1.6; }
.hint, small { color: var(--text-2); font-size: 12px; font-weight: 400; }
.source-fields { display: grid; grid-template-columns: 74px minmax(0, 1fr); align-items: center; gap: 12px; margin-top: 18px; }
.directory-field, .folder-toolbar { display: flex; gap: 8px; align-items: center; min-width: 0; }
.directory-field > :first-child { flex: 1; min-width: 0; }
.save-row { display: flex; justify-content: flex-end; margin: 12px 0 20px; }
.automatic-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); }
.automatic-row p { margin-bottom: 0; }
.folder-picker { padding: 12px; margin-top: 12px; border: 1px solid var(--line); border-radius: 8px; }
.folder-toolbar { flex-wrap: wrap; }
.folder-toolbar span { flex: 1; overflow-wrap: anywhere; min-width: 60px; }
.folder-list { list-style: none; padding: 0; margin: 10px 0; max-height: 180px; overflow-y: auto; }
.folder-list button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.folder-list button:hover { background: var(--surface-hover); }
.folder-list button:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.folder-list span { overflow-wrap: anywhere; }
.update-status { display: grid; gap: 6px; padding: 14px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.update-status strong { font-weight: 500; line-height: 1.6; }
.release-notes { white-space: pre-wrap; max-height: 140px; overflow-y: auto; }
progress { width: 100%; accent-color: var(--primary); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 600px) { .source-fields { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
</style>
