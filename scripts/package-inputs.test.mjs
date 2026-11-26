import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 使用实际打包器的匹配规则，防止测试数据和本地工作目录混入安装包。 */
it('安装包仅收录生产构建，排除自测脚本、截图、数据库和本地计划', () => {
  const root = resolve('.')
  const filter = new FileMatcher(root, '/unused-package-output', value => value, pkg.build.files).createFilter()
  const file = { isDirectory: () => false }
  for (const path of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'out/renderer/ocr/model.onnx', 'package.json']) {
    expect(filter(resolve(root, path), file), path).toBe(true)
  }
  for (const path of ['out/agent-selftest.cjs', 'out/db-selftest.cjs', 'out/extension-ui-fixture/client-0/pantry.db', 'out/extension-ui-fixture/screenshot.png', '.agent/plans/active/local.md', '.env', 'release/old.dmg']) {
    expect(filter(resolve(root, path), file), path).toBe(false)
  }
  expect(pkg.build.mac.extraResources).toContainEqual({ from: 'scripts/macos-update-helper.sh', to: 'macos-update-helper.sh' })
  for (const path of ['scripts/create-update-manifest.mjs', 'scripts/macos-update-selftest.cjs', 'out/macos-update-package/Teahouse.app/Contents/Info.plist']) {
    expect(filter(resolve(root, path), file), path).toBe(false)
  }
})
