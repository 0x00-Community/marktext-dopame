import { test, expect } from 'acde/test'

test('opens MarkText and switches between editor modes', async({ app }) => {
  const window = app!
  await expect(window).toHaveTitle(/MarkText · Dopame/)
  await expect(window.getByRole('button', { name: '编辑' })).toBeVisible()
  await window.getByRole('button', { name: '源码' }).click()
  const source = window.getByRole('textbox', { name: 'Markdown 源码' })
  await source.fill('# Dopame\n\n中文正文')
  await expect(source).toHaveValue('# Dopame\n\n中文正文')
  await window.getByRole('button', { name: '编辑' }).click()
  await expect(window.getByRole('textbox', { name: '文档' })).toContainText('中文正文')
})

test('creates a private note and lists it', async({ app }) => {
  const window = app!
  await window.getByRole('button', { name: '新建笔记' }).click()
  await expect(window.getByRole('navigation', { name: '文件列表' })).toContainText('.md')
  await expect(window.getByRole('tab', { selected: true })).toContainText('.md')
})
