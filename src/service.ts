/**
 * Host-side prompt manager service.
 *
 * One instance per hosting root context; it owns the prompt store under
 * `$DSH_HOME/kmanager.prompts/` and writes the three target families the
 * official prompt plugins read:
 *
 *  - global   -> `$DSH_HOME/AGENTS.md`
 *  - project  -> `<projectRoot>/<writeCandidate>` (default AGENTS.md)
 *  - mode     -> `.agent-presets/<id>/agent.cordis.yml` persona row + preset.yml
 *
 * The service never caches the store document and never watches files: every
 * read hits the filesystem, mirroring the official plugins' philosophy. When
 * the host composition provides `ctx.agentPresets`, mode discovery prefers the
 * official roster; otherwise it scans the configured preset roots.
 * @module @deepseek-ai/dsh-prompt-kmanager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  composeFile,
  diffPreview,
  DEFAULT_CANDIDATES,
  DEFAULT_LOCAL_CANDIDATES,
  DEFAULT_WRITE_CANDIDATE,
  splitFile,
  utf8Bytes,
} from './instructions.ts'
import {
  applyPersonaPatch,
  readInstructionsBudget,
  readOnDiskPersona,
  readPresetYml,
  writePresetYml,
} from './presets.ts'
import {
  deleteEntryContent,
  deleteProjectEntries,
  DEFAULT_STORE_DIR,
  emptyStore,
  loadStore,
  newEntryId,
  projectIdFromPath,
  readEntryContent,
  saveStore,
  storePaths,
  writeEntryContent,
} from './store.ts'
import { createPromptApiRoute } from './http.ts'
import type {
  ModePersona,
  ModeSetInput,
  ModeState,
  ModeView,
  PromptEntryMeta,
  PromptManagerErrorCode,
  PromptStore,
  ProjectState,
  SkillDetail,
  SkillInvocationPatch,
  SkillLayer,
  SkillView,
  SkillWriteInput,
  StatusSnapshot,
  TargetPatch,
} from './types.ts'
import {
  isEditableLayer,
  listRootSkills,
  setInvocation,
  skillExists as skillDirExists,
  skillFilePath,
  validateSkillName,
  writeSkillFile,
  deleteSkillDir,
  type SkillRoot,
} from './skills.ts'
import { createPromptsPageRoute } from './page.ts'

/** Errors surfaced by prompt-manager operations carry a stable machine code. */
export class PromptManagerError extends Error {
  constructor(
    readonly code: PromptManagerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PromptManagerError'
  }
}

/** Client-visible failure carrying the operation's stable code. */
function fail(code: PromptManagerErrorCode, message: string): never {
  throw new PromptManagerError(code, message)
}

/** Config for the prompt manager service. */
export interface Config {
  /** Absolute path of `$DSH_HOME`; defaults to `resolveDshHome()`. */
  readonly home?: string
  /** Absolute path of `~/.agents`; defaults to `homedir()/.agents`. */
  readonly agentsHome?: string
  /** Extra preset roots scanned for modes (after the harness-home root). */
  readonly presetRoots?: readonly string[]
  /** Override the prompt-store folder; defaults to `<home>/kmanager.prompts`. */
  readonly storeDir?: string
}

/** Structural view of the official agent-presets roster when composed. */
interface AgentPresetSeam {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly path: string
  readonly broken?: string
}
interface AgentPresetsSeam {
  list(): Promise<readonly AgentPresetSeam[]>
  resolve(id?: string): Promise<AgentPresetSeam>
}

/** One target rendered by the service. */
interface ScopeEntries {
  readonly entries: readonly PromptEntryMeta[]
  readonly readContent: (id: string) => string
  /** Entry ids deleted since the target was last rendered; their blocks are dropped. */
  readonly deleted: readonly string[]
}

/** The prompt manager service. */
export class PromptKManagerService extends Service {
  /** Register the browser HTTP seat when a Host webServer exists. */
  async [Service.init](): Promise<void> {
    this.ctx.inject(['webServer'], (shared) => {
      shared.effect(
        () => shared.webServer.register(createPromptApiRoute(this)),
        'promptKManager: /api/prompt-kmanager route',
      )
      shared.effect(
        () => shared.webServer.register(createPromptsPageRoute()),
        'promptKManager: /prompts page',
      )
    })
  }

  private readonly homeDir: string
  private readonly agentsHome: string
  private readonly storeDir: string
  private readonly presetRoots: readonly string[]
  private readonly store: PromptStore

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'promptKManager')
    this.homeDir = config.home ?? resolveDshHome()
    this.agentsHome = config.agentsHome ?? join(homedir(), '.agents')
    this.storeDir = config.storeDir ?? join(this.homeDir, DEFAULT_STORE_DIR)
    this.presetRoots = [...(config.presetRoots ?? []), join(this.homeDir, '.agent-presets')]
    try {
      mkdirSync(this.storeDir, { recursive: true })
      mkdirSync(storePaths(this.storeDir).globalDir, { recursive: true })
      mkdirSync(storePaths(this.storeDir).modesDir, { recursive: true })
    } catch (error) {
      throw new PromptManagerError('STORE_WRITE_FAILED', `cannot create prompt store at ${this.storeDir}: ${String(error)}`)
    }
    this.store = loadStore(this.storeDir)
  }

  /** True when the host composition provides the official preset roster. */
  private hasAgentPresets(): boolean {
    return ctxGetAgentPresets(this.ctx) !== undefined
  }

  /**
   * Resolve a preset directory for a mode id (official roster first).
   * @param writable - when writing, shipped (system) presets are rejected:
   * the official model treats them as read-only deployment artifacts, only
   * user presets (or the harness-home scan) are manageable.
   */
  private async resolveModeDir(id: string, writable = false): Promise<string> {
    const agentPresets = ctxGetAgentPresets(this.ctx)
    if (agentPresets) {
      try {
        const preset = await agentPresets.resolve(id)
        if (writable && preset.trust === 'system') {
          throw new PromptManagerError('MODE_READONLY', `mode preset is system-readonly; duplicate it as a user preset to manage: ${id}`)
        }
        const dir = dirname(preset.path)
        if (existsSync(join(dir, 'agent.cordis.yml'))) return dir
      } catch (error) {
        // Fall through to the scan; the roster error is less actionable here.
        if (error instanceof PromptManagerError) throw error
      }
    }
    for (const root of this.presetRoots) {
      const dir = join(root, id)
      if (existsSync(join(dir, 'agent.cordis.yml'))) return dir
    }
    throw new PromptManagerError('MODE_NOT_FOUND', `mode not found: ${id}`)
  }

  /** List every mode (official roster view when available). */
  async listModes(): Promise<ModeView[]> {
    const agentPresets = ctxGetAgentPresets(this.ctx)
    const views: ModeView[] = []
    if (agentPresets) {
      const presets = await agentPresets.list()
      for (const preset of presets) {
        const dir = dirname(preset.path)
        const meta = readPresetYml(dir)
        const managed = this.store.modes[preset.id]?.managed === true
        const view: ModeView = {
          id: preset.id,
          name: meta.name ?? preset.id,
          description: meta.description ?? '',
          trust: preset.trust,
          managed,
          budgetBytes: readInstructionsBudget(dir),
          onDisk: readOnDiskPersona(dir),
        }
        if (preset.broken) view.broken = preset.broken
        views.push(view)
      }
      return views
    }
    const seen = new Set<string>()
    for (const root of this.presetRoots) {
      if (!existsSync(root)) continue
      for (const entry of listPresetDirs(root)) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        const meta = readPresetYml(entry.dir)
        const managed = this.store.modes[entry.id]?.managed === true
        const view: ModeView = {
          id: entry.id,
          name: meta.name ?? entry.id,
          description: meta.description ?? '',
          trust: 'user',
          managed,
          budgetBytes: readInstructionsBudget(entry.dir),
          onDisk: readOnDiskPersona(entry.dir),
        }
        views.push(view)
      }
    }
    return views
  }

  /** One mode with its managed persona plus on-disk facts. */
  async readMode(id: string): Promise<ModeView & { readonly managedPersona: ModePersona | null }> {
    const dir = await this.resolveModeDir(id)
    const meta = readPresetYml(dir)
    const onDisk = readOnDiskPersona(dir)
    const state = this.store.modes[id]
    const view: ModeView = {
      id,
      name: meta.name ?? id,
      description: meta.description ?? '',
      trust: 'user',
      managed: state?.managed === true,
      budgetBytes: readInstructionsBudget(dir),
      onDisk,
    }
    const managedPersona = state?.managed === true
      ? { ...state.persona }
      : null
    return { ...view, managedPersona }
  }

  /** Update the managed persona / metadata of a mode in the store. */
  setMode(input: ModeSetInput): ModeState {
    const id = input.id
    const state = this.store.modes[id] ?? { id, managed: false, persona: { text: '', complete: false, includeRuntimeContext: true } }
    if (input.persona) {
      state.managed = true
      state.persona = { ...input.persona }
      writeEntryContent(this.storeDir, 'modes', id, input.persona.text)
    }
    if (input.name !== undefined) state.name = input.name
    if (input.description !== undefined) state.description = input.description
    this.store.modes[id] = state
    saveStore(this.storeDir, this.store)
    return state
  }

  /** Write the managed persona into the mode's composition file. */
  async applyMode(id: string, dryRun: boolean): Promise<TargetPatch> {
    const state = this.store.modes[id]
    if (!state || state.managed !== true) {
      throw new PromptManagerError('MODE_UNMANAGED', `mode is not managed: ${id}`)
    }
    const dir = await this.resolveModeDir(id, true)
    const file = join(dir, 'agent.cordis.yml')
    const source = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const patch: Partial<ModePersona> = {
      text: state.persona.text,
      complete: state.persona.complete,
      includeRuntimeContext: state.persona.includeRuntimeContext,
    }
    const applied = applyPersonaPatch(source, patch)
    const beforeBytes = utf8Bytes(source)
    const afterBytes = utf8Bytes(applied.text)
    const changed = applied.text !== source || (state.name !== undefined || state.description !== undefined)
    const patchResult: TargetPatch = {
      kind: 'mode',
      id,
      path: file,
      beforeBytes,
      afterBytes,
      changed,
      preview: changed ? diffPreview(source, applied.text) : '(unchanged)',
    }
    if (changed && !dryRun) {
      writeFileSync(file, applied.text, 'utf8')
      if (state.name !== undefined || state.description !== undefined) {
        writePresetYml(dir, {
          ...(state.name !== undefined ? { name: state.name } : {}),
          ...(state.description !== undefined ? { description: state.description } : {}),
        })
      }
      patchResult.written = true
    }
    return patchResult
  }

  // ---- global scope -------------------------------------------------------

  listGlobalEntries(): readonly PromptEntryMeta[] {
    return this.store.global.entries
  }

  private readGlobalEntry(id: string): string {
    return readEntryContent(this.storeDir, 'global', id)
  }

  private scopeForGlobal(): ScopeEntries {
    return {
      entries: this.store.global.entries,
      readContent: (id) => readEntryContent(this.storeDir, 'global', id),
      deleted: this.store.global.deleted,
    }
  }

  addGlobalEntry(title: string, content: string): PromptEntryMeta {
    if (title.trim().length === 0) fail('PROMPT_INVALID', 'title must be a non-empty string')
    const entry: PromptEntryMeta = { id: newEntryId('g'), title: title.trim(), enabled: true }
    this.store.global.entries.push(entry)
    writeEntryContent(this.storeDir, 'global', entry.id, content)
    saveStore(this.storeDir, this.store)
    return entry
  }

  updateGlobalEntry(id: string, patch: { readonly title?: string; readonly content?: string; readonly enabled?: boolean }): PromptEntryMeta {
    const entry = this.store.global.entries.find((e) => e.id === id)
    if (!entry) fail('PROMPT_NOT_FOUND', `global entry not found: ${id}`)
    if (patch.title !== undefined) entry.title = patch.title
    if (patch.enabled !== undefined) entry.enabled = patch.enabled
    if (patch.content !== undefined) writeEntryContent(this.storeDir, 'global', id, patch.content)
    saveStore(this.storeDir, this.store)
    return { ...entry }
  }

  removeGlobalEntry(id: string): void {
    const before = this.store.global.entries.length
    this.store.global.entries = this.store.global.entries.filter((e) => e.id !== id)
    if (this.store.global.entries.length === before) fail('PROMPT_NOT_FOUND', `global entry not found: ${id}`)
    deleteEntryContent(this.storeDir, 'global', id)
    this.store.global.deleted = pushUnique(this.store.global.deleted, id)
    saveStore(this.storeDir, this.store)
  }

  reorderGlobalEntries(ids: readonly string[]): readonly PromptEntryMeta[] {
    const byId = new Map(this.store.global.entries.map((e) => [e.id, e]))
    const next: PromptEntryMeta[] = []
    for (const id of ids) {
      const entry = byId.get(id)
      if (entry) next.push(entry)
    }
    for (const entry of this.store.global.entries) {
      if (!next.includes(entry)) next.push(entry)
    }
    this.store.global.entries = next
    saveStore(this.storeDir, this.store)
    return next
  }

  renderGlobal(): { readonly path: string; readonly text: string; readonly beforeBytes: number; readonly afterBytes: number; readonly changed: boolean } {
    const target = join(this.homeDir, 'AGENTS.md')
    return this.renderScope(target, this.scopeForGlobal())
  }

  applyGlobal(dryRun: boolean): TargetPatch {
    return this.applyScope('global', undefined, join(this.homeDir, 'AGENTS.md'), this.scopeForGlobal(), dryRun)
  }

  /** Adopt the unmanaged text of `$DSH_HOME/AGENTS.md` as a managed entry. */
  importGlobal(title?: string): PromptEntryMeta {
    const target = join(this.homeDir, 'AGENTS.md')
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
    const content = unmanagedText(existing, new Set([...this.store.global.entries.map((e) => e.id), ...this.store.global.deleted]))
    if (content.trim().length === 0) fail('PROMPT_INVALID', 'nothing to import: the file has no unmanaged text')
    const heading = content.match(/^#+\s+(.+)$/m)?.[1]?.trim()
    return this.addGlobalEntry(title ?? heading ?? 'imported', content.trim() + '\n')
  }

  // ---- project scope ------------------------------------------------------

  listProjects(): readonly ProjectState[] {
    return this.store.projects
  }

  registerProject(path: string, writeCandidate?: string, id?: string): ProjectState {
    if (path.trim().length === 0) fail('PROJECT_INVALID', 'path must be a non-empty string')
    if (!existsSync(path) || !statSync(path).isDirectory()) fail('PROJECT_INVALID', `project path is not a directory: ${path}`)
    const projectId = id ?? projectIdFromPath(path)
    if (this.store.projects.some((p) => p.id === projectId)) {
      fail('PROJECT_INVALID', `a project with id ${projectId} is already registered`)
    }
    const project: ProjectState = {
      id: projectId,
      path,
      enabled: true,
      writeCandidate: writeCandidate && writeCandidate.length > 0 ? writeCandidate : DEFAULT_WRITE_CANDIDATE,
      candidates: DEFAULT_CANDIDATES,
      localCandidates: DEFAULT_LOCAL_CANDIDATES,
      entries: [],
      deleted: [],
    }
    this.store.projects.push(project)
    saveStore(this.storeDir, this.store)
    return { ...project }
  }

  unregisterProject(id: string): void {
    const before = this.store.projects.length
    this.store.projects = this.store.projects.filter((p) => p.id !== id)
    if (this.store.projects.length === before) fail('PROJECT_NOT_FOUND', `project not found: ${id}`)
    deleteProjectEntries(this.storeDir, id)
    saveStore(this.storeDir, this.store)
  }

  updateProject(id: string, patch: { readonly enabled?: boolean; readonly writeCandidate?: string }): ProjectState {
    const project = this.store.projects.find((p) => p.id === id)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${id}`)
    if (patch.enabled !== undefined) project.enabled = patch.enabled
    if (patch.writeCandidate !== undefined && patch.writeCandidate.length > 0) {
      project.writeCandidate = patch.writeCandidate
    }
    saveStore(this.storeDir, this.store)
    return { ...project }
  }

  private scopeForProject(project: ProjectState): ScopeEntries {
    return {
      entries: project.entries,
      readContent: (entryId) => readEntryContent(this.storeDir, 'project', entryId, project.id),
      deleted: project.deleted,
    }
  }

  addProjectEntry(projectId: string, title: string, content: string): PromptEntryMeta {
    const project = this.store.projects.find((p) => p.id === projectId)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${projectId}`)
    if (title.trim().length === 0) fail('PROMPT_INVALID', 'title must be a non-empty string')
    const entry: PromptEntryMeta = { id: newEntryId('j'), title: title.trim(), enabled: true }
    project.entries.push(entry)
    writeEntryContent(this.storeDir, 'project', entry.id, content, project.id)
    saveStore(this.storeDir, this.store)
    return entry
  }

  updateProjectEntry(projectId: string, id: string, patch: { readonly title?: string; readonly content?: string; readonly enabled?: boolean }): PromptEntryMeta {
    const project = this.store.projects.find((p) => p.id === projectId)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${projectId}`)
    const entry = project.entries.find((e) => e.id === id)
    if (!entry) fail('PROMPT_NOT_FOUND', `project entry not found: ${id}`)
    if (patch.title !== undefined) entry.title = patch.title
    if (patch.enabled !== undefined) entry.enabled = patch.enabled
    if (patch.content !== undefined) writeEntryContent(this.storeDir, 'project', id, patch.content, project.id)
    saveStore(this.storeDir, this.store)
    return { ...entry }
  }

  removeProjectEntry(projectId: string, id: string): void {
    const project = this.store.projects.find((p) => p.id === projectId)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${projectId}`)
    const before = project.entries.length
    project.entries = project.entries.filter((e) => e.id !== id)
    if (project.entries.length === before) fail('PROMPT_NOT_FOUND', `project entry not found: ${id}`)
    deleteEntryContent(this.storeDir, 'project', id, project.id)
    project.deleted = pushUnique(project.deleted, id)
    saveStore(this.storeDir, this.store)
  }

  reorderProjectEntries(projectId: string, ids: readonly string[]): readonly PromptEntryMeta[] {
    const project = this.store.projects.find((p) => p.id === projectId)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${projectId}`)
    const byId = new Map(project.entries.map((e) => [e.id, e]))
    const next: PromptEntryMeta[] = []
    for (const id of ids) {
      const entry = byId.get(id)
      if (entry) next.push(entry)
    }
    for (const entry of project.entries) {
      if (!next.includes(entry)) next.push(entry)
    }
    project.entries = next
    saveStore(this.storeDir, this.store)
    return next
  }

  renderProject(id: string): { readonly path: string; readonly text: string; readonly beforeBytes: number; readonly afterBytes: number; readonly changed: boolean } {
    const project = this.store.projects.find((p) => p.id === id)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${id}`)
    return this.renderScope(join(project.path, project.writeCandidate), this.scopeForProject(project))
  }

  applyProject(id: string, dryRun: boolean): TargetPatch {
    const project = this.store.projects.find((p) => p.id === id)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${id}`)
    return this.applyScope('project', id, join(project.path, project.writeCandidate), this.scopeForProject(project), dryRun)
  }

  /** Adopt the unmanaged text of a project's write candidate as an entry. */
  importProject(id: string, title?: string): PromptEntryMeta {
    const project = this.store.projects.find((p) => p.id === id)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${id}`)
    const target = join(project.path, project.writeCandidate)
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
    const content = unmanagedText(existing, new Set([...project.entries.map((e) => e.id), ...project.deleted]))
    if (content.trim().length === 0) fail('PROMPT_INVALID', 'nothing to import: the file has no unmanaged text')
    const heading = content.match(/^#+\s+(.+)$/m)?.[1]?.trim()
    return this.addProjectEntry(id, title ?? heading ?? 'imported', content.trim() + '\n')
  }

  // ---- skill scope --------------------------------------------------------

  /** The writable and read-only skill roots, mirroring `dsh-skill-filesystem`. */
  private skillRoots(): SkillRoot[] {
    const roots: SkillRoot[] = []
    for (const project of this.store.projects) {
      roots.push({ path: join(project.path, '.dsh/skills'), layer: 'project-dsh', pid: project.id })
      roots.push({ path: join(project.path, '.agents/skills'), layer: 'project-agents', pid: project.id })
    }
    roots.push({ path: join(this.homeDir, 'skills'), layer: 'user-dsh' })
    roots.push({ path: join(this.agentsHome, 'skills'), layer: 'user-agents' })
    const bundled = process.env.DSH_BUNDLED_SKILL_DIR
    if (bundled !== undefined && bundled.length > 0) {
      roots.push({ path: bundled, layer: 'bundled' })
    }
    return roots
  }

  /** List every discovered skill across writable and official roots. */
  listSkills(): SkillView[] {
    const out: SkillView[] = []
    for (const root of this.skillRoots()) {
      for (const skill of listRootSkills(root)) out.push(skill)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Read one skill with its full markdown body. */
  readSkill(name: string, layer?: SkillLayer): SkillDetail {
    const found = this.listSkills().find((s) => s.name === name && (layer === undefined || s.layer === layer))
    if (found === undefined) fail('SKILL_NOT_FOUND', `skill not found: ${name}`)
    return found as SkillDetail
  }

  /** Resolve the writable root directory for a manage layer. */
  private skillWriteRoot(layer: 'project-dsh' | 'user-dsh', projectId?: string): string {
    if (layer === 'user-dsh') return join(this.homeDir, 'skills')
    const project = this.store.projects.find((p) => p.id === projectId)
    if (!project) fail('PROJECT_NOT_FOUND', `project not found: ${projectId}`)
    return join(project.path, '.dsh/skills')
  }

  /** Create a managed skill as `<name>/SKILL.md` under the layer's root. */
  createSkill(input: SkillWriteInput): SkillView {
    validateSkillName(input.name)
    if (input.description.trim().length === 0) fail('SKILL_INVALID', 'description must be a non-empty string')
    const root = this.skillWriteRoot(input.layer, input.projectId)
    if (skillDirExists(root, input.name)) fail('SKILL_INVALID', `skill already exists: ${input.name}`)
    const path = writeSkillFile(root, input)
    return this.listSkills().find((s) => s.path === path) ?? skillViewOf(input, path, input.layer)
  }

  /** Update an existing managed skill. */
  updateSkill(input: SkillWriteInput): SkillView {
    validateSkillName(input.name)
    if (input.description.trim().length === 0) fail('SKILL_INVALID', 'description must be a non-empty string')
    const root = this.skillWriteRoot(input.layer, input.projectId)
    if (!skillDirExists(root, input.name)) fail('SKILL_NOT_FOUND', `skill not found: ${input.name}`)
    const path = writeSkillFile(root, input)
    return this.listSkills().find((s) => s.path === path) ?? skillViewOf(input, path, input.layer)
  }

  /** Remove a managed skill directory. */
  removeSkill(layer: 'project-dsh' | 'user-dsh', name: string, projectId?: string): void {
    const root = this.skillWriteRoot(layer, projectId)
    if (!skillDirExists(root, name)) fail('SKILL_NOT_FOUND', `skill not found: ${name}`)
    deleteSkillDir(root, name)
  }

  /** Patch a manageable skill's invocation policy (`disable-model-invocation` / `user-invocable`). */
  setSkillInvocation(layer: 'project-dsh' | 'user-dsh', name: string, patch: SkillInvocationPatch, projectId?: string): SkillView {
    if (!isEditableLayer(layer)) fail('SKILL_READONLY', `skill is read-only: ${name}`)
    const root = this.skillWriteRoot(layer, projectId)
    const file = skillFilePath(root, name)
    if (!existsSync(file)) fail('SKILL_NOT_FOUND', `skill not found: ${name}`)
    const raw = readFileSync(file, 'utf8')
    writeFileSync(file, setInvocation(raw, patch), 'utf8')
    const view = this.listSkills().find((s) => s.path === file)
    if (view === undefined) fail('SKILL_NOT_FOUND', `skill not re-listed: ${name}`)
    return view
  }

  // ---- shared rendering ---------------------------------------------------

  private renderScope(
    target: string,
    scope: ScopeEntries,
  ): { readonly path: string; readonly text: string; readonly beforeBytes: number; readonly afterBytes: number; readonly changed: boolean } {
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
    const segments = splitFile(existing)
    const activeById = new Map<string, { readonly title: string; readonly content: string }>()
    const knownIds = new Set<string>()
    for (const entry of scope.entries) {
      knownIds.add(entry.id)
      if (entry.enabled) {
        activeById.set(entry.id, { title: entry.title, content: scope.readContent(entry.id) })
      }
    }
    for (const id of scope.deleted) knownIds.add(id)
    const text = composeFile(segments, activeById, knownIds)
    return {
      path: target,
      text,
      beforeBytes: utf8Bytes(existing),
      afterBytes: utf8Bytes(text),
      changed: text !== existing,
    }
  }

  private applyScope(kind: 'global' | 'project', id: string | undefined, target: string, scope: ScopeEntries, dryRun: boolean): TargetPatch {
    const rendered = this.renderScope(target, scope)
    const patch: TargetPatch = {
      kind,
      ...(id !== undefined ? { id } : {}),
      path: rendered.path,
      beforeBytes: rendered.beforeBytes,
      afterBytes: rendered.afterBytes,
      changed: rendered.changed,
      preview: rendered.changed ? diffPreview(existingText(target), rendered.text) : '(unchanged)',
    }
    if (rendered.changed && !dryRun) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rendered.text, 'utf8')
      patch.written = true
    }
    return patch
  }

  // ---- one-shot apply everything ------------------------------------------

  /** Render and (unless dry-run) write every managed scope. */
  async applyAll(dryRun: boolean): Promise<TargetPatch[]> {
    const patches: TargetPatch[] = []
    if (this.store.global.entries.length > 0) {
      patches.push(this.applyGlobal(dryRun))
    }
    for (const project of this.store.projects) {
      if (!project.enabled || project.entries.length === 0) continue
      patches.push(this.applyProject(project.id, dryRun))
    }
    for (const id of Object.keys(this.store.modes)) {
      const state = this.store.modes[id]
      if (!state || state.managed !== true) continue
      patches.push(await this.applyMode(id, dryRun))
    }
    return patches
  }

  // ---- overview & backup --------------------------------------------------

  status(): StatusSnapshot {
    const globalTarget = join(this.homeDir, 'AGENTS.md')
    const rendered = this.renderGlobal()
    const projects = this.store.projects.map((project) => {
      const target = join(project.path, project.writeCandidate)
      const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
      return {
        ...project,
        targetExists: existsSync(target),
        targetBytes: utf8Bytes(existing),
        renderedBytes: this.renderScope(target, this.scopeForProject(project)).afterBytes,
      }
    })
    return {
      storeDir: this.storeDir,
      seams: { agentPresets: this.hasAgentPresets() },
      global: {
        entries: this.store.global.entries,
        targetPath: globalTarget,
        targetExists: existsSync(globalTarget),
        targetBytes: utf8Bytes(existsSync(globalTarget) ? readFileSync(globalTarget, 'utf8') : ''),
        renderedBytes: rendered.afterBytes,
        unmanagedText: existsSync(globalTarget) ? unmanagedText(readFileSync(globalTarget, 'utf8'), new Set([...this.store.global.entries.map((e) => e.id), ...this.store.global.deleted])) : '',
      },
      projects,
      modes: [],
    }
  }

  /** Export the whole store as a portable JSON document (with contents). */
  exportStore(): string {
    const payload: Record<string, unknown> = {
      version: 1,
      global: { entries: this.store.global.entries.map((e) => ({ ...e, content: readEntryContent(this.storeDir, 'global', e.id) })), deleted: this.store.global.deleted },
      projects: this.store.projects.map((p) => ({
        ...p,
        entries: p.entries.map((e) => ({ ...e, content: readEntryContent(this.storeDir, 'project', e.id, p.id) })),
      })),
      modes: Object.fromEntries(
        Object.entries(this.store.modes).map(([id, m]) => [id, { ...m, persona: { ...m.persona } }]),
      ),
    }
    return JSON.stringify(payload, null, 2)
  }

  /** Restore the store from an export document (replaces current state). */
  restoreStore(json: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      fail('STORE_INVALID', 'export JSON is malformed')
    }
    if (parsed === null || typeof parsed !== 'object') fail('STORE_INVALID', 'export JSON is malformed')
    const raw = parsed as Record<string, unknown>
    const next = emptyStore()
    if (Array.isArray(raw.global)) {
      // Legacy export: `global` was a bare entries array.
      for (const item of raw.global) {
        if (item === null || typeof item !== 'object') continue
        const e = item as Record<string, unknown>
        if (typeof e.id !== 'string' || typeof e.title !== 'string') continue
        next.global.entries.push({ id: e.id, title: e.title, enabled: e.enabled !== false })
        writeEntryContent(this.storeDir, 'global', e.id, typeof e.content === 'string' ? e.content : '')
      }
    } else if (raw.global !== null && typeof raw.global === 'object') {
      const g = raw.global as Record<string, unknown>
      if (Array.isArray(g.entries)) {
        for (const item of g.entries) {
          if (item === null || typeof item !== 'object') continue
          const e = item as Record<string, unknown>
          if (typeof e.id !== 'string' || typeof e.title !== 'string') continue
          next.global.entries.push({ id: e.id, title: e.title, enabled: e.enabled !== false })
          writeEntryContent(this.storeDir, 'global', e.id, typeof e.content === 'string' ? e.content : '')
        }
      }
      if (Array.isArray(g.deleted)) next.global.deleted = g.deleted.filter((d): d is string => typeof d === 'string')
    }
    if (Array.isArray(raw.projects)) {
      for (const item of raw.projects) {
        if (item === null || typeof item !== 'object') continue
        const p = item as Record<string, unknown>
        if (typeof p.path !== 'string' || p.path.length === 0) continue
        const project: ProjectState = {
          id: typeof p.id === 'string' && p.id.length > 0 ? p.id : projectIdFromPath(String(p.path)),
          path: String(p.path),
          enabled: p.enabled !== false,
          writeCandidate: typeof p.writeCandidate === 'string' && p.writeCandidate.length > 0 ? String(p.writeCandidate) : DEFAULT_WRITE_CANDIDATE,
          candidates: DEFAULT_CANDIDATES,
          localCandidates: DEFAULT_LOCAL_CANDIDATES,
          entries: [],
          deleted: Array.isArray(p.deleted) ? p.deleted.filter((d): d is string => typeof d === 'string') : [],
        }
        if (Array.isArray(p.entries)) {
          for (const item2 of p.entries) {
            if (item2 === null || typeof item2 !== 'object') continue
            const e = item2 as Record<string, unknown>
            if (typeof e.id !== 'string' || typeof e.title !== 'string') continue
            project.entries.push({ id: e.id, title: e.title, enabled: e.enabled !== false })
            writeEntryContent(this.storeDir, 'project', e.id, typeof e.content === 'string' ? e.content : '', project.id)
          }
        }
        next.projects.push(project)
      }
    }
    if (raw.modes !== null && typeof raw.modes === 'object') {
      for (const [id, m] of Object.entries(raw.modes as Record<string, unknown>)) {
        if (m === null || typeof m !== 'object') continue
        const mode = m as Record<string, unknown>
        const personaRaw = mode.persona !== null && typeof mode.persona === 'object'
          ? mode.persona as Record<string, unknown>
          : {}
        const persona: ModePersona = {
          text: typeof personaRaw.text === 'string' ? personaRaw.text : '',
          complete: personaRaw.complete === true,
          includeRuntimeContext: personaRaw.includeRuntimeContext !== false,
        }
        const state: ModeState = {
          id,
          managed: mode.managed !== false,
          persona,
        }
        if (typeof mode.name === 'string') state.name = mode.name
        if (typeof mode.description === 'string') state.description = mode.description
        next.modes[id] = state
        writeEntryContent(this.storeDir, 'modes', id, persona.text)
      }
    }
    this.store.global = next.global
    this.store.projects = next.projects
    this.store.modes = next.modes
    saveStore(this.storeDir, this.store)
  }
}

/** Read the current text of a target file ('' when absent). */
function existingText(target: string): string {
  return existsSync(target) ? readFileSync(target, 'utf8') : ''
}

/**
 * Read the official `agentPresets` roster without the inject requirement:
 * property access throws when the service is absent, `ctx.reflect.get()` does not.
 * @returns the roster seam, or `undefined` when the host did not provide it.
 */
function ctxGetAgentPresets(ctx: Context): AgentPresetsSeam | undefined {
  return ctx.reflect.get('agentPresets')
}

/** Append an id to a tombstone list unless already present. */
function pushUnique(list: readonly string[], id: string): string[] {
  return list.includes(id) ? [...list] : [...list, id]
}

/** Build a SkillView from a write input (post-write fallback). */
function skillViewOf(input: SkillWriteInput, path: string, layer: SkillLayer): SkillView {
  return {
    name: input.name,
    description: input.description,
    ...(input.whenToUse !== undefined && input.whenToUse.length > 0 ? { whenToUse: input.whenToUse } : {}),
    modelInvocable: true,
    userInvocable: true,
    layer,
    path,
    editable: true,
  }
}

/** Unmanaged text of a file: foreign segments plus blocks whose tag is not covered by `ours`. */
function unmanagedText(text: string, ours: ReadonlySet<string> = new Set()): string {
  const segments = splitFile(text)
  const parts = [...segments.foreign]
  for (const block of segments.blocks) {
    if (ours.has(block.scopeTag)) continue
    parts.push(block.raw)
  }
  return parts.join('\n\n')
}

/** List preset directories (with an id) inside a root. */
function listPresetDirs(root: string): { readonly id: string; readonly dir: string }[] {
  const out: { readonly id: string; readonly dir: string }[] = []
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return out
  }
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue
    const dir = join(root, name)
    if (existsSync(join(dir, 'agent.cordis.yml'))) out.push({ id: name, dir })
  }
  return out
}
