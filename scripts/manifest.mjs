import { readFile, copyFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

if (process.argv.includes('--sync')) {
  await copyFile('dist/manifest.json', 'manifest.json')
  console.log('已同步根目录 manifest.json')
} else {
  const source = JSON.parse(await readFile('manifest.json', 'utf8'))
  const built = JSON.parse(await readFile('dist/manifest.json', 'utf8'))
  if (!isDeepStrictEqual(source, built)) throw new Error('manifest.json 与源码不一致，请运行 npm run sync')
  console.log('manifest.json 与构建清单一致')
}
