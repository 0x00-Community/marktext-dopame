import { execFileSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Starts the collaboration edition of the editor. The desktop it runs in only hosts the document
// service and opens the editor full screen. DEVELOPMENT ONLY: approvals come from the development host.
const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync('bun', ['scripts/build.ts', '--inputs-only'], { cwd: system, stdio: 'inherit' })
const inputs = join(system, '.acde/inputs')
const child = spawn('acde', ['dev', join(inputs, 'collab-editor'), '--desktop', join(inputs, 'approval-desktop'), ...process.argv.slice(2)], {
  cwd: inputs,
  env: { ...process.env, MARKTEXT_BUN: process.execPath },
  stdio: 'inherit',
})
child.on('exit', code => process.exit(code ?? 0))
