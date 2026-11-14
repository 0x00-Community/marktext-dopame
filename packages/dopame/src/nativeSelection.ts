// acdert 0.0.9 focuses contenteditable on pointer input without establishing a Range.
export function attachNativeSelection(root: HTMLElement): () => void {
  if (!navigator.userAgent.includes('acdert/0.0.9')) return () => {}

  const doc = root.ownerDocument
  let anchor: { node: Node; offset: number } | null = null

  function atPoint(event: MouseEvent): Range | null {
    const target = event.target as Element
    const content = target.closest<HTMLElement>('.mu-content')
    if (!content || !root.contains(content) || !content.isContentEditable) return null
    if (target.closest('[contenteditable="false"]')) return null

    // Empty-hint pseudo text is not a DOM endpoint; use the empty span itself.
    if (!content.textContent) {
      const range = doc.createRange()
      range.selectNodeContents(content)
      range.collapse(true)
      return range
    }
    const range = doc.caretRangeFromPoint(event.clientX, event.clientY)
    return range && content.contains(range.startContainer) ? range : null
  }

  function down(event: MouseEvent) {
    if (event.button !== 0) return
    const range = atPoint(event)
    const selection = doc.getSelection()
    if (!range || !selection) return
    if (event.shiftKey && selection.anchorNode && root.contains(selection.anchorNode)) {
      selection.extend(range.startContainer, range.startOffset)
    } else {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    anchor = { node: selection.anchorNode!, offset: selection.anchorOffset }
  }

  function move(event: MouseEvent) {
    if (!anchor || !(event.buttons & 1)) return
    const range = atPoint(event)
    if (!range) return
    doc.getSelection()!.setBaseAndExtent(anchor.node, anchor.offset, range.startContainer, range.startOffset)
  }

  function up() { anchor = null }
  root.addEventListener('mousedown', down, true)
  doc.addEventListener('mousemove', move)
  doc.addEventListener('mouseup', up)
  return () => {
    root.removeEventListener('mousedown', down, true)
    doc.removeEventListener('mousemove', move)
    doc.removeEventListener('mouseup', up)
  }
}
