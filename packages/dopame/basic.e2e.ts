import { test, expect } from 'acde/test'

const sourceValue = `Array.from(document.querySelectorAll('.editor-panel'))
  .find(panel => getComputedStyle(panel).display !== 'none')
  .querySelector('.CodeMirror').CodeMirror.getValue()`

test('source input survives mode changes and outline ignores fenced headings', async({ app }) => {
  const window = app!
  await window.getByRole('button', { name: '源码', exact: true }).click()
  const markdown = '```md\n# fake\n```\n\n# real\n\n中文正文'
  await window.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+a')
  await window.keyboard.insertText(markdown)
  await expect.poll(() => window.evaluate(sourceValue)).toBe(markdown)
  await window.getByRole('button', { name: 'real', exact: true }).click()
  await expect.poll(() => window.evaluate(`${sourceValue.replace('.getValue()', '.getCursor().line')}`)).toBe(4)
  await window.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(window.getByRole('textbox', { name: 'Markdown 编辑器' })).toContainText('中文正文')
  await window.getByRole('button', { name: '源码', exact: true }).click()
  await expect.poll(() => window.evaluate(sourceValue)).toBe(markdown)
})

test('native rich input works in empty and existing paragraphs with undo', async({ app }) => {
  const window = app!
  const paragraph = window.locator('.mu-content').first()
  await paragraph.click()
  await expect.poll(() => window.evaluate('getSelection().rangeCount')).toBe(1)
  await window.keyboard.insertText('中文 abc')
  await expect(paragraph).toContainText('中文 abc')
  await paragraph.click()
  await window.keyboard.insertText('追加')
  await expect(paragraph).toContainText('追加')
  await window.keyboard.press('ArrowLeft')
  await window.keyboard.insertText('|')
  await expect(paragraph).toContainText('追|加')
  await window.getByRole('button', { name: '撤销', exact: true }).click()
  await window.getByRole('button', { name: '重做', exact: true }).click()
  await expect(window.getByRole('textbox', { name: 'Markdown 编辑器' })).toContainText('追|加')
  await window.getByRole('button', { name: '源码', exact: true }).click()
  await expect.poll(() => window.evaluate(sourceValue)).toContain('中文 abc追|加')
})
