import { test, expect, type AppWindow } from 'acde/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sourceValue = `Array.from(document.querySelectorAll('.editor-panel'))
  .find(panel => getComputedStyle(panel).display !== 'none')
  .querySelector('.CodeMirror').CodeMirror.getValue()`

async function enterSource(app: AppWindow, text: string) {
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+a')
  await app.keyboard.insertText(text)
  await expect.poll(() => app.evaluate(sourceValue)).toBe(text)
}

async function appendSource(app: AppWindow, text: string) {
  await app.evaluate(`(() => {
    const editor = Array.from(document.querySelectorAll('.editor-panel'))
      .find(panel => getComputedStyle(panel).display !== 'none').querySelector('.CodeMirror').CodeMirror
    editor.focus()
    editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length)
  })()`)
  await app.keyboard.insertText(text)
}

async function createNote(app: AppWindow, name: string) {
  await app.getByRole('button', { name: '新建笔记', exact: true }).click()
  await app.getByRole('textbox', { name: '名称', exact: true }).fill(name)
  await app.getByRole('button', { name: '创建', exact: true }).click()
  await expect(app.getByRole('tab', { name, exact: true })).toBeVisible()
}

test('an external change is never overwritten and the local edit stays recoverable', async({ app, acde, home }) => {
  const window = app!
  const folder = join(home, 'conflict-project')
  await mkdir(folder)
  await acde.chooseFolder(folder)
  await window.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await createNote(window, '冲突.md')
  await enterSource(window, '第一版')
  await window.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => readFile(join(folder, '冲突.md'), 'utf8')).toBe('第一版')

  await writeFile(join(folder, '冲突.md'), '外部编辑器写入的版本')
  await appendSource(window, '，本地继续输入')
  await window.getByRole('button', { name: '保存', exact: true }).click()
  await expect(window.getByRole('alert')).toContainText('已在外部被修改')
  expect(await readFile(join(folder, '冲突.md'), 'utf8')).toBe('外部编辑器写入的版本')
  expect(await window.evaluate(sourceValue)).toBe('第一版，本地继续输入')
  await expect(window.getByRole('status')).toContainText('未保存')

  // The preserved edit can still leave through an explicit new target.
  const rescued = join(home, 'rescued.md')
  await acde.chooseSaveFile(rescued)
  await window.getByRole('button', { name: '导出副本', exact: true }).click()
  await expect.poll(() => readFile(rescued, 'utf8').catch(() => '')).toBe('第一版，本地继续输入')
  expect(await readFile(join(folder, '冲突.md'), 'utf8')).toBe('外部编辑器写入的版本')
})

test('a file that is not UTF-8 is refused with an explanation and left untouched', async({ app, acde, home }) => {
  const window = app!
  const folder = join(home, 'encoding-project')
  await mkdir(folder)
  const bytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
  await writeFile(join(folder, 'gbk.md'), bytes)
  await acde.chooseFolder(folder)
  await window.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await window.getByRole('button', { name: /^≡\s*gbk\.md$/ }).click()
  await expect(window.getByRole('alert')).toContainText('不是 UTF-8 文本')
  await expect(window.getByRole('tab')).toHaveCount(1)
  await expect(window.getByRole('tab', { name: 'gbk.md', exact: true })).toHaveCount(0)
  expect(new Uint8Array(await readFile(join(folder, 'gbk.md')))).toEqual(bytes)
})

test('exporting a copy keeps the document name, dirty state and save target', async({ app, acde, home }) => {
  const window = app!
  await createNote(window, '原稿.md')
  await enterSource(window, '已保存的正文')
  await window.getByRole('button', { name: '保存', exact: true }).click()
  await expect(window.getByRole('status')).toContainText('已保存')
  await appendSource(window, '，后续修改')
  const copy = join(home, 'copy.md')
  await acde.chooseSaveFile(copy)
  await window.getByRole('button', { name: '导出副本', exact: true }).click()
  await expect.poll(() => readFile(copy, 'utf8').catch(() => '')).toBe('已保存的正文，后续修改')
  await expect(window.getByRole('status')).toContainText('保存目标未改变')
  await expect(window.getByRole('status')).toContainText('未保存')
  await expect(window.getByRole('tab', { name: '● 原稿.md', exact: true })).toBeVisible()
  const stored = `import('acde:fs').then(({fs}) => fs.readText('private', '原稿.md')).then(file => file.text)`
  expect(await window.evaluate(stored)).toBe('已保存的正文')

  await appendSource(window, '，再保存')
  await window.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => window.evaluate(stored)).toBe('已保存的正文，后续修改，再保存')
  expect(await readFile(copy, 'utf8')).toBe('已保存的正文，后续修改')
})

test('tabs that share a name are distinguished by location for name-based control', async({ app }) => {
  const window = app!
  await window.getByRole('button', { name: '新建', exact: true }).click()
  await expect(window.getByRole('tab')).toHaveCount(2)
  const names = () => window.evaluate<string[]>(`Array.from(document.querySelectorAll('[role=tab]')).map(tab => tab.getAttribute('aria-label'))`)
  const [first, second] = await names()
  expect(first).toMatch(/^● 未命名\.md（未保存到文件 · [0-9a-f]{4}）$/)
  expect(second).toMatch(/^● 未命名\.md（未保存到文件 · [0-9a-f]{4}）$/)
  expect(first).not.toBe(second)
  await window.getByRole('tab', { name: first, exact: true }).click()
  await enterSource(window, '第一个标签的内容')
  await window.getByRole('tab', { name: second, exact: true }).click()
  await expect.poll(() => window.evaluate(sourceValue).catch(() => '')).not.toBe('第一个标签的内容')
  // Closing a sibling must not rename the tab that remains addressable by its old name.
  await window.getByRole('button', { name: '新建', exact: true }).click()
  await expect(window.getByRole('tab')).toHaveCount(3)
  expect((await names()).slice(0, 2)).toEqual([first, second])
  await createNote(window, '唯一.md')
  await expect(window.getByRole('tab', { name: '唯一.md', exact: true })).toHaveCount(1)
  await expect(window.getByRole('button', { name: '关闭 唯一.md', exact: true })).toHaveCount(1)
})

test('an unsaved draft and its mode return after the window reloads', async({ app }) => {
  const window = app!
  await enterSource(window, '# 尚未保存\n\n重载后必须还在')
  await expect.poll(() => window.evaluate(
    `import('acde:fs').then(({fs}) => fs.readText('private', '.marktext/session.json')).then(file => file.text.includes('重载后必须还在'), () => false)`)).toBe(true)
  await window.reload()
  await expect(window.getByRole('status')).toContainText('已恢复上次会话')
  await expect.poll(() => window.evaluate(sourceValue).catch(() => '')).toBe('# 尚未保存\n\n重载后必须还在')
  await expect(window.getByRole('status')).toContainText('未保存')
})

test('periodic external file watching automatically refreshes a clean tab when enabled in preferences', async({ app, acde, home }) => {
  const window = app!
  const folder = join(home, 'watch-project')
  await mkdir(folder)
  await acde.chooseFolder(folder)
  await window.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await createNote(window, 'watched.md')
  await enterSource(window, '初始版本')
  await window.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => readFile(join(folder, 'watched.md'), 'utf8')).toBe('初始版本')

  // Enable 5-second external file polling in preferences
  await window.getByRole('button', { name: '偏好设置', exact: true }).click()
  await window.locator('#pref-watch-external').selectOption('5')
  await window.getByRole('button', { name: '完成', exact: true }).click()

  // Modify file on disk externally while tab is clean; polling reloads it automatically
  await writeFile(join(folder, 'watched.md'), '外部自动轮询更新后的内容')
  await expect.poll(() => window.evaluate(sourceValue).catch(() => ''), { timeout: 10000 }).toBe('外部自动轮询更新后的内容')
})
