/**
 * Prompt-store persistence for `@deepseek-ai/dsh-prompt-kmanager`.
 *
 * Everything the manager owns lives under `<home>/kmanager.prompts/`:
 *
 * ```text
 * kmanager.prompts/
 *   index.json            # PromptStore document (entry meta, project registry)
 *   global/<id>.md        # global entry content
 *   projects/<pid>/<id>.md
 *   modes/<id>.md         # managed mode persona text
 * ```
 *
 * Entry content is kept separate from the index so a large prompt never
 * round-trips through JSON, and the whole folder can be deleted (or restored
 * from a backup) to hand the harness back to the official plugins untouched.
 * @module @deepseek-ai/dsh-prompt-kmanager/store
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ModePersona, ModeState, PromptEntryMeta, PromptStore, ProjectState } from './types.ts'

/** Default name of the prompt-store folder under the harness home. */
export const DEFAULT_STORE_DIR = 'kmanager.prompts'

/** New entries get a short random id; the marker tag in target files is this id. */
export function newEntryId(prefix = 'p'): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${rand}`
}

/** A stable project id from a path (kept lowercase, dash-separated). */
export function projectIdFromPath(path: string): string {
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'project'
  const id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return id || 'project'
}

/** Create the store document with defaults. */
export function emptyStore(): PromptStore {
  return {
    version: 1,
    global: { entries: [], deleted: [] },
    projects: [],
    modes: {},
  }
}

/** Resolve all store paths from the store directory. */
export interface StorePaths {
  readonly root: string
  readonly index: string
  readonly globalDir: string
  readonly projectsDir: string
  readonly modesDir: string
}

export function storePaths(storeDir: string): StorePaths {
  return {
    root: storeDir,
    index: join(storeDir, 'index.json'),
    globalDir: join(storeDir, 'global'),
    projectsDir: join(storeDir, 'projects'),
    modesDir: join(storeDir, 'modes'),
  }
}

/** Read the store document; missing or malformed files degrade to empty. */
export function loadStore(storeDir: string): PromptStore {
  const paths = storePaths(storeDir)
  if (!existsSync(paths.index)) return emptyStore()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(paths.index, 'utf8'))
  } catch {
    return emptyStore()
  }
  return normalizeStore(parsed)
}

/** Coerce an unknown document into a valid PromptStore shape. */
function normalizeStore(value: unknown): PromptStore {
  const empty = emptyStore()
  if (value === null || typeof value !== 'object') return empty
  const raw = value as Record<string, unknown>
  const store: PromptStore = { ...empty }
  if (raw.global !== null && typeof raw.global === 'object') {
    const g = raw.global as Record<string, unknown>
    if (Array.isArray(g.entries)) store.global.entries = g.entries.filter(isEntryMeta)
    if (Array.isArray(g.deleted)) store.global.deleted = g.deleted.filter((d): d is string => typeof d === 'string')
  }
  if (Array.isArray(raw.projects)) {
    for (const p of raw.projects) {
      if (p === null || typeof p !== 'object') continue
      const proj = p as Record<string, unknown>
      if (typeof proj.path !== 'string' || proj.path.length === 0) continue
      store.projects.push(normalizeProject(proj))
    }
  }
  if (raw.modes !== null && typeof raw.modes === 'object') {
    for (const [id, m] of Object.entries(raw.modes as Record<string, unknown>)) {
      if (m === null || typeof m !== 'object') continue
      store.modes[id] = normalizeMode(id, m as Record<string, unknown>)
    }
  }
  return store
}

function isEntryMeta(value: unknown): value is PromptEntryMeta {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.id === 'string' && typeof e.title === 'string'
}

function normalizeProject(raw: Record<string, unknown>): ProjectState {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : projectIdFromPath(String(raw.path))
  return {
    id,
    path: String(raw.path),
    enabled: raw.enabled !== false,
    writeCandidate: typeof raw.writeCandidate === 'string' && raw.writeCandidate.length > 0
      ? raw.writeCandidate
      : 'AGENTS.md',
    candidates: Array.isArray(raw.candidates)
      ? raw.candidates.filter((c): c is string => typeof c === 'string')
      : ['AGENTS.md', 'CLAUDE.md'],
    localCandidates: Array.isArray(raw.localCandidates)
      ? raw.localCandidates.filter((c): c is string => typeof c === 'string')
      : ['AGENTS.local.md', 'CLAUDE.local.md'],
    entries: Array.isArray(raw.entries) ? raw.entries.filter(isEntryMeta) : [],
    deleted: Array.isArray(raw.deleted) ? raw.deleted.filter((d): d is string => typeof d === 'string') : [],
  }
}

function normalizeMode(id: string, raw: Record<string, unknown>): ModeState {
  const personaRaw = raw.persona !== null && typeof raw.persona === 'object'
    ? raw.persona as Record<string, unknown>
    : {}
  const persona: ModePersona = {
    text: typeof personaRaw.text === 'string' ? personaRaw.text : '',
    complete: personaRaw.complete === true,
    includeRuntimeContext: personaRaw.includeRuntimeContext !== false,
  }
  return {
    id,
    managed: raw.managed !== false,
    persona,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  }
}

/** Persist the store document atomically (tmp + rename). */
export function saveStore(storeDir: string, store: PromptStore): void {
  const paths = storePaths(storeDir)
  mkdirSync(paths.root, { recursive: true })
  const tmp = `${paths.index}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  renameSync(tmp, paths.index)
}

/** Read one entry's content; missing files yield ''. */
export function readEntryContent(storeDir: string, scope: 'global' | 'project' | 'modes', id: string, projectId?: string): string {
  const file = entryPath(storeDir, scope, id, projectId)
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Write one entry's content, creating parent directories. */
export function writeEntryContent(storeDir: string, scope: 'global' | 'project' | 'modes', id: string, content: string, projectId?: string): void {
  const file = entryPath(storeDir, scope, id, projectId)
  const sep = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  mkdirSync(sep > 0 ? file.slice(0, sep) : '.', { recursive: true })
  writeFileSync(file, content, 'utf8')
}

/** Resolve the content file for one entry. */
function entryPath(storeDir: string, scope: 'global' | 'project' | 'modes', id: string, projectId?: string): string {
  if (scope === 'global') return join(storePaths(storeDir).globalDir, `${id}.md`)
  if (scope === 'modes') return join(storePaths(storeDir).modesDir, `${id}.md`)
  return join(storePaths(storeDir).projectsDir, projectId ?? '_', `${id}.md`)
}

/** Delete one entry's content file (no-op when absent). */
export function deleteEntryContent(storeDir: string, scope: 'global' | 'project' | 'modes', id: string, projectId?: string): void {
  const file = entryPath(storeDir, scope, id, projectId)
  if (existsSync(file)) rmSync(file, { force: true })
}

/** List every content file of a scope (used by export). */
export function listEntryIds(storeDir: string, scope: 'global' | 'project' | 'modes', projectId?: string): string[] {
  const dir = scope === 'global'
    ? storePaths(storeDir).globalDir
    : scope === 'modes'
      ? storePaths(storeDir).modesDir
      : join(storePaths(storeDir).projectsDir, projectId ?? '_')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
  } catch {
    return []
  }
}

/** Remove an entire project entry directory (used on unregister). */
export function deleteProjectEntries(storeDir: string, projectId: string): void {
  const dir = join(storePaths(storeDir).projectsDir, projectId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
