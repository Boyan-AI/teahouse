import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createUpdateManifest } from './create-update-manifest.mjs'
import { parseCabinetManifest } from '../src/shared/cabinet-update'

/** 用生成器真实输出回读协议解析器，确保两端格式一致。 */
it('生成可解析的大小/哈希清单，拒绝未确认的数据兼容性与非标准包名', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teahouse-manifest-'))
  try {
    const dmg = join(directory, 'Teahouse-0.66.0-mac-arm64.dmg')
    await writeFile(dmg, 'local fixture')
    const output = await createUpdateManifest(dmg, '更新说明', true)
    const manifest = parseCabinetManifest(await readFile(output, 'utf8'))
    expect(manifest.size).toBe(13)
    expect(manifest.sha256).toBe(createHash('sha256').update('local fixture').digest('hex'))
    await expect(createUpdateManifest(dmg, '', false)).rejects.toThrow('数据')
    await expect(createUpdateManifest(join(directory, 'other.dmg'), '', true)).rejects.toThrow('包名')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
