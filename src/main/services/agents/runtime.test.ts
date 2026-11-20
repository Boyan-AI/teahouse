import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from './runtime'
import { requestAgent } from './model'
import { makeEnvelope } from '../../net/codec'
import { PeerRegistry } from '../../net/peer-registry'
import { MSG_TYPES, type Envelope, type Profile } from '../../../shared/protocol'
import { AGENT_CAP } from '../../../shared/agents'
vi.mock('./model', () => ({ requestAgent: vi.fn() }))
const active: AgentRuntime[] = []
afterEach(async () => { await Promise.all(active.splice(0).map(r => r.stop())); vi.clearAllMocks() })

/** 直接驱动生产运行时的入站/排队逻辑；不启动真实网卡或加载原生 SQLite。 */
function harness() {
  const profile: Profile = { nodeId: 'host', nick: 'Host', company: '', dept: '', team: '', avatar: -1, profileRev: 1, host: 'local', platform: 'mac', tcpPort: 1, ver: 'test', caps: [] }
  const error = vi.fn(), runtime = new AgentRuntime({ config: { id: 'agent', name: 'Agent', persona: '', endpoint: 'http://127.0.0.1', model: 'test', enabled: true, encryptedKey: '' }, profile, dataDir: '/unused', seeds: () => [], key: () => 'test-key', error })
  active.push(runtime)
  const internals = runtime as unknown as { registry: PeerRegistry; receive(env: Envelope): void }
  internals.registry.touch('human', '127.0.0.1', 1, { ...profile, nodeId: 'human' })
  internals.registry.touch('bot', '127.0.0.1', 2, { ...profile, nodeId: 'bot', caps: [AGENT_CAP] })
  let members = ['agent', 'human', 'bot'], accepted = true
  const direct = vi.fn(), group = vi.fn()
  Object.assign(runtime, { msgRepo: { get: () => accepted ? {} : null }, groupRepo: { get: () => ({ members }) },
    chat: { sendText: direct }, groups: { sendText: group } })
  return { runtime, direct, group, error, remove: () => { members = members.filter(id => id !== 'agent') }, unaccepted: () => { accepted = false },
    incoming: (from: string, payload: unknown) => internals.receive(makeEnvelope(MSG_TYPES.msg, from, payload)) }
}

describe('托管 Agent 回复边界', () => {
  it('私聊直接回复，群内仅明确提及时触发，不响应全体或其他机器人', async () => {
    vi.mocked(requestAgent).mockResolvedValue('reply')
    const h = harness()
    h.incoming('human', { kind: 'text', text: 'hello' })
    await vi.waitUntil(() => h.direct.mock.calls.length === 1)
    expect(h.direct).toHaveBeenCalledWith('human', 'reply')
    for (const mentions of [[], ['@all']]) h.incoming('human', { kind: 'group-text', groupId: 'g', text: '@all', mentions })
    h.incoming('bot', { kind: 'text', text: 'loop' })
    h.incoming('bot', { kind: 'group-text', groupId: 'g', text: '@Agent', mentions: ['agent'] })
    expect(requestAgent).toHaveBeenCalledTimes(1)
    h.incoming('human', { kind: 'group-text', groupId: 'g', text: '@Agent help', mentions: ['agent'] })
    await vi.waitUntil(() => h.group.mock.calls.length === 1)
    expect(h.group).toHaveBeenCalledWith('g', 'reply')
    h.unaccepted(); h.incoming('human', { kind: 'text', text: 'rejected' }); expect(requestAgent).toHaveBeenCalledTimes(2)
  })
  it('离群与禁用后迟到的模型响应不会复活回复', async () => {
    let finish!: (text: string) => void
    vi.mocked(requestAgent).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const h = harness()
    h.incoming('human', { kind: 'group-text', groupId: 'g', text: 'question', mentions: ['agent'] })
    await vi.waitUntil(() => typeof finish === 'function'); h.remove(); finish('late'); await Promise.resolve(); await Promise.resolve()
    expect(h.group).not.toHaveBeenCalled()
    h.incoming('human', { kind: 'text', text: 'pending' })
    await vi.waitUntil(() => vi.mocked(requestAgent).mock.calls.length === 2); await h.runtime.stop(); finish('after-stop'); await Promise.resolve()
    expect(h.direct).not.toHaveBeenCalled()
  })
  it('限制串行队列且不把未明确提及的群历史发往模型', async () => {
    vi.mocked(requestAgent).mockImplementation(() => new Promise(() => undefined))
    const h = harness()
    for (let i = 0; i < 20; i++) h.incoming('human', { kind: 'text', text: 'q' + i })
    await vi.waitUntil(() => vi.mocked(requestAgent).mock.calls.length === 1); expect(h.error).toHaveBeenCalledWith('Agent 请求过多，待处理队列已满')
    const signal = vi.mocked(requestAgent).mock.calls[0][3]
    await h.runtime.stop(); expect(signal.aborted).toBe(true)
  })
})

/** 直接驱动生产上下文组装，验证引用解析边界而不创建真实媒体缓存。 */
describe('Agent 图文与引用边界', () => {
  it.each([
    {row:undefined},
    {row:{conv_id:'single:someone-else',status:'sent',content:'跨会话秘密'}},
    {row:{conv_id:'single:human',status:'recalled',content:'撤回秘密'}}
  ])('不存在、跨会话或撤回引用不会读取正文 %j', async ({row}) => {
    const h=harness()
    Object.assign(h.runtime,{msgRepo:{get:()=>row}})
    const runtime=h.runtime as unknown as {makeTurn(job:{text:string;replyTo:string},convId:string):Promise<{content:string;images?:unknown[]}>}
    const turn=await runtime.makeTurn({text:'当前问题',replyTo:'source'},'single:human')
    expect(turn.content).toBe('[引用消息不可用或已撤回]\n\n[当前消息]\n当前问题')
    expect(turn.images).toBeUndefined()
  })
  it('同会话引用只取有限原文，不递归引用；图片未完成时明确降级提示', async () => {
    const h=harness()
    const row={conv_id:'single:human',status:'sent',kind:'text',content:'原文'.repeat(2000),file_ref:null}
    Object.assign(h.runtime,{msgRepo:{get:()=>row}})
    const runtime=h.runtime as unknown as {makeTurn(job:{text:string;replyTo:string},convId:string):Promise<{content:string;images?:unknown[]}>}
    const turn=await runtime.makeTurn({text:'问题',replyTo:'source'},'single:human')
    expect(turn.content).toContain('原文'.repeat(1024));expect(turn.content.length).toBeLessThan(2200)
    Object.assign(row,{kind:'image',content:'图片说明',file_ref:JSON.stringify({transferId:'not-downloaded'})})
    const image=await runtime.makeTurn({text:'问题',replyTo:'source'},'single:human')
    expect(image.content).toContain('图片说明');expect(image.content).toContain('引用图片尚未接收完成或不可用');expect(image.images).toBeUndefined()
  })
  it('拒绝普通文件、机器人和超限图片，保留群图片但未提及不请求模型', () => {
    const h=harness()
    const runtime=h.runtime as unknown as {allowImage(from:string,offer:unknown):boolean;imageReceived(view:unknown):void;jobs:unknown[];working:boolean}
    const offer={purpose:'image',total:1,seq:1,fileCount:1,files:[{isDir:false}],totalSize:10}
    expect(runtime.allowImage('human',{...offer,purpose:'file'})).toBe(false)
    expect(runtime.allowImage('bot',offer)).toBe(false)
    expect(runtime.allowImage('human',{...offer,totalSize:5*1024*1024+1})).toBe(false)
    expect(runtime.allowImage('human',offer)).toBe(true)
    runtime.working=true
    const row={kind:'image',status:'sent',sender_id:'human',conv_id:'group:g',content:'说明',file_ref:JSON.stringify({caption:'说明',mentions:[]})}
    Object.assign(h.runtime,{msgRepo:{get:()=>row}})
    runtime.imageReceived({direction:'in',status:'done',msgId:'plain-image',transferId:'t1'})
    expect(runtime.jobs).toHaveLength(0)
    row.file_ref=JSON.stringify({caption:'@Agent 说明',mentions:['agent']})
    runtime.imageReceived({direction:'in',status:'done',msgId:'mentioned-image',transferId:'t2'})
    expect(runtime.jobs).toEqual([{from:'human',groupId:'g',text:'@Agent 说明',transferId:'t2',replyTo:undefined}])
    runtime.imageReceived({direction:'in',status:'done',msgId:'mentioned-image',transferId:'t2'})
    expect(runtime.jobs).toHaveLength(1)
  })
})
