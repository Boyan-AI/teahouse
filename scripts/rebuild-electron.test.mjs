import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { rebuildElectron } = require('./rebuild-electron.cjs')
const manifest = require('../package.json')

it('在当前 Node 加载官方 API，默认只重建固定 Electron 版本的 SQLite', async () => {
  const rebuildImpl = vi.fn().mockResolvedValue(undefined)
  await rebuildElectron({ args: [], env: {}, rebuildImpl })
  expect(rebuildImpl).toHaveBeenCalledTimes(1)
  expect(rebuildImpl).toHaveBeenCalledWith({
    buildPath: fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, ''),
    electronVersion: manifest.devDependencies.electron,
    onlyModules: ['better-sqlite3'],
    force: false,
    buildFromSource: false,
    arch: process.arch
  })
})

it('保留强制重建、源码构建和目标架构，不依赖 cwd', async () => {
  const rebuildImpl = vi.fn().mockResolvedValue(undefined)
  await rebuildElectron({ args: ['--force'], env: { npm_config_build_from_source: 'true', npm_config_arch: 'arm64' }, rebuildImpl })
  expect(rebuildImpl).toHaveBeenCalledWith(expect.objectContaining({
    force: true, buildFromSource: true, arch: 'arm64'
  }))
  expect(manifest.scripts.postinstall).toBe('node scripts/rebuild-electron.cjs')
  expect(manifest.scripts['rebuild:electron']).toBe('node scripts/rebuild-electron.cjs --force')
})

it('参数错误和官方 API 失败不会伪装成重建成功', async () => {
  const rebuildImpl = vi.fn().mockRejectedValue(new Error('native rebuild failed'))
  await expect(rebuildElectron({ args: ['--unknown'], env: {}, rebuildImpl })).rejects.toThrow('仅支持 --force 参数')
  expect(rebuildImpl).not.toHaveBeenCalled()
  await expect(rebuildElectron({ args: [], env: {}, rebuildImpl })).rejects.toThrow('native rebuild failed')
})
