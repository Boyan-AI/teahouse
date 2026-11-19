import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const signMacLan = require('./sign-mac-lan.cjs')
const context = { electronPlatformName: 'darwin', appOutDir: '/tmp/lan-output', packager: { appInfo: { productFilename: 'Teahouse' } } }

it('显式临时签名且严格校验，不使用个人身份或远程时间戳', async () => {
  const sign = vi.fn().mockResolvedValue(undefined)
  await signMacLan(context, sign)
  expect(sign).toHaveBeenCalledTimes(1)
  const options = sign.mock.calls[0][0]
  expect(options).toMatchObject({ app: join(context.appOutDir, 'Teahouse.app'), identity: '-', identityValidation: false,
    platform: 'darwin', preAutoEntitlements: false, preEmbedProvisioningProfile: false })
  expect(options).not.toHaveProperty('strictVerify')
  expect(options.optionsForFile('any')).toEqual({ timestamp: 'none',
    entitlements: require.resolve('app-builder-lib/templates/entitlements.mac.plist') })
})

it('非macOS平台不会签名，签名失败不能继续打包', async () => {
  const sign = vi.fn().mockRejectedValue(new Error('签名失败'))
  await expect(signMacLan({ ...context, electronPlatformName: 'linux' }, sign)).rejects.toThrow('仅支持 macOS')
  expect(sign).not.toHaveBeenCalled()
  await expect(signMacLan(context, sign)).rejects.toThrow('签名失败')
})
