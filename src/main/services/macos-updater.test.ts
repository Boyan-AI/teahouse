import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectMacInstallHistory, macInstallTarget, prepareMacInstall, verifyMacBundle } from './macos-updater'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readFile, realpath, readdir, rm } from 'node:fs/promises'

vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  realpath: vi.fn(async path => path),
  lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => true, uid: process.getuid?.() }),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue('/tmp/cache/mount-one'),
  copyFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))

describe('macOS 安装边界', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('只接受真实已安装应用，拒绝转移运行、DMG 和开发可执行文件', async () => {
    await expect(macInstallTarget('/Applications/Teahouse.app/Contents/MacOS/Teahouse')).resolves.toBe('/Applications/Teahouse.app')
    for (const executable of ['/Volumes/Teahouse/Teahouse.app/Contents/MacOS/Teahouse',
      '/private/var/folders/x/AppTranslocation/y/Teahouse.app/Contents/MacOS/Teahouse', '/usr/bin/electron']) {
      await expect(macInstallTarget(executable)).rejects.toThrow('manual-install')
    }
  })

  it('父目录不可写和链接目标要求手动安装', async () => {
    vi.mocked(access).mockRejectedValueOnce(new Error('EACCES'))
    await expect(macInstallTarget('/Applications/Teahouse.app/Contents/MacOS/Teahouse')).rejects.toThrow('manual-install')
    vi.mocked(realpath).mockResolvedValueOnce('/other/Teahouse.app')
    await expect(macInstallTarget('/Applications/Teahouse.app/Contents/MacOS/Teahouse')).rejects.toThrow('manual-install')
  })

  it('损坏磁盘映像在创建事务前失败，复制失败卸载映像并清理自有准备目录', async () => {
    const options = { executable: '/Applications/Teahouse.app/Contents/MacOS/Teahouse',
      dmg: '/tmp/cache/update.dmg', cache: '/tmp/cache', version: '0.66.0', arch: 'arm64', helper: '/app/helper.sh' }
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void
      callback(new Error('bad-dmg'))
      return {} as ReturnType<typeof execFile>
    })
    await expect(prepareMacInstall(options)).rejects.toThrow('bad-dmg')
    expect(mkdir).not.toHaveBeenCalled()

    vi.mocked(readdir).mockResolvedValueOnce([{ name: 'Teahouse.app', isDirectory: () => true }] as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const command = args[0] as string
      const callback = args.at(-1) as (error: Error | null, result?: { stdout: string }) => void
      if (command === '/usr/bin/ditto') callback(new Error('copy-failed'))
      else callback(null, { stdout: command === '/usr/bin/plutil' ? JSON.stringify({ CFBundleIdentifier: 'com.pantry.app',
        CFBundleShortVersionString: '0.66.0', CFBundleExecutable: 'Teahouse', CFBundlePackageType: 'APPL' }) : command === '/usr/bin/lipo' ? 'arm64' : '' })
      return {} as ReturnType<typeof execFile>
    })
    await expect(prepareMacInstall(options)).rejects.toThrow('copy-failed')
    expect(copyFile).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/^\/Applications\/\.teahouse-update-/), { recursive: true, force: true })
    expect(execFile).toHaveBeenCalledWith('/usr/bin/hdiutil', ['detach', '/tmp/cache/mount-one'], expect.anything(), expect.anything())
  })

  it('包身份、版本或架构不符时不能通过校验', async () => {
    const info = { CFBundleIdentifier: 'com.other.app', CFBundleShortVersionString: '0.66.0',
      CFBundleExecutable: 'Teahouse', CFBundlePackageType: 'APPL' }
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: null, result: { stdout: string }) => void
      callback(null, { stdout: JSON.stringify(info) })
      return {} as ReturnType<typeof execFile>
    })
    await expect(verifyMacBundle('/tmp/Teahouse.app', '0.66.0', 'arm64')).rejects.toThrow('invalid-bundle')
  })

  it('仅清理成功七天后的本应用事务，失败或其他应用备份均保留', async () => {
    const target = '/Applications/Teahouse.app'
    const tokens = [1, 2, 3, 4].map(n => `00000000-0000-0000-0000-00000000000${n}`)
    vi.mocked(readdir).mockResolvedValueOnce(tokens.map(token => ({ name: `.teahouse-update-${token}`, isDirectory: () => true })) as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockImplementation(async file => {
      const index = tokens.findIndex(token => String(file).includes(token))
      if (String(file).endsWith('/status')) return index === 2 ? 'rolled-back' : 'completed'
      return JSON.stringify({ token: tokens[index], target: index === 3 ? '/Applications/Other.app' : target,
        createdAt: Date.now() - (index === 1 ? 1000 : (index === 2 ? 8 : 9) * 86400_000) })
    })
    await expect(inspectMacInstallHistory(target + '/Contents/MacOS/Teahouse')).resolves.toBeNull()
    expect(rm).toHaveBeenCalledTimes(1)
    expect(rm).toHaveBeenCalledWith(`/Applications/.teahouse-update-${tokens[0]}`, { recursive: true, force: true })
  })
})
