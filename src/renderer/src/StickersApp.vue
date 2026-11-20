<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { tr } from './utils/i18n'
import { applyAppearance } from './utils/appearance'
import { useStickersStore } from './stores/stickers'
import { moveSticker } from './utils/sticker-order'

const stickers=useStickersStore()
const selected=ref<string[]>([]), dragged=ref(''), over=ref(''), busy=ref(false), error=ref(''), notice=ref('')
const allSelected=computed(()=>stickers.list.length>0 && selected.value.length===stickers.list.length)
const stops:Array<()=>void>=[]
/** 切换选择不发送表情；管理操作与聊天发送彻底分离。 */
function toggle(id:string):void { selected.value=selected.value.includes(id)?selected.value.filter(v=>v!==id):[...selected.value,id] }
/** 拖动与键盘共用持久化操作，失败保留服务端真实列表并显示错误。 */
async function reorder(from:string,to:string):Promise<void> {
  if(busy.value || !from || from===to)return
  busy.value=true; error.value=''; notice.value=''
  try { await stickers.reorder(moveSticker(stickers.list.map(s=>s.id),from,to)); notice.value=tr('顺序已保存') }
  catch { error.value=tr('排序失败，请重试') }
  finally { busy.value=false; dragged.value=''; over.value='' }
}
/** 每项提供按钮与 Alt+左右键替代拖动，不要求精细鼠标操作。 */
function move(id:string,delta:number):void {
  const index=stickers.list.findIndex(s=>s.id===id), target=stickers.list[index+delta]
  if(target)void reorder(id,target.id)
}
/** 明确确认后才删除本地收藏；历史消息及在途素材不被移除。 */
async function removeSelected():Promise<void> {
  const ids=selected.value.filter(id=>stickers.list.some(s=>s.id===id))
  if(busy.value || !ids.length || !confirm(tr('删除选中的 {0} 个表情？仅移除收藏，不影响聊天历史。',{0:ids.length})))return
  busy.value=true; error.value=''; notice.value=''
  try { for(const id of ids)await stickers.remove(id); selected.value=[]; notice.value=tr('已删除收藏') }
  catch { error.value=tr('删除失败，请重试'); selected.value=selected.value.filter(id=>stickers.list.some(s=>s.id===id)) }
  finally { busy.value=false }
}
/** 导入复用本地选择器与现有压缩，绝不下载远程图片。 */
async function importImages():Promise<void> {
  if(busy.value)return
  busy.value=true;error.value='';notice.value=''
  try { const result=await stickers.importFiles();if(result)notice.value=tr('已导入 {0} 个表情',{0:result.added}) }
  catch { error.value=tr('导入失败') }
  finally {busy.value=false}
}
/** 原生拖动仅接受本窗口内发起的素材，不处理外部任意路径/HTML。 */
function drag(event:DragEvent,id:string):void {
  if(busy.value){event.preventDefault();return}
  dragged.value=id
  event.dataTransfer?.setData('text/plain',id)
  if(event.dataTransfer)event.dataTransfer.effectAllowed='move'
}
/** 主题与就绪通知复用安全扩展窗，不引入主窗的完整组件依赖。 */
onMounted(async()=>{
  stops.push(window.pantry.onSettingsUpdated(applyAppearance))
  try {applyAppearance(await window.pantry.getSettings());await stickers.init()}
  catch {error.value=tr('初始化失败')}
  requestAnimationFrame(()=>requestAnimationFrame(()=>window.pantry.settingsReady()))
})
onUnmounted(()=>stops.forEach(stop=>stop()))
</script>
<template>
  <main class="sticker-manager">
    <header><div><p class="eyebrow">{{ tr('我的收藏') }}</p><h1>{{ tr('表情管理') }}</h1><p>{{ tr('拖动调整发送顺序，选择后可批量删除。') }}</p></div><button class="primary import" :disabled="busy" @click="importImages">{{ tr('导入表情包') }}</button></header>
    <section class="toolbar" :aria-label="tr('表情管理操作')">
      <label><input type="checkbox" :checked="allSelected" :disabled="busy || !stickers.list.length" @change="selected=allSelected?[]:stickers.list.map(s=>s.id)" />{{ tr('全选') }}</label>
      <span role="status">{{ tr('共 {0} 个，已选 {1} 个',{0:stickers.list.length,1:selected.length}) }}</span>
      <button class="delete" :disabled="busy || !selected.length" @click="removeSelected">{{ tr('删除所选') }}</button>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div v-if="stickers.list.length" class="collection" role="list" :aria-label="tr('收藏表情顺序')">
      <article v-for="(s,i) in stickers.list" :key="s.id" :data-id="s.id" class="sticker-tile" :class="{selected:selected.includes(s.id),dragging:dragged===s.id,over:over===s.id}" role="listitem" tabindex="0" :draggable="!busy" @dragstart="drag($event,s.id)" @dragover.prevent="over=dragged?s.id:''" @drop.prevent="reorder(dragged,s.id)" @dragend="dragged='';over=''" @keydown.alt.left.prevent="move(s.id,-1)" @keydown.alt.right.prevent="move(s.id,1)">
        <label class="selection"><input type="checkbox" :checked="selected.includes(s.id)" :disabled="busy" :aria-label="tr('选择第 {0} 个表情',{0:i+1})" @change="toggle(s.id)" /><span>{{ i+1 }}</span></label>
        <button class="preview" :disabled="busy" :aria-label="tr('选择第 {0} 个表情',{0:i+1})" @click="toggle(s.id)"><img :src="'pantry-sticker://'+s.id" :alt="tr('表情')" :draggable="false" loading="lazy" /></button>
        <div class="tile-footer"><small>{{ s.animated?tr('动图'):tr('静图') }}</small><button :disabled="busy || i===0" :aria-label="tr('上移表情')" @click="move(s.id,-1)">←</button><button :disabled="busy || i===stickers.list.length-1" :aria-label="tr('下移表情')" @click="move(s.id,1)">→</button></div>
      </article>
    </div>
    <section v-else class="empty"><span aria-hidden="true">☺</span><h2>{{ tr('还没有收藏的表情') }}</h2><p>{{ tr('导入本地图片，或在聊天图片上右键添加到表情。') }}</p></section>
    <footer>{{ tr('顺序自动保存。也可使用移动按钮或 Alt + 左右键排序。') }}</footer>
  </main>
</template>
<style scoped>
.sticker-manager{height:100%;overflow:auto;padding:28px;color:var(--text-1);background:var(--bg-window)}
header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}h1{font-size:26px;margin:5px 0 9px}header p,footer{font-size:13px;color:var(--text-2);line-height:1.6}.eyebrow{color:var(--primary);font-weight:600}button{font:inherit;padding:8px 13px;border:1px solid var(--line);border-radius:8px;background:var(--bg-list);color:var(--text-1);cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,article:focus-visible{outline:2px solid var(--primary);outline-offset:3px}.primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary);white-space:nowrap}.toolbar{display:flex;align-items:center;gap:16px;padding:14px 16px;margin-bottom:16px;background:var(--bg-list);border-radius:10px;font-size:13px}.toolbar label{display:flex;gap:8px;align-items:center}.toolbar span{flex:1;color:var(--text-2)}.delete{color:var(--danger)}.collection{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:14px}.sticker-tile{padding:10px;border:1px solid var(--line);border-radius:12px;min-width:0;cursor:grab}.sticker-tile.selected,.sticker-tile.over{border-color:var(--primary);background:var(--primary-weak)}.sticker-tile.dragging{opacity:.5}.selection{display:flex;justify-content:space-between;color:var(--text-3);font-size:11px}.preview{display:grid;place-items:center;width:100%;height:110px;border:0;background:transparent;padding:8px}.preview img{max-width:100%;max-height:94px;object-fit:contain;user-select:none}.tile-footer{display:flex;align-items:center;gap:6px}.tile-footer small{flex:1;color:var(--text-3);font-size:11px}.tile-footer button{padding:3px 8px}.empty{text-align:center;padding:70px 16px;color:var(--text-2)}.empty>span{font-size:56px;color:var(--primary)}.empty h2{font-size:18px;margin:16px 0 8px}.empty p{font-size:13px}.error{color:var(--danger);margin-bottom:14px}.notice{color:var(--primary);margin-bottom:14px}footer{margin-top:22px;font-size:12px}input{accent-color:var(--primary)}
@media(max-width:640px){.sticker-manager{padding:20px}header{align-items:flex-start;gap:12px}h1{font-size:23px}.toolbar{gap:10px;flex-wrap:wrap}.collection{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}}
</style>
