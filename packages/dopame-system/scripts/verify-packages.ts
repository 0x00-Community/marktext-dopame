import assert from 'node:assert/strict'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function inspectFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert.equal(entry.isSymbolicLink(), false, 'Built packages must not reference development symlinks.')
    assert.equal(/\.(?:node|dylib|so|dll|exe|sqlite|db)$/i.test(entry.name), false,
      'Built packages contain JavaScript/resources, not native dependencies or private state.')
    if (entry.isDirectory()) await inspectFiles(path)
  }
}

export async function verifyPackages(inputs: string) {
  const appManifests = []
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const declarations = [
    ['LICENSE', join(repository, 'LICENSE')],
    ['THIRD-PARTY-LICENSES.txt', join(repository, 'packages/desktop/build/THIRD-PARTY-LICENSES.txt')]
  ]
  const fixtureMarkers = /fixture-author|fixture-control|test-fixture/
  const approvalMarkers = /development-desktop-host|development-approval-host|approvalHost|attachApprovalHost|批准宿主/
  for (const variant of ['standalone', 'collab-editor', 'collaboration', 'desktop', 'approval-desktop']) {
    const output = join(inputs, variant, '.acde')
    await inspectFiles(output)
    const isDesktop = variant === 'desktop' || variant === 'approval-desktop'
    const assetDirectory = join(output, isDesktop ? 'desktop' : 'web')
    for (const [name, source] of declarations) {
      assert.deepEqual(await readFile(join(assetDirectory, name)), await readFile(source),
        'Built packages must retain the original upstream declarations verbatim.')
    }
    const manifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
    if (isDesktop) {
      const schema = JSON.parse(await readFile(join(output, 'desktop/protocol.schema.json'), 'utf8'))
      assert.equal(schema.$id, 'urn:marktext:documents:1')
      const release = JSON.parse(await readFile(join(output, 'desktop/release.json'), 'utf8'))
      assert.match(release.sourceCommit, /^[0-9a-f]{40}$/)
      assert.equal(release.multiple, false)
      const text = async(path: string) => readFile(join(output, path), 'utf8')
      const page = await text('desktop/index.html')
      const assetFiles = await readdir(join(output, 'desktop/assets')).then(names => names.map(name => join('desktop/assets', name)), () => [] as string[])
      const rootJsFiles = (await readdir(join(output, 'desktop')))
        .filter(name => name.endsWith('.js') && name !== 'state-worker.js' && name !== 'approval-host-worker.js')
        .map(name => join('desktop', name))
      const scripts = (await Promise.all([...assetFiles, ...rootJsFiles].filter(name => name.endsWith('.js'))
        .map(name => text(name)))).join('\n')
      const ids = manifest.acde.desktops.map((desktop: { id: string }) => desktop.id)
      if (variant === 'desktop') {
        // This is the configuration a target desktop would host: nothing in it can approve anything.
        assert.deepEqual(manifest.acde.services, [{ name: 'marktextdocs', module: 'services/marktextdocs.js' }])
        assert.deepEqual(ids, ['marktext-collaboration-dev'])
        assert.equal(release.approval, 'unavailable')
        assert.equal(release.notForProduction, undefined)
        const worker = await text('desktop/state-worker.js')
        assert.equal(fixtureMarkers.test(worker), false, 'The packaged state worker must never be the approving test fixture.')
        for (const [name, content] of [['state worker', worker], ['service', await text('services/marktextdocs.js')], ['page', page], ['page scripts', scripts]]) {
          assert.equal(approvalMarkers.test(content), false, `The standard desktop ${name} must contain no approval host.`)
        }
        assert.equal(page.includes('批准宿主'), false)
        assert.doesNotMatch(manifest.acde.desktops[0].name, /批准宿主/)
        await assert.rejects(lstat(join(output, 'desktop/approval-host-worker.js')))
      } else {
        assert.deepEqual(manifest.acde.services, [{ name: 'marktextdocs', module: 'services/marktextdocs.js' }])
        assert.equal((await text('services/marktextdocs.js')).includes('attachApprovalHost'), true)
        assert.deepEqual(ids, ['marktext-collaboration-approval-dev'])
        assert.equal(release.notForProduction, true)
        assert.match(release.approval, /^development-desktop-host\/1: .*not protected human approval/)
        assert.match(manifest.acde.desktops[0].name, /开发用批准宿主/, 'The approval desktop must say what it is.')
        const worker = await text('desktop/approval-host-worker.js')
        assert.equal(fixtureMarkers.test(worker), false, 'The approval host must never be the auto-approving test fixture.')
        await assert.rejects(lstat(join(output, 'desktop/state-worker.js')))
      }
    } else {
      const app = manifest.acde.apps[0]
      appManifests.push(app)
      assert.equal(app.multiple, false)
      const scripts = (await Promise.all((await readdir(join(output, 'web/assets'))).filter(name => name.endsWith('.js'))
        .map(name => readFile(join(output, 'web/assets', name), 'utf8')))).join('\n')
      const hostCalls = /attachApprovalHost|approvalHost\(/
      if (variant === 'collaboration') {
        // The caller-side panel stands in for an Agent: no files, and never the approval host.
        assert.equal(app.id, 'marktext-agent-preview')
        assert.deepEqual(app.capabilities ?? {}, {})
        assert.deepEqual(app.services, ['marktextdocs'])
        assert.deepEqual(app.requests, ['marktext-review'])
        assert.equal(app.mimeTypes, undefined)
        assert.equal(hostCalls.test(scripts), false, 'The agent-side app must never call the approval host.')
      } else if (variant === 'collab-editor') {
        assert.equal(app.id, 'marktext-dopame')
        assert.deepEqual(app.services, ['marktextdocs'])
        assert.equal(hostCalls.test(scripts), true)
      } else {
        // The standalone editor starts without any desktop service. It keeps the inert module slot
        // of the shared shell but no service call, approval call or module content.
        assert.equal(app.id, 'marktext-dopame')
        assert.equal(app.services, undefined)
        assert.equal(/attachApprovalHost|approvalHost\(|开发用批准宿主|acde:marktextdocs|inbox\.read|批准配对|collaboration-module/.test(scripts), false,
          'The standalone editor must contain no service call, approval call or collaboration module.')
      }
    }
  }
  assert.equal(appManifests.length, 3)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await verifyPackages(join(system, '.acde/inputs'))
  process.stdout.write('Verified standalone, collab-editor, collaboration, desktop and approval-desktop packages.\n')
}
