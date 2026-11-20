<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { tr } from '../utils/i18n'
import type { BoardInvite } from '../../../shared/board-games'
const props = defineProps<{ invite: BoardInvite; inviterName?: string }>()
const failed = ref(false)
const pending = ref(false)
/** 仅出现扩展消息时加载独立样式，不把样式加入主窗启动闭包。 */
onMounted(() => { void import('../styles/extension-messages.css') })
/** 只复制协议字段，避免 Vue 响应式代理无法经 Electron IPC 克隆；主进程仍复核资格。 */
async function open(): Promise<void> {
  if (pending.value) return
  pending.value = true
  try {
    const { roomId, hostId, game, groupId, createdAt } = props.invite
    failed.value = !await window.pantry.openBoardGame({ roomId, hostId, game, groupId, createdAt })
  }
  catch { failed.value = true }
  finally { pending.value = false }
}
</script>
<template>
  <article class="board-invite" :aria-label="tr('棋局邀请')">
    <div class="invite-top"><span class="board-symbol" aria-hidden="true">{{ invite.game === 'gomoku' ? '●' : tr('将') }}</span><div><span class="invite-label">{{ tr('棋局邀请') }}</span><h3>{{ tr(invite.game === 'gomoku' ? '五子棋' : '中国象棋') }}</h3></div><span class="players">{{ tr('双人对弈') }}</span></div>
    <p>{{ tr('{0} 邀请你加入棋局', { 0: inviterName || tr('群成员') }) }}</p>
    <div class="invite-meta"><span>{{ tr('可选座位 · 支持旁观') }}</span><small>{{ tr('房间：{0}', { 0: invite.roomId.slice(0, 8) }) }}</small></div>
    <button class="join-board" type="button" :disabled="pending" @click="open">{{ tr(pending ? '正在进入…' : '加入对局 / 旁观') }} <span aria-hidden="true">→</span></button>
    <p v-if="failed" class="invite-error" role="status">{{ tr('房间不可用或已结束') }}</p>
  </article>
</template>
