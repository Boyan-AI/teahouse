<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { tr } from './utils/i18n'
import { applyAppearance } from './utils/appearance'
import { AGENT_LIMIT, type AgentInput, type AgentView } from '../../shared/agents'

const agents = ref<AgentView[]>([])
const error = ref('')
const busy = ref(false)
const form = reactive<AgentInput>({ name: '', persona: '', endpoint: 'http://192.168.1.10:8000', model: '', apiKey: '', enabled: true })
const subscriptions: Array<() => void> = []
const current = computed(() => agents.value.find(agent => agent.id === form.id))
/** 列表与编辑面板共用状态文案，错误详情不包含密钥。 */
function statusLabel(agent: AgentView): string {
  return tr(!agent.enabled ? '已禁用' : agent.status === 'running' ? '运行中' : agent.status === 'starting' ? '启动中' : agent.status === 'error' ? '异常' : '已停止')
}
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
  } catch { error.value = tr('删除失败') }
  finally { busy.value = false }
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
    <header class="page-head">
      <div class="heading"><span class="ai-mark" aria-hidden="true">AI</span><div><h1>{{ tr('Agent 管理') }}</h1><p>{{ tr('把你的内网 AI，变成聊天伙伴。') }}</p></div></div>
      <button class="primary" type="button" :disabled="busy || agents.length >= AGENT_LIMIT" @click="edit()">＋ {{ tr('新建 Agent') }}</button>
    </header>
    <div class="intro"><span class="local-dot" aria-hidden="true"></span><p>{{ tr('由本机托管 · 私聊直接回复 · 群聊 @ 后回复') }}<small>{{ tr('退出应用或电脑休眠后，Agent 将停止回复。') }}</small></p></div>
    <section class="layout">
      <aside :aria-label="tr('Agent 列表')">
        <div class="list-heading"><h2>{{ tr('我的 Agent') }}</h2><span>{{ agents.length }} / {{ AGENT_LIMIT }}</span></div>
        <div v-if="!agents.length" class="empty"><span class="empty-mark" aria-hidden="true">AI</span><strong>{{ tr('还没有 AI 伙伴') }}</strong><p>{{ tr('在右侧填写名字与模型配置，创建你的第一个 Agent。') }}</p></div>
        <article v-for="agent in agents" :key="agent.id" :class="{ selected: form.id === agent.id }">
          <button class="agent-item" type="button" :disabled="busy" :aria-pressed="form.id === agent.id" @click="edit(agent)">
            <span class="agent-icon" aria-hidden="true">{{ agent.name.slice(0, 1) }}</span>
            <span class="agent-summary"><strong>{{ agent.name }}</strong><small>{{ agent.model }}</small></span>
            <span class="state" :class="{ running: agent.enabled && agent.status === 'running', problem: agent.status === 'error' }">{{ statusLabel(agent) }}</span>
          </button>
          <small v-if="agent.sessionKey" class="list-note">{{ tr('密钥仅本次会话有效') }}</small>
        </article>
        <p class="list-help">{{ tr('保存后可在联系人中找到 Agent，也可以邀请它加入讨论组。') }}</p>
      </aside>
      <form :aria-busy="busy" @submit.prevent="save">
        <div class="form-head"><div><h2>{{ tr(form.id ? '编辑 Agent' : '创建 AI 伙伴') }}</h2><p>{{ tr('配置身份和模型服务，保存后即可开始聊天。') }}</p></div><span v-if="current" class="state" :class="{ running: current.status === 'running', problem: current.status === 'error' }">{{ statusLabel(current) }}</span></div>
        <fieldset :disabled="busy">
          <legend>{{ tr('身份设定') }}</legend>
          <label for="agent-name">{{ tr('名字') }}<input id="agent-name" v-model="form.name" required maxlength="32" autocomplete="off" :placeholder="tr('例如：研发小助手')" /></label>
          <label for="agent-persona">{{ tr('人设') }}<textarea id="agent-persona" v-model="form.persona" rows="3" maxlength="8000" :placeholder="tr('描述它的角色、擅长的事情，以及你希望的回复风格…')" /></label>
          <div class="field-help">{{ tr('决定 Agent 如何理解和回复消息，可随时修改。') }}</div>
        </fieldset>
        <fieldset :disabled="busy">
          <legend>{{ tr('模型连接') }}<span class="protocol">{{ tr('Anthropic 兼容接口') }}</span></legend>
          <label for="agent-endpoint">{{ tr('内网服务根地址') }}<input id="agent-endpoint" v-model="form.endpoint" type="url" required maxlength="256" spellcheck="false" aria-describedby="endpoint-help" /></label>
          <div id="endpoint-help" class="field-help">{{ tr('填写 IP 与端口，可带代理前缀；不要填写 /v1/messages。HTTP 不加密，请仅在可信内网使用。') }}</div>
          <label for="agent-model">{{ tr('模型 ID') }}<input id="agent-model" v-model="form.model" required maxlength="128" autocomplete="off" spellcheck="false" :placeholder="tr('填写内网服务实际提供的模型 ID')" /></label>
          <label for="agent-key">{{ tr('API 密钥') }}<input id="agent-key" v-model="form.apiKey" type="password" :required="form.enabled && !current?.hasKey" maxlength="4096" autocomplete="new-password" aria-describedby="key-help" :placeholder="tr(current?.hasKey ? '已配置密钥，留空保留' : '填写服务密钥')" /></label>
          <div id="key-help" class="field-help">{{ tr('密钥不回显；系统安全存储不可用时，仅保留到本次应用退出。') }}</div>
        </fieldset>
        <label class="enabled"><span><strong>{{ tr('启用 Agent') }}</strong><small>{{ tr('保存后生效；关闭时保留配置和聊天历史。') }}</small></span><input v-model="form.enabled" type="checkbox" :disabled="busy" /></label>
        <p v-if="current?.sessionKey" class="notice" role="status">{{ tr('当前密钥仅本次会话有效，重启应用后请重新填写。') }}</p>
        <p v-if="current?.error" class="error" role="status">{{ tr(current.error) }}</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <footer><button v-if="current" class="danger" type="button" :disabled="busy" @click="remove(current)">{{ tr('删除 Agent') }}</button><button class="primary save" type="submit" :disabled="busy">{{ tr(busy ? '保存中…' : form.id ? '保存修改' : '创建 Agent') }}</button></footer>
      </form>
    </section>
  </main>
</template>

<style scoped>
.agents { height:100%; overflow-y:auto; box-sizing:border-box; padding:28px; max-width:1100px; margin:auto; color:var(--text-1); }
.page-head,.heading,.form-head,.list-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.heading { justify-content:flex-start; } h1 { margin:0; font-size:23px; letter-spacing:-.5px; } h2 { margin:0; font-size:16px; }
p { margin:6px 0 0; line-height:1.6; color:var(--text-2); font-size:13px; }
.ai-mark,.empty-mark,.agent-icon { display:grid; place-items:center; flex-shrink:0; background:var(--primary-weak); color:var(--primary); font-weight:700; }
.ai-mark { width:46px; height:46px; border:1px solid var(--primary-border); border-radius:14px; font-size:18px; }
button { border:1px solid var(--line); background:var(--bg-window); color:var(--text-1); border-radius:8px; padding:9px 13px; font:inherit; font-size:13px; cursor:pointer; }
button:hover:not(:disabled) { background:var(--surface-hover); } button.primary { background:var(--primary); border-color:var(--primary); color:var(--on-primary); font-weight:600; white-space:nowrap; }
button.primary:hover:not(:disabled) { background:var(--primary-hover); } button:disabled { opacity:.55; cursor:default; }
.intro { display:flex; align-items:flex-start; gap:10px; padding:13px 16px; margin:22px 0; border:1px solid var(--line); background:var(--bg-list); border-radius:10px; }
.intro p { margin:0; color:var(--text-1); } .intro small { display:block; margin-top:3px; color:var(--text-2); font-size:12px; }
.local-dot { width:7px; height:7px; border-radius:50%; background:var(--online); margin-top:7px; flex-shrink:0; }
.layout { display:grid; grid-template-columns:230px minmax(0,1fr); gap:22px; align-items:start; }
aside { min-width:0; } .list-heading { margin:4px 0 14px; } .list-heading span { color:var(--text-2); font-size:12px; }
article { border:1px solid var(--line); border-radius:10px; margin-bottom:10px; overflow:hidden; } article.selected { border-color:var(--primary-border); background:var(--primary-weak); }
.agent-item { display:flex; align-items:center; gap:9px; border:0; padding:13px 10px; width:100%; background:transparent; text-align:left; }
.agent-icon { width:32px; height:32px; border-radius:10px; font-size:15px; }
.agent-summary { min-width:0; flex:1; } .agent-summary strong,.agent-summary small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-summary strong { font-size:13px; } .agent-summary small { margin-top:4px; color:var(--text-2); font-size:11px; }
.state { font-size:11px; color:var(--text-2); background:var(--surface-hover); border-radius:20px; padding:4px 7px; white-space:nowrap; }
.state.running { color:var(--online); background:var(--online-weak); } .state.problem,.error { color:var(--danger); }
.list-note { display:block; padding:0 12px 10px; color:var(--text-2); font-size:11px; } .list-help { padding:8px 4px; font-size:12px; }
.empty { text-align:center; border:1px dashed var(--primary-border); border-radius:10px; padding:24px 16px; } .empty-mark { width:42px; height:42px; border-radius:13px; margin:0 auto 12px; }
.empty strong { font-size:13px; } .empty p { font-size:12px; }
form { min-width:0; border:1px solid var(--line); border-radius:12px; background:var(--bg-window); padding:22px; box-shadow:var(--shadow-soft); }
.form-head { align-items:flex-start; padding-bottom:20px; } .form-head p { font-size:12px; }
fieldset { border:0; padding:0; margin:0 0 22px; min-width:0; } legend { display:flex; align-items:center; flex-wrap:wrap; gap:8px; width:100%; box-sizing:border-box; padding:0 0 10px; border-bottom:1px solid var(--line); font-weight:600; font-size:13px; }
.protocol { color:var(--text-2); font-weight:400; font-size:11px; background:var(--bg-list); border-radius:4px; padding:3px 6px; }
label:not(.enabled) { display:flex; flex-direction:column; gap:7px; margin:14px 0 0; font-size:13px; font-weight:500; }
input:not([type=checkbox]),textarea { box-sizing:border-box; width:100%; padding:10px 11px; border:1px solid var(--line); border-radius:7px; background:var(--bg-input); color:var(--text-1); font:inherit; line-height:1.5; }
textarea { resize:vertical; min-height:82px; } input::placeholder,textarea::placeholder { color:var(--text-placeholder); font-weight:400; }
input:focus,textarea:focus { border-color:var(--primary); } .field-help { margin-top:7px; color:var(--text-2); font-size:11px; line-height:1.7; overflow-wrap:anywhere; }
.enabled { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid var(--line); border-radius:8px; padding:12px; margin-top:4px; background:var(--bg-list); }
.enabled strong { font-size:13px; font-weight:600; } .enabled small { display:block; color:var(--text-2); font-size:11px; margin-top:5px; }
.enabled input { width:17px; height:17px; accent-color:var(--primary); flex-shrink:0; }
.notice,.error { padding:10px 12px; border:1px solid var(--line); border-radius:7px; margin-top:12px; font-size:12px; overflow-wrap:anywhere; }
footer { display:flex; align-items:center; gap:12px; margin-top:20px; padding-top:18px; border-top:1px solid var(--line); } .save { margin-left:auto; min-width:104px; } button.danger { border-color:transparent; color:var(--danger); }
@media(max-width:700px) { .agents { padding:18px; } .layout { grid-template-columns:1fr; gap:16px; } .empty { padding:16px; } .empty-mark { display:none; } .page-head { align-items:flex-start; } .ai-mark { display:none; } h1 { font-size:21px; } form { padding:18px; } }
</style>
