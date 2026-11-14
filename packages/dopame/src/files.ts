import { fs } from 'acde:fs'

export { fs } from 'acde:fs'

export type Resource =
  | { kind: 'root'; root: string; path: string; version?: string }
  | { kind: 'handle'; handle: FileSystemFileHandle; modifiedMs: number; size: number }

export type OpenedFile = { name: string; text: string; resource: Resource }

const pickers = window as unknown as {
  showOpenFilePicker(options: { multiple: boolean }): Promise<FileSystemFileHandle[]>
  showSaveFilePicker(options: { suggestedName: string }): Promise<FileSystemFileHandle>
}

// Keep the BOM in the editor's text so saving preserves it, like line endings.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function readHandle(handle: FileSystemFileHandle): Promise<OpenedFile> {
  const file = await handle.getFile()
  return {
    name: file.name,
    text: decoder.decode(await file.arrayBuffer()),
    resource: { kind: 'handle', handle, modifiedMs: file.lastModified, size: file.size }
  }
}

export async function readResource(resource: Resource): Promise<OpenedFile> {
  if (resource.kind === 'handle') return readHandle(resource.handle)

  const file = await fs.readBytes(resource.root, resource.path)
  return {
    name: resource.path.slice(resource.path.lastIndexOf('/') + 1),
    text: decoder.decode(file.data),
    resource: { ...resource, version: file.version }
  }
}

export async function createNote(root: string, path: string): Promise<OpenedFile> {
  await fs.writeFile(root, path, '', { create: 'new' })
  return readResource({ kind: 'root', root, path })
}

export async function requireAvailablePath(root: string, path: string) {
  try {
    await fs.stat(root, path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return
    throw error
  }
  throw new Error('此名称已存在，请换一个名称。')
}

export async function openFiles(): Promise<OpenedFile[]> {
  const handles = await pickers.showOpenFilePicker({ multiple: true })
  return Promise.all(handles.map(readHandle))
}

export async function saveResource(resource: Resource, text: string): Promise<Resource> {
  if (resource.kind === 'root') {
    if (!resource.version) {
      throw Object.assign(new Error('Reload this file before saving: its version is unknown.'), {
        code: 'ECONFLICT'
      })
    }
    await fs.writeFile(resource.root, resource.path, text, {
      ifVersion: resource.version,
      create: 'never'
    })
    // acdert 0.0.9 write entries omit version; obtain it from the committed snapshot.
    const saved = await readResource(resource)
    if (saved.text !== text) {
      throw Object.assign(new Error('保存后文件再次发生变化，当前编辑已保留。'), { code: 'ECONFLICT' })
    }
    return saved.resource
  }

  // Handles have no CAS: metadata checks cannot prevent changes during the write.
  const current = await resource.handle.getFile()
  if (current.lastModified !== resource.modifiedMs || current.size !== resource.size) {
    throw Object.assign(new Error('This file changed on disk. Reload it before saving.'), {
      code: 'ECONFLICT'
    })
  }

  const writable = await resource.handle.createWritable()
  try {
    await writable.write(text)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => {})
    throw error
  }
  const saved = await resource.handle.getFile()
  return { ...resource, modifiedMs: saved.lastModified, size: saved.size }
}

export async function saveAs(name: string, text: string): Promise<{ name: string; resource: Resource }> {
  const handle = await pickers.showSaveFilePicker({ suggestedName: name })
  const file = await handle.getFile()
  const resource = await saveResource(
    { kind: 'handle', handle, modifiedMs: file.lastModified, size: file.size },
    text
  )
  return { name: handle.name, resource }
}
