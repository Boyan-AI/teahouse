// 本地发布清单生成器，只读取指定 DMG 并在同目录原子写入清单，不执行网络发布。
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, writeFile, rename, rm, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 计算已完成 DMG 的大小及 SHA256，发布者须明确确认数据兼容性。 */
export async function createUpdateManifest(dmg, notes, dataCompatible) {
  const file = basename(dmg)
  const match = /^Teahouse-((?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5}))-mac-arm64\.dmg$/.exec(file)
  if (!match || dataCompatible !== true) throw new Error('需要标准 macOS arm64 包名，并明确确认无不兼容数据变更')
  if (typeof notes !== 'string' || notes.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(notes)) throw new Error('更新说明无效或超过 4000 字符')
  const before = await stat(dmg)
  if (!before.isFile() || before.size <= 0 || before.size > 512 * 1024 * 1024) throw new Error('安装包大小无效')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(dmg)) { bytes += chunk.length; hash.update(chunk) }
  const after = await stat(dmg)
  if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('安装包在生成清单期间发生变化')
  const manifest = { schema: 1, version: match[1], platform: 'mac', arch: 'arm64', file,
    size: bytes, sha256: hash.digest('hex'), notes, dataCompatible: true }
  const output = join(dirname(resolve(dmg)), 'teahouse-update.json')
  const temporary = join(dirname(output), `.teahouse-manifest-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, output)
  } finally { await rm(temporary, { force: true }) }
  return output
}

/** 命令行只接受已知选项，说明从可选文本文件加载。 */
async function main() {
  const [dmg, ...options] = process.argv.slice(2)
  const notesIndex = options.indexOf('--notes')
  const allowed = options.filter((_, index) => index !== notesIndex + 1 || notesIndex < 0)
  if (!dmg || !options.includes('--compatible-data') || allowed.some(option => !['--notes', '--compatible-data'].includes(option)) ||
    (notesIndex >= 0 && !options[notesIndex + 1])) throw new Error('用法 npm run update:manifest -- <DMG路径> --compatible-data [--notes 更新说明.txt]')
  const notes = notesIndex >= 0 ? await readFile(options[notesIndex + 1], 'utf8') : ''
  console.log(await createUpdateManifest(resolve(dmg), notes, true))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
