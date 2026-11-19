<script setup lang="ts">
import { ref } from 'vue'
import { tr } from '../utils/i18n'
import type { BoardInvite } from '../../../shared/board-games'
const props = defineProps<{ invite: BoardInvite }>()
const failed = ref(false)
const pending = ref(false)
/** 历史邀请也由主进程重新验证房间和会话资格，失败时明确显示已不可用。 */
async function open(): Promise<void> {
  if (pending.value) return
  pending.value = true
  try { failed.value = !await window.pantry.openBoardGame(props.invite) }
  catch { failed.value = true }
  finally { pending.value = false }
}
</script>
<template>
  <button type="button" :disabled="pending" @click="open">{{ tr(invite.game === 'gomoku' ? '五子棋邀请' : '象棋邀请') }} · {{ tr(failed ? '房间不可用或已结束' : '进入棋盘 / 旁观') }}</button>
</template>
