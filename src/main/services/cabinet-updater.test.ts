import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CabinetUpdater, verifyCabinetPackage, type CabinetUpdaterDeps } from './cabinet-updater'
import type { CabinetUpdateManifest } from '../../shared/cabinet-update'

const directories: string[] = []
const services: CabinetUpdater[] = []
const packageBytes = Buffer.from('local package fixture')
const manifest: CabinetUpdateManifest = { schema: 1, version: '0.66.0', platform: 'mac', arch: 'arm64',
  file: 'Teahouse-0.66.0-mac-arm64.dmg', size: packageBytes.length,
  sha256: createHash('sha256').update(packageBytes).digest('hex'), notes: 'test', dataCompatible: true }

/** 本地夹具模拟文件柜数据面，测试调度和校验时不使用网络。 */
async function fixture(overrides: Partial<CabinetUpdaterDeps> = {}) {
  const cache = await mkdtemp(join(tmpdir(), 'cabinet-update-'))
  directories.push(cache)
  const fetch = vi.fn<CabinetUpdaterDeps['fetch']>(async options => {
    const path = join(options.directory, basename(options.path))
    await writeFile(path, options.path.endsWith('.json') ? JSON.stringify(manifest) : packageBytes)
    return path
  })
  const available = vi.fn()
  const updater = new CabinetUpdater({ cache, version: '0.65.0', platform: 'darwin', arch: 'arm64', fetch,
    source: () => ({ name: '发布者', error: null }), available, changed: vi.fn(), ...overrides },
  { nodeId: 'publisher', directory: 'releases/mac', autoCheck: true })
  services.push(updater)
  return { updater, fetch, available, cache }
}

afterEach(async () => {
  services.splice(0).forEach(service => service.stop())
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('文件柜确认式更新', () => {
  it('交接安装后退出仍清理已下载缓存', async () => {
    const { updater } = await fixture()
    await updater.check()
    await updater.download()
    const path = updater.installation()!.path
    updater.installing()
    updater.stop()
    await vi.waitFor(async () => { await expect(access(path)).rejects.toThrow() })
  })
  it('提示回调立即确认时清单锁已释放，可开始下载安装包', async () => {
    const { updater, available } = await fixture()
    let download: Promise<unknown> | undefined
    available.mockImplementation(() => { download = updater.download() })
    await updater.check()
    await download
    expect(updater.snapshot().status).toBe('ready')
  })
  it('检查仅下载清单、同版本只提示一次，确认后校验安装包', async () => {
    const { updater, fetch, available } = await fixture()
    expect((await updater.check()).status).toBe('available')
    expect(fetch.mock.calls[0][0]).toMatchObject({ nodeId: 'publisher', path: 'releases/mac/teahouse-update.json', maxBytes: 65536 })
    expect(fetch).toHaveBeenCalledTimes(1)
    await updater.check()
    expect(available).toHaveBeenCalledTimes(1)
    expect((await updater.download()).status).toBe('ready')
    expect(fetch.mock.calls[2][0]).toMatchObject({ size: packageBytes.length, maxBytes: packageBytes.length })
    expect(updater.installation()?.manifest).toEqual(manifest)
  })

  it.each(['offline', 'off', 'not-found'])('检查失败 %s 不会误报已是最新', async error => {
    const { updater, fetch } = await fixture({ source: () => ({ name: '发布者', error }) })
    expect((await updater.check())).toMatchObject({ status: 'error', error, manifest: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('损坏清单及哈希不符的包不能安装，重新检查可重试', async () => {
    const { updater, fetch } = await fixture()
    fetch.mockImplementationOnce(async options => { const path = join(options.directory, 'teahouse-update.json'); await writeFile(path, '{'); return path })
    expect((await updater.check()).error).toBe('invalid-manifest')
    await updater.check()
    fetch.mockImplementationOnce(async options => { const path = join(options.directory, manifest.file); await writeFile(path, Buffer.alloc(manifest.size)); return path })
    expect((await updater.download()).error).toBe('integrity-failed')
    expect(updater.installation()).toBeNull()
    expect((await updater.download()).status).toBe('ready')
  })

  it('并发检查合并，切换来源后旧请求的迟到结果不能提示', async () => {
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const { updater, fetch, available } = await fixture()
    const original = fetch.getMockImplementation()!
    fetch.mockImplementationOnce(async options => { await wait; return original(options) })
    const first = updater.check()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await updater.check()
    updater.configure({ nodeId: 'new-publisher', directory: '', autoCheck: false })
    release()
    await first
    expect(updater.snapshot()).toMatchObject({ status: 'idle', manifest: null, config: { nodeId: 'new-publisher' } })
    expect(available).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('定时检查可关闭，休眠撤销并在恢复后合并为一次', async () => {
    const { updater } = await fixture()
    const check = vi.spyOn(updater, 'check').mockResolvedValue(updater.snapshot())
    vi.useFakeTimers()
    updater.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(check).toHaveBeenCalledTimes(1)
    updater.suspend()
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    updater.resume()
    await vi.advanceTimersByTimeAsync(3000)
    expect(check).toHaveBeenCalledTimes(2)
    updater.configure({ nodeId: 'publisher', directory: '', autoCheck: false })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('非 macOS 不启动自动下载，实际文件大小变化会失败', async () => {
    const { updater, fetch, cache } = await fixture({ platform: 'linux' })
    await updater.check()
    expect(fetch).not.toHaveBeenCalled()
    const path = join(cache, 'bad.dmg')
    await writeFile(path, 'truncated')
    await expect(verifyCabinetPackage(path, manifest)).rejects.toThrow('integrity-failed')
  })
})
