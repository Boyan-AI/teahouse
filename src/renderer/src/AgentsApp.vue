<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { tr } from './utils/i18n'
import { applyAppearance } from './utils/appearance'
import type { AgentInput, AgentView } from '../../shared/agents'

const agents = ref<AgentView[]>([])
const error = ref('')
const busy = ref(false)
const form = reactive<AgentInput>({ name: '', persona: '', endpoint: 'http://192.168.1.10:8000', model: '', apiKey: '', enabled: true })
const subscriptions: Array<() => void> = []
/** 编辑不回填密钥，留空表示保留；新建重新生成独立身份。 */
function edit(agent?: AgentView): void {
  Object.assign(form, { id: agent?.id, name: agent?.name ?? '', persona: agent?.persona ?? '',
    endpoint: agent?.endpoint ?? 'http://192.168.1.10:8000', model: agent?.model ?? '', apiKey: '', enabled: agent?.enabled ?? true })
  error.value = ''
}
/** 所有保存错误由主进程返回脱敏文案，不打印含密钥的表单。 */
async function save(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const result = await window.pantry.saveAgent({ ...form })
    if (!result.ok) error.value = tr(result.error || '保存失败')
    else { agents.value = await window.pantry.listAgents(); form.apiKey = ''; edit(agents.value.find(a => a.id === form.id) ?? agents.value[agents.value.length - 1]) }
  } catch { error.value = tr('保存失败') }
  finally { busy.value = false }
}
/** 删除前确认，保留会话历史；与从单个讨论组移出是不同操作。 */
async function remove(agent: AgentView): Promise<void> {
  if (busy.value || !confirm(tr('删除 Agent 将停止回复，但保留聊天历史。确定删除？'))) return
  busy.value = true
  try {
    if (!await window.pantry.removeAgent(agent.id)) { error.value = tr('删除失败'); return }
    agents.value = await window.pantry.listAgents(); if (form.id === agent.id) edit()
  } finally { busy.value = false }
}
/** 使用现有主题更新与就绪通知，避免独立窗口首帧闪白。 */
onMounted(async () => {
  subscriptions.push(window.pantry.onAgentsChanged(next => { agents.value = next }), window.pantry.onSettingsUpdated(applyAppearance))
  try { applyAppearance(await window.pantry.getSettings()); agents.value = await window.pantry.listAgents() }
  catch { error.value = tr('初始化失败') }
  requestAnimationFrame(() => requestAnimationFrame(() => window.pantry.settingsReady()))
})
onUnmounted(() => { for (const stop of subscriptions) stop(); form.apiKey = '' })
</script>

<template>
  <main class="agents">
    <header><h1>{{ tr('Agent 管理') }}</h1><button type="button" @click="edit()">{{ tr('新建 Agent') }}</button></header>
    <p class="hint">{{ tr('Agent 由本机托管；私聊直接回复，群内仅明确 @该 Agent 回复。退出或休眠后停止回复。') }}</p>
    <p class="hint">{{ tr('密钥使用系统加密存储；安全后端不可验证时仅保存在本次会话内，重启后必须重新填写。') }}</p>
    <section class="layout">
      <aside :aria-label="tr('Agent 列表')">
        <article v-for="agent in agents" :key="agent.id" :class="{ selected: form.id === agent.id }">
          <button type="button" @click="edit(agent)"><strong>{{ agent.name }}</strong><span>{{ tr(agent.enabled ? (agent.status === 'running' ? '运行中' : agent.status === 'starting' ? '启动中' : agent.status === 'error' ? '异常' : '已停止') : '已禁用') }}</span></button>
          <small v-if="agent.sessionKey">{{ tr('密钥仅本次会话有效') }}</small>
          <small v-if="agent.error" role="status">{{ tr(agent.error) }}</small>
          <button type="button" :disabled="busy" @click="remove(agent)">{{ tr('删除') }}</button>
        </article>
        <p v-if="!agents.length">{{ tr('尚未创建 Agent') }}</p>
      </aside>
      <form @submit.prevent="save">
        <h2>{{ tr(form.id ? '编辑 Agent' : '新建 Agent') }}</h2>
        <label>{{ tr('名字') }}<input v-model="form.name" required maxlength="32" autocomplete="off" /></label>
        <label>{{ tr('人设') }}<textarea v-model="form.persona" rows="5" maxlength="8000" /></label>
        <label>{{ tr('内网模型服务根地址') }}<input v-model="form.endpoint" type="url" required maxlength="256" /></label>
        <small>{{ tr('例如 http://192.168.1.10:8000；可带代理前缀，不要填写 /v1/messages。HTTP 不加密传输，请仅在可信内网使用。') }}</small>
        <label>{{ tr('模型 ID') }}<input v-model="form.model" required maxlength="128" autocomplete="off" /></label>
        <label>{{ tr('密钥（编辑时留空保留）') }}<input v-model="form.apiKey" type="password" :required="!form.id" maxlength="4096" autocomplete="new-password" /></label>
        <label class="enabled"><input v-model="form.enabled" type="checkbox" />{{ tr('启用 Agent') }}</label>
        <p v-if="error" role="alert">{{ error }}</p>
        <button type="submit" :disabled="busy">{{ tr(busy ? '保存中…' : '保存') }}</button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.agents { height:100%; overflow-y:auto; box-sizing:border-box; padding:24px; max-width:1000px; margin:auto; color:var(--text-1); }
header { display:flex; align-items:center; justify-content:space-between; gap:16px; }
h1 { font-size:24px; } h2 { font-size:18px; margin-top:0; }
.hint, small { color:var(--text-2); line-height:1.6; }
.layout { display:grid; grid-template-columns:220px 1fr; gap:24px; margin-top:24px; }
article { padding:12px; border:1px solid var(--line); border-radius:8px; margin-bottom:12px; }
article.selected { border-color:var(--primary); } article button:first-child { width:100%; text-align:left; }
article strong, article span, article small { display:block; margin-bottom:6px; overflow-wrap:anywhere; }
label { display:flex; flex-direction:column; gap:6px; margin:16px 0 8px; font-weight:500; }
input, textarea { box-sizing:border-box; width:100%; padding:9px; border:1px solid var(--line); border-radius:6px; background:var(--bg-input); color:var(--text-1); font:inherit; }
.enabled { flex-direction:row; align-items:center; } .enabled input { width:auto; }
button { border:1px solid var(--line); background:var(--surface-hover); color:var(--text-1); border-radius:6px; padding:8px 12px; font:inherit; cursor:pointer; }
button[type=submit] { background:var(--primary); color:var(--on-primary); }
button:disabled { opacity:.6; cursor:wait; } [role=alert] { color:var(--danger); }
@media(max-width:650px) { .agents { height:100%; overflow-y:auto; box-sizing:border-box; padding:16px; } .layout { grid-template-columns:1fr; } }
</style>
