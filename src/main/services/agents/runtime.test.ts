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
    h.remove(); finish('late'); await Promise.resolve(); await Promise.resolve()
    expect(h.group).not.toHaveBeenCalled()
    h.incoming('human', { kind: 'text', text: 'pending' })
    await h.runtime.stop(); finish('after-stop'); await Promise.resolve()
    expect(h.direct).not.toHaveBeenCalled()
  })
  it('限制串行队列且不把未明确提及的群历史发往模型', async () => {
    vi.mocked(requestAgent).mockImplementation(() => new Promise(() => undefined))
    const h = harness()
    for (let i = 0; i < 20; i++) h.incoming('human', { kind: 'text', text: 'q' + i })
    expect(requestAgent).toHaveBeenCalledTimes(1); expect(h.error).toHaveBeenCalledWith('Agent 请求过多，待处理队列已满')
    const signal = vi.mocked(requestAgent).mock.calls[0][3]
    await h.runtime.stop(); expect(signal.aborted).toBe(true)
  })
})
