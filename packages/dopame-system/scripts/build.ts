import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capabilityResultSchemas, capabilitySchemas, protocolSchema, taskReceiptSchema } from '../src/protocol'
import { verifyPackages } from './verify-packages'

const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(system, '../..')
const editor = join(repository, 'packages/dopame')
const output = join(system, '.acde')
const inputs = join(output, 'inputs')

function run(command: string, args: string[], cwd = system) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

type EditorVariant = 'standalone' | 'collab-editor' | 'collaboration'

/**
 * `standalone`: the editor with no service dependency.
 * `collab-editor`: the same editor plus the author's collaboration module; needs the approval desktop.
 * `collaboration`: the caller-side debugging panel that stands in for an Agent.
 */
async function copyEditor(variant: EditorVariant) {
  const destination = join(inputs, variant)
  await mkdir(destination, { recursive: true })
  const config = JSON.parse(await readFile(join(editor, 'acde.config.jsonc'), 'utf8'))
  let entry: string | undefined
  if (variant === 'collaboration') {
    config.id = 'marktext-agent-preview'
    config.services = ['marktextdocs']
    config.requests = ['marktext-review']
    config.label = 'MarkText · Agent 调试面板'
    config.capabilities = {}
    delete config.mimeTypes
    entry = "import { marktextdocs } from 'acde:marktextdocs'\nimport { mountCollaboration } from './src/collaboration/mount'\nmountCollaboration(marktextdocs)\n"
  } else if (variant === 'collab-editor') {
    config.services = ['marktextdocs']
    config.requests = ['marktext-review']
    config.label = 'MarkText · Dopame（协作版）'
    entry = "import { marktextdocs } from 'acde:marktextdocs'\nimport { mountCollaborativeEditor } from './src/collaboration/mountEditor'\nmountCollaborativeEditor(marktextdocs as never)\n"
  } else {
    delete config.services
    delete config.requests
  }
  config.multiple = false
  delete config.$schema
  await writeFile(join(destination, 'acde.config.jsonc'), JSON.stringify(config, null, 2) + '\n')
  let html = await readFile(join(editor, 'index.html'), 'utf8')
  if (entry) {
    html = html.replace('/src/main.ts', '/entry.ts')
    await writeFile(join(destination, 'entry.ts'), entry)
  }
  await writeFile(join(destination, 'index.html'), html)
  await cp(join(editor, 'package.json'), join(destination, 'package.json'))
  await cp(join(editor, 'vite.config.ts'), join(destination, 'vite.config.ts'))
  // Source symlinks retain workspace package resolution; only compiled JS enters the output package.
  await symlink(join(editor, 'src'), join(destination, 'src'), 'dir')
  await symlink(join(editor, 'node_modules'), join(destination, 'node_modules'), 'dir')
}

/**
 * `desktop` hosts the document service exactly as a target desktop would: pairings stay pending.
 * `approval-desktop` adds the development approval host and is never a release candidate.
 */
async function copyDesktop(variant: 'desktop' | 'approval-desktop') {
  const destination = join(inputs, variant)
  const approvalHost = variant === 'approval-desktop'
  await cp(join(system, 'desktop'), destination, { recursive: true })
  const config = JSON.parse(await readFile(join(destination, 'acde.config.jsonc'), 'utf8'))
  if (approvalHost) {
    config.id = 'marktext-collaboration-approval-dev'
    config.label = 'MarkText 协作服务（开发用批准宿主）'
    config.services.marktextdocs = 'services/marktextdocs-approval-host.ts'
  } else config.services.marktextdocs = 'services/marktextdocs.ts'
  await writeFile(join(destination, 'acde.config.jsonc'), JSON.stringify(config, null, 2) + '\n')
  await cp(join(system, 'package.json'), join(destination, 'package.json'))
  await symlink(join(system, 'services'), join(destination, 'services'), 'dir')
  await symlink(join(system, 'node_modules'), join(destination, 'node_modules'), 'dir')
  await mkdir(join(destination, 'public'), { recursive: true })
  const [entry, bundle] = approvalHost ? ['src/approvalHost/worker.ts', 'approval-host-worker.js'] : ['src/worker.ts', 'state-worker.js']
  run('bun', ['build', join(system, entry), '--target', 'bun', '--outfile', join(destination, 'public', bundle)])
  return destination
}

await mkdir(output, { recursive: true })
await rm(inputs, { recursive: true, force: true })
await mkdir(inputs, { recursive: true })
await copyEditor('standalone')
await copyEditor('collab-editor')
await copyEditor('collaboration')
const metadata = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  sourceHasUncommittedChanges: execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim().length > 0,
  sdk: '0.0.9',
  protocol: 'marktext-documents/1',
  minimumStateRuntime: 'Bun with bun:sqlite; target runtime must pass SP-01',
  mode: 'proposal-preview',
  approval: 'unavailable',
  productionAgentRegistration: 'unverified',
  multiple: false
}
const developmentMetadata = {
  ...metadata,
  mode: 'development-approval-host',
  approval: 'development-desktop-host/1: clicks in the editor window, not protected human approval (SP-02 unverified)',
  notForProduction: true
}
for (const variant of ['desktop', 'approval-desktop'] as const) {
  const desktop = await copyDesktop(variant)
  await writeFile(join(desktop, 'public/protocol.schema.json'), JSON.stringify(protocolSchema, null, 2) + '\n')
  await writeFile(join(desktop, 'public/capabilities.schema.json'), JSON.stringify(capabilitySchemas, null, 2) + '\n')
  await writeFile(join(desktop, 'public/capability-results.schema.json'),
    JSON.stringify({ taskReceipt: taskReceiptSchema, results: capabilityResultSchemas }, null, 2) + '\n')
  await writeFile(join(desktop, 'public/release.json'),
    JSON.stringify(variant === 'desktop' ? metadata : developmentMetadata, null, 2) + '\n')
}
for (const variant of ['standalone', 'collab-editor', 'collaboration', 'desktop', 'approval-desktop']) {
  const publicDirectory = join(inputs, variant, 'public')
  await mkdir(publicDirectory, { recursive: true })
  await cp(join(repository, 'LICENSE'), join(publicDirectory, 'LICENSE'))
  await cp(join(repository, 'packages/desktop/build/THIRD-PARTY-LICENSES.txt'), join(publicDirectory, 'THIRD-PARTY-LICENSES.txt'))
  await writeFile(join(inputs, variant, '.gitignore'), '.acde/\n')
}

if (!process.argv.includes('--inputs-only')) {
  for (const variant of ['standalone', 'collab-editor', 'collaboration', 'desktop', 'approval-desktop']) {
    const directory = join(inputs, variant)
    run('acde', ['check', directory])
    run('acde', ['build', directory])
  }
  await verifyPackages(inputs)
}
process.stdout.write(`Generated standard inputs in ${inputs}\n`)
