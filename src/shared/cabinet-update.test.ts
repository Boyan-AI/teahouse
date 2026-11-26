import { describe, expect, it } from 'vitest'
import { normalizeCabinetUpdateConfig, parseCabinetManifest } from './cabinet-update'

const valid = { schema: 1, version: '0.66.0', platform: 'mac', arch: 'arm64', file: 'Teahouse-0.66.0-mac-arm64.dmg',
  size: 1024, sha256: 'a'.repeat(64), notes: '支持文件柜更新', dataCompatible: true }

describe('文件柜更新清单', () => {
  it('接受严格清单并拒绝截断、超限和未知字段', () => {
    expect(parseCabinetManifest(JSON.stringify(valid))).toEqual(valid)
    for (const text of ['{', 'null', '[]', ' '.repeat(65537), JSON.stringify({ ...valid, command: 'anything' })]) {
      expect(() => parseCabinetManifest(text)).toThrow('invalid-manifest')
    }
  })
  it.each([
    ['version', '1.0.0-beta'], ['version', '01.0.0'], ['arch', 'x64'], ['platform', 'linux'],
    ['file', '../release.dmg'], ['file', '/tmp/release.dmg'], ['file', 'https://example.com/a.dmg'],
    ['size', 0], ['size', 512 * 1024 * 1024 + 1], ['size', 1.2], ['sha256', 'ab'],
    ['dataCompatible', false], ['notes', 'x'.repeat(4001)]
  ])('拒绝非法字段 %s = %s', (key, value) => {
    expect(() => parseCabinetManifest(JSON.stringify({ ...valid, [key]: value }))).toThrow('invalid-manifest')
  })
  it('旧配置默认未设置来源，目录只能是柜内相对路径', () => {
    expect(normalizeCabinetUpdateConfig(undefined)).toEqual({ nodeId: '', directory: '', autoCheck: true })
    expect(normalizeCabinetUpdateConfig({ nodeId: 'publisher', directory: '更新/mac', autoCheck: false }).nodeId).toBe('publisher')
    for (const directory of ['../x', '/x', 'C:/x', 'a//b', 'a/./b', 'https://x', Array(16).fill('x').join('/'),
      Array(4).fill('x'.repeat(250)).join('/')]) {
      expect(normalizeCabinetUpdateConfig({ nodeId: 'publisher', directory, autoCheck: true }).nodeId).toBe('')
    }
    expect(normalizeCabinetUpdateConfig({ nodeId: 'publisher', directory: Array(15).fill('x').join('/'), autoCheck: true }).nodeId).toBe('publisher')
  })
})
