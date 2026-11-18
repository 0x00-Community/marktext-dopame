import { execFileSync } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs the collaboration preview against a desktop whose state worker is replaced by the
// auto-approving test fixture. Nothing produced here is a release input.
const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync('bun', ['scripts/build.ts', '--inputs-only'], { cwd: system, stdio: 'inherit' })
const desktop = join(system, '.acde/data-fixture-desktop')
await rm(desktop, { recursive: true, force: true })
await mkdir(desktop, { recursive: true })
const source = join(system, '.acde/inputs/desktop')
for (const entry of ['acde.config.jsonc', 'index.html', 'package.json', 'src', 'public']) {
  await cp(join(source, entry), join(desktop, entry), { recursive: true })
}
await symlink(join(system, 'services'), join(desktop, 'services'), 'dir')
await symlink(join(system, 'node_modules'), join(desktop, 'node_modules'), 'dir')
execFileSync('bun', ['build', join(system, 'test/fixtures/approving-worker.ts'), '--target', 'bun',
  '--outfile', join(desktop, 'public/state-worker.js')], { cwd: system, stdio: 'inherit' })
// The fixture must never pass for the development desktop if someone finds this directory.
const config = JSON.parse(await readFile(join(desktop, 'acde.config.jsonc'), 'utf8'))
config.id = 'marktext-collaboration-test-fixture'
config.label = 'MarkText 测试夹具桌面（自动批准，不得安装）'
await writeFile(join(desktop, 'acde.config.jsonc'), JSON.stringify(config, null, 2) + '\n')
const release = JSON.parse(await readFile(join(desktop, 'public/release.json'), 'utf8'))
await writeFile(join(desktop, 'public/release.json'), JSON.stringify({ ...release, mode: 'test-fixture',
  approval: 'test-fixture-auto-approves-every-pairing', notForRelease: true }, null, 2) + '\n')
const page = await readFile(join(desktop, 'index.html'), 'utf8')
await writeFile(join(desktop, 'index.html'), page.replaceAll('MarkText 协作开发桌面', 'MarkText 测试夹具桌面（自动批准所有配对，不得安装）'))
const preview = join(system, '.acde/inputs/collaboration')
await copyFile(join(system, 'test/preview-data.e2e.ts'), join(preview, 'preview-data.e2e.ts'))
execFileSync('acde', ['test', 'preview-data.e2e.ts', '--desktop', desktop, '--workers', '1', ...process.argv.slice(2)], {
  cwd: preview,
  env: { ...process.env, MARKTEXT_BUN: process.execPath },
  stdio: 'inherit',
})
