import { test, expect, type Acde, type AppWindow } from 'acde/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** The desktop opens MarkText on start; a test uses that window, or opens one when none is there. */
async function appWindow(acde: Acde, app: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await acde.windows()).some(window => (window as { app?: string | null }).app === app)) return acde.window({ app })
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return acde.open(app)
}


// Runs only against the auto-approving fixture desktop (scripts/test-preview-data.ts).
const workspaceId = 'fixture-workspace'

// Service results are untyped JSON; each test asserts the fields it reads.
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function service(acde: Acde, method: string, ...args: unknown[]) {
  return acde.desktop.evaluate<Json>(
    `import('acde:marktextdocs').then(({marktextdocs})=>marktextdocs.${method}(...${JSON.stringify(args)}))`)
}

async function identity(acde: Acde, name: string) {
  const pairing = await service(acde, 'requestPairing', { name })
  const paired = await service(acde, 'claimPairing', pairing.pairingId, pairing.claimSecret)
  expect(paired.state).toBe('paired')
  const invoke = (capability: string, input: unknown) => service(acde, 'invoke', paired.credential,
    { protocol: 'marktext-documents/1', requestId: crypto.randomUUID(), capabilityVersion: 1, capability, input })
  const complete = async(capability: string, input: unknown) => {
    const receipt = await invoke(capability, input)
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = await service(acde, 'getTask', paired.credential, receipt.taskId)
      if (task.state === 'succeeded') return task.result
      if (task.state === 'failed' || task.state === 'cancelled') throw new Error(`Task ${task.state}: ${task.error?.code}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('The task did not finish.')
  }
  return { principalId: paired.principalId as string, invoke, complete }
}

async function connect(page: AppWindow, name: string) {
  await expect(page.getByRole('status')).toContainText('服务已连接')
  await page.getByRole('textbox', { name: '调用方名称' }).fill(name)
  await page.getByRole('button', { name: '申请配对', exact: true }).click()
  await page.getByRole('button', { name: '查询配对批准', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已配对')
}

async function open(page: AppWindow, section: string) {
  await page.getByRole('button', { name: section, exact: true }).click()
  await expect(page.getByRole('heading', { name: section, exact: true, level: 1 })).toBeVisible()
}

async function capture(page: AppWindow, name: string) {
  const directory = process.env.MARKTEXT_REVIEW_SCREENSHOTS
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${name}.png`) })
}

async function noErrors(acde: Acde) {
  expect((await acde.console()).entries.filter(entry => entry.level === 'error')).toHaveLength(0)
}

test('inbox shows provenance, separates same-named drafts and submits a proposal without changing the document', async({ acde }) => {
  const page = await appWindow(acde, 'marktext-agent-preview')
  const research = await identity(acde, '独立研究调用方')
  const first = await research.complete('documents.createDraft', { workspaceId, title: '同名草稿.md',
    markdown: '# 报告\n\n原始结论。\n', sources: [{ uri: 'urn:test:paper', label: '参考论文' }] })
  await research.complete('documents.createDraft', { workspaceId, title: '同名草稿.md', markdown: '另一份草稿\n' })
  await connect(page, '界面审阅调用方')

  await open(page, 'Agent 收件箱')
  await expect(page.getByRole('textbox', { name: '工作区' })).toHaveValue(workspaceId)
  await page.getByRole('button', { name: '读取已授权文档', exact: true }).click()
  const drafts = page.getByRole('button', { name: /^读取草稿：同名草稿\.md（.+）$/ })
  await expect(drafts).toHaveCount(2)
  const names = await page.evaluate<string[]>(`Array.from(document.querySelectorAll('.document-list button')).map(button => button.getAttribute('aria-label'))`)
  expect(new Set(names).size).toBe(2)
  const target = names.find(name => name.includes(first.document.docId.slice(0, 8)))!
  await page.getByRole('button', { name: target, exact: true }).click()
  const preview = page.getByRole('region', { name: '固定版本预览', exact: true })
  await expect(preview).toContainText('原始结论。')
  await expect(preview).toContainText('独立研究调用方')
  await expect(preview).toContainText('参考论文')
  await expect(preview).toContainText('urn:test:paper')
  await expect(preview).toContainText('未经验证')
  await capture(page, 'data-inbox')

  await open(page, '建议面板')
  const indexed = await research.invoke('documents.blocks', { document: first.document })
  await page.getByRole('combobox', { name: '目标块' }).selectOption(indexed.blocks[1].blockId)
  await page.getByRole('textbox', { name: '建议内容' }).fill('润色后的结论。\n')
  await page.getByRole('textbox', { name: '建议理由' }).fill('结论润色')
  await page.getByRole('button', { name: '提交建议', exact: true }).click()
  await expect(page.getByRole('heading', { name: '任务中心', exact: true, level: 1 })).toBeVisible()
  const lookup = page.getByRole('button', { name: /^查询任务：提交建议 / })
  await expect.poll(async() => { await lookup.click(); return page.getByRole('region', { name: '持久任务', exact: true }).textContent() }).toContain('已完成')

  const latest = await research.invoke('documents.list', { workspaceId })
  expect(latest.documents.find((item: Json) => item.document.docId === first.document.docId).document.revision).toBe('0')

  await open(page, 'Agent 收件箱')
  await page.getByRole('button', { name: target, exact: true }).click()
  await expect(preview).toContainText('原始结论。')
  await open(page, '建议面板')
  await page.getByRole('button', { name: '审阅建议：结论润色', exact: true }).click()
  const diff = page.getByRole('region', { name: '建议差异', exact: true })
  await expect(diff).toContainText('界面审阅调用方')
  await expect(diff).toContainText('1 处')
  await expect(diff).toContainText('原始结论。')
  await expect(diff).toContainText('润色后的结论。')
  await capture(page, 'data-proposal')
  for (const action of ['接受建议', '拒绝建议', '撤销本次接受']) {
    await expect(page.getByRole('button', { name: `${action}：结论润色`, exact: true })).toBeDisabled()
  }

  await open(page, '任务中心')
  const notices = page.getByRole('region', { name: '通知记录', exact: true })
  await expect.poll(() => notices.textContent(), { timeout: 15000 }).toContain('有一条文档建议等待审阅')
  await expect(notices).not.toContainText('原始结论')
  await capture(page, 'data-tasks')
  await page.getByRole('button', { name: '定位通知：有一条文档建议等待审阅', exact: true }).click()
  await expect(page.getByRole('heading', { name: '建议面板', exact: true, level: 1 })).toBeVisible()
  await expect(diff).toContainText('润色后的结论。')
  // The development desktop receives the same notification and routes a click back to the app.
  await open(page, '连接与授权')
  const shown = () => acde.desktop.evaluate<string>(`document.querySelector('#notifications').textContent`)
  await expect.poll(shown).toContain('有一条文档建议等待审阅')
  expect(await shown()).not.toContain('结论')
  await acde.desktop.evaluate(`document.querySelector('#notifications button[aria-label="打开审阅：有一条文档建议等待审阅"]').click()`)
  await expect(page.getByRole('heading', { name: '建议面板', exact: true, level: 1 })).toBeVisible()
  await expect(diff).toContainText('润色后的结论。')
  const after = await research.invoke('documents.list', { workspaceId })
  expect(after.documents.find((item: Json) => item.document.docId === first.document.docId).document.revision).toBe('0')

  // An author commit makes the pending proposal stale; the panel must say so instead of offering it.
  expect(await service(acde, 'requestPairing', { name: `fixture-control:edit:${first.document.docId}` })).toEqual({ state: 'edited' })
  await open(page, 'Agent 收件箱')
  await page.getByRole('button', { name: '读取已授权文档', exact: true }).click()
  await page.getByRole('button', { name: target, exact: true }).click()
  await expect(preview).toContainText('Author edit by fixture control.')
  await open(page, '建议面板')
  await page.getByRole('button', { name: '审阅建议：结论润色', exact: true }).click()
  await expect(diff).toContainText('已过期')
  await expect(diff).toContainText('重新生成建议')
  await expect(diff).toContainText('原始结论。')
  await expect(page.getByRole('button', { name: '接受建议：结论润色', exact: true })).toBeDisabled()
  await noErrors(acde)
})

test('a recipient holding only the handoff grant reads the artifact and its receipt reaches the sender', async({ acde }) => {
  const page = await appWindow(acde, 'marktext-agent-preview')
  await connect(page, '下游接收调用方 #receipt-only')
  const recipient = (await page.evaluate<string>(`document.querySelector('[aria-label="调用身份 ID"]').textContent`)).trim()
  expect(recipient).toMatch(/^[0-9a-f-]{36}$/)
  await expect(page.getByRole('region', { name: '当前权限' })).toContainText('尚无可用权限')

  const sender = await identity(acde, '独立发送调用方')
  const { document } = await sender.complete('documents.createDraft', { workspaceId, title: '交付稿.md', markdown: '# 交付\n\n固定版本正文。\n' })
  const artifact = await sender.complete('artifacts.export', { document, format: 'markdown' })

  // Without a handoff the recipient has nothing to read and no receiving controls.
  await open(page, 'Agent 收件箱')
  await expect(page.getByRole('button', { name: '读取已授权文档', exact: true })).toBeDisabled()
  await open(page, '任务中心')
  await expect(page.getByRole('region', { name: '接收交接产物', exact: true })).toHaveCount(0)

  const handoff = await sender.complete('handoffs.create', { artifactId: artifact.artifactId, recipientPrincipalId: recipient,
    purpose: '发布', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z') })
  expect(handoff.state).toBe('awaiting_receipt')
  await open(page, '连接与授权')
  await page.getByRole('button', { name: '刷新当前权限', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前权限' })).toContainText('artifacts.read')
  await expect(page.getByRole('region', { name: '当前权限' })).not.toContainText('documents.read')

  await open(page, '任务中心')
  await page.getByRole('textbox', { name: '交接 ID' }).fill(handoff.handoffId)
  await page.getByRole('button', { name: '读取交接产物', exact: true }).click()
  const inbound = page.getByRole('region', { name: '接收交接产物', exact: true })
  await expect(inbound).toContainText('固定版本正文。')
  await expect(inbound).toContainText(artifact.digest)
  expect((await sender.invoke('handoffs.get', { handoffId: handoff.handoffId })).state).toBe('awaiting_receipt')
  await page.getByRole('button', { name: '确认接收：交付稿.md', exact: true }).click()
  await expect.poll(async() => (await sender.invoke('handoffs.get', { handoffId: handoff.handoffId })).state).toBe('accepted')
  const receipt = (await sender.invoke('handoffs.get', { handoffId: handoff.handoffId })).receipt
  expect(receipt).toMatchObject({ status: 'accepted', artifactDigest: artifact.digest, recipientPrincipalId: recipient })
  await page.getByRole('button', { name: '查询交接结果', exact: true }).click()
  await expect(page.getByRole('main')).toContainText('接收方已接受 · 发布')
  await noErrors(acde)
})

test('harness agent reports 4D progress and materializes a verified artifact to managed_workspace/ through the panel', async({ acde }) => {
  const page = await appWindow(acde, 'marktext-agent-preview')
  await connect(page, 'Harness调度调用方')

  const auditor = await identity(acde, '专职审查员 #auditor')
  const sender = await identity(acde, '独立发送调用方')
  const { document } = await sender.complete('documents.createDraft', {
    workspaceId,
    title: '物化稿.md',
    markdown: '# 受管沙箱产物\n\n已通过专职审查的交付内容。\n',
  })
  await auditor.complete('proposals.verify', {
    targetKind: 'draft',
    targetId: document.docId,
    outcome: 'verified',
    completionRate: 100,
  })
  const artifact = await sender.complete('artifacts.export', { document, format: 'markdown' })

  await open(page, '任务中心')
  await page.getByRole('textbox', { name: '产物 ID', exact: true }).first().fill(artifact.artifactId)
  await page.getByRole('textbox', { name: '受管沙箱相对路径（.md / .txt）', exact: true }).fill('deliverables/report.md')
  await page.getByRole('button', { name: '原子落盘至受管目录', exact: true }).click()

  const lookup = page.getByRole('button', { name: /^查询任务：受管沙箱落盘 / })
  await expect.poll(async() => {
    await lookup.click()
    return page.getByRole('region', { name: '持久任务', exact: true }).textContent()
  }).toContain('已完成')
  expect(await page.evaluate<string>(`document.querySelector('.task-list pre')?.textContent ?? ''`)).toContain('deliverables/report.md')

  await page.getByRole('textbox', { name: '当前动作', exact: true }).fill('受管沙箱物化核验完毕')
  await page.getByRole('button', { name: '更新任务进度', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('TOO_LATE')
  await noErrors(acde)
})
