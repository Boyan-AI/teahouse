<script setup lang="ts">
import { ref } from 'vue'
import { tr } from '../utils/i18n'
import type { BoardInvite } from '../../../shared/board-games'
const props = defineProps<{ invite: BoardInvite }>()
const failed = ref(false)
const pending = ref(false)
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
  <button type="button" :disabled="pending" @click="open">{{ tr(invite.game === 'gomoku' ? '五子棋邀请' : '象棋邀请') }} · {{ tr(failed ? '房间不可用或已结束' : '进入棋盘 / 旁观') }}</button>
</template>
