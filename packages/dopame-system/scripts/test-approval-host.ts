import { execFileSync } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs the collaboration edition of the editor in the approval desktop and drives its collaboration module.
const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync('bun', ['scripts/build.ts', '--inputs-only'], { cwd: system, stdio: 'inherit' })
const preview = join(system, '.acde/inputs/collab-editor')
await copyFile(join(system, 'test/approval-host.e2e.ts'), join(preview, 'approval-host.e2e.ts'))
execFileSync('acde', ['test', 'approval-host.e2e.ts', '--desktop', join(system, '.acde/inputs/approval-desktop'), '--workers', '1', ...process.argv.slice(2)], {
  cwd: preview,
  env: { ...process.env, MARKTEXT_BUN: process.execPath },
  stdio: 'inherit',
})
