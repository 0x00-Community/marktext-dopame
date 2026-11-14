import type { Resource } from './files'

export function containsResource(resource: Resource | null, root: string, path: string) {
  return resource?.kind === 'root' && resource.root === root
    && (resource.path === path || resource.path.startsWith(`${path}/`))
}

export function renamedResource(resource: Resource, root: string, from: string, to: string): Resource {
  if (resource.kind !== 'root' || !containsResource(resource, root, from)) return resource
  return { ...resource, path: to + resource.path.slice(from.length) }
}

export function entryPath(folder: string, name: string) {
  if (!name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new Error('请输入文件或文件夹名称，不要包含路径。')
  }
  return folder ? `${folder}/${name}` : name
}
