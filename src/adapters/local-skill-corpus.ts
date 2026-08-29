import { compareUtf8Bytes } from '../core/canonical.js'
import type { LocalHostContext } from './host-context.js'

const RESERVED_SKILL_DIRECTORIES = new Set(['adopted', 'inbox', 'unity-skills'])

function isLinked(context: LocalHostContext, target: string): boolean {
  return context.fs.isSymbolicLink?.(target) === true
}

function isPlainTree(context: LocalHostContext, target: string): boolean {
  if (!context.fs.isDirectory(target) || isLinked(context, target)) return false
  try {
    for (const entry of context.fs.readDir(target)) {
      const child = context.path.join(target, entry.name)
      if (entry.isSymbolicLink || isLinked(context, child)) return false
      if (entry.isDirectory) {
        if (!isPlainTree(context, child)) return false
      } else if (!context.fs.isFile(child)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function skillNamesBelow(context: LocalHostContext, root: string): string[] {
  if (!context.fs.isDirectory(root) || isLinked(context, root)) return []
  let entries
  try {
    entries = context.fs.readDir(root)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory && !entry.isSymbolicLink)
    .map((entry) => entry.name)
    .filter((name) => {
      const directory = context.path.join(root, name)
      const skillMd = context.path.join(directory, 'SKILL.md')
      return isPlainTree(context, directory)
        && context.fs.isFile(skillMd)
        && !isLinked(context, skillMd)
    })
    .sort(compareUtf8Bytes)
}

/**
 * Enumerate resident Skills from the private data corpus itself.
 *
 * Product constants are not corpus contents: only plain top-level directories
 * with a plain SKILL.md are resident. Inbox and adopted remain separate groups.
 */
export function residentSkillNames(context: LocalHostContext): string[] {
  const root = context.path.join(context.hubRoot, 'skills')
  return skillNamesBelow(context, root)
    .filter((name) => !RESERVED_SKILL_DIRECTORIES.has(name.toLocaleLowerCase('en-US')))
}

/** Adopted Skills share the same plain, link-free library boundary. */
export function adoptedSkillNames(context: LocalHostContext): string[] {
  return skillNamesBelow(context, context.path.join(context.hubRoot, 'skills', 'adopted'))
}
