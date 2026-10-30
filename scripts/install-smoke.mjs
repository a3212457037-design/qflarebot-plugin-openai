// 复用线上构建脚本：临时目录不带 node_modules，SDK 由 QFlareBot 构建机注入。
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPluginDependencies, buildPluginIsolated } from '../../QFlareBot/apps/seed/scripts/plugin-build.mjs'
import { compareDeclaredManifest } from '../../QFlareBot/apps/seed/scripts/deploy-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(path.join(os.tmpdir(), 'openai-install-smoke-'))
try {
  for (const name of ['src', 'package.json', 'manifest.json', 'package-lock.json']) {
    await cp(path.join(root, name), path.join(temp, name), { recursive: true })
  }
  assert.deepEqual(await installPluginDependencies(temp), [])
  const result = await buildPluginIsolated(temp)
  const declared = JSON.parse(await readFile(path.join(temp, 'manifest.json'), 'utf8'))
  assert.equal(compareDeclaredManifest(declared, result.manifest).ok, true)
  assert.deepEqual(result.thirdPartyPackages, [])
  console.log(`官方隔离构建通过：${result.size} 字节，无第三方运行依赖，声明清单一致`)
} finally {
  // 递归清理前确认绝对路径仍是本脚本在系统临时目录中创建的目标。
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temp).startsWith('openai-install-smoke-'))
  await rm(temp, { recursive: true, force: true })
}
