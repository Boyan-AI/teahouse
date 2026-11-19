import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStore, type SecretCodec } from './agent-store'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
/** 可逆测试密文仅作接口桩，生产使用系统 safeStorage。 */
const codec: SecretCodec = { available: () => true, encrypt: s => Buffer.from([...s].reverse().join('')), decrypt: b => [...b.toString()].reverse().join('') }
/** 每例独立临时配置文件，不读取实际用户密钥。 */
function file(): string { const dir = mkdtempSync(join(tmpdir(), 'pantry-agents-')); dirs.push(dir); return join(dir, 'agents.json') }
const input = { name: '助手', persona: '工作助手', endpoint: 'http://127.0.0.1:8080', model: 'local', apiKey: 'private-key-only', enabled: true }

describe('Agent 配置与密钥隔离', () => {
  it('密钥不明文落盘，修改保留稳定ID和原密钥，重启可恢复', () => {
    const path = file(), store = new AgentStore(path, codec), first = store.save(input)
    expect(readFileSync(path, 'utf8')).not.toContain(input.apiKey)
    const edited = store.save({ ...input, id: first.id, name: '新名字', apiKey: '' })
    expect(edited.id).toBe(first.id); expect(store.key(first.id)).toBe(input.apiKey)
    expect(new AgentStore(path, codec).key(first.id)).toBe(input.apiKey)
  })
  it('安全后端不可用只保存在内存，重启不恢复明文', () => {
    const path = file(), unavailable = { ...codec, available: () => false }, store = new AgentStore(path, unavailable)
    const agent = store.save(input)
    expect(store.key(agent.id)).toBe(input.apiKey); expect(readFileSync(path, 'utf8')).not.toContain(input.apiKey)
    expect(store.sessionOnly()).toBe(true); expect(new AgentStore(path, unavailable).hasKey(agent.id)).toBe(false)
    expect(() => new AgentStore(path, unavailable).key(agent.id)).toThrow('重新填写')
  })
  it('拒绝非法配置、未知ID和超额创建，删除后不可取密钥', () => {
    const store = new AgentStore(file(), codec)
    expect(() => store.save({ ...input, endpoint: 'http://8.8.8.8' })).toThrow('配置无效')
    const first = store.save(input)
    for (let i = 1; i < 8; i++) store.save(input)
    expect(() => store.save(input)).toThrow('最多')
    store.remove(first.id); expect(store.hasKey(first.id)).toBe(false)
    expect(() => store.key(first.id)).toThrow()
    expect(() => store.save({ ...input, id: first.id })).toThrow('不存在')
  })
})
