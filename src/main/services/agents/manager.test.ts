import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStore } from '../../store/agent-store'
import { AgentManager } from './manager'
import type { Profile } from '../../../shared/protocol'
const instances = vi.hoisted(() => [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>)
vi.mock('./runtime', () => ({ AgentRuntime: class {
  start = vi.fn(async () => undefined)
  stop = vi.fn(async () => undefined)
  probe = vi.fn()
  constructor() { instances.push(this) }
} }))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); instances.length = 0 })

/** 管理层只替换网络运行时，真实配置存储和操作串行逻辑仍执行生产实现。 */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-manager-')); dirs.push(dir)
  const store = new AgentStore(join(dir, 'agents.json'), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const manager = new AgentManager(store, { dataDir: dir, profile: () => ({} as Profile), seeds: () => [] })
  const input = { name: '助手', persona: '不广播的人设', endpoint: 'http://127.0.0.1', model: 'local', apiKey: 'private-secret', enabled: true }
  return { store, manager, input }
}
describe('Agent 管理生命周期', () => {
  it('列表不返回密钥/密文；编辑复用身份，禁用停止节点，删除清除托管配置', async () => {
    const h = harness(); await h.manager.save(h.input)
    const first = h.manager.list()[0]
    expect(first.status).toBe('running'); expect(JSON.stringify(first)).not.toContain('private-secret'); expect(first).not.toHaveProperty('encryptedKey'); expect(first).not.toHaveProperty('apiKey')
    await h.manager.save({ ...h.input, id: first.id, name: '修改', apiKey: '', enabled: false })
    expect(instances[0].stop).toHaveBeenCalledOnce(); expect(h.manager.list()[0].id).toBe(first.id)
    expect(h.manager.list()[0].status).toBe('stopped'); expect(h.store.key(first.id)).toBe(h.input.apiKey)
    await h.manager.remove(first.id); expect(h.manager.list()).toEqual([])
    await h.manager.stop()
  })
  it('休眠停止运行时，恢复只启动已启用节点，最终停止后不可重新保存', async () => {
    const h = harness(); await h.manager.save(h.input)
    await h.manager.pause(); expect(instances[0].stop).toHaveBeenCalledOnce()
    await h.manager.resume(); expect(instances).toHaveLength(2); expect(instances[1].start).toHaveBeenCalledOnce()
    await h.manager.stop(); expect(instances[1].stop).toHaveBeenCalledOnce()
    await expect(h.manager.save(h.input)).rejects.toThrow('已停止')
  })
  it('并发编辑操作串行执行，不产生两个同时托管的独立节点', async () => {
    const h = harness(); await h.manager.save(h.input); const id = h.manager.list()[0].id
    await Promise.all([h.manager.save({ ...h.input, id, name: '1', apiKey: '' }), h.manager.save({ ...h.input, id, name: '2', apiKey: '' })])
    expect(instances).toHaveLength(3); expect(instances[0].stop).toHaveBeenCalledOnce(); expect(instances[1].stop).toHaveBeenCalledOnce()
    expect(h.manager.list()).toHaveLength(1); expect(h.manager.list()[0].name).toBe('2'); await h.manager.stop()
  })
})
