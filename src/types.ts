/**
 * Shared view types for `@deepseek-ai/dsh-prompt-kmanager`.
 *
 * The plugin manages three prompt scopes that exactly mirror the files the
 * official prompt plugins read:
 *
 *  - **global**  -> `$DSH_HOME/AGENTS.md`      (`dsh-agent-instructions` user-global scope)
 *  - **project** -> `<projectRoot>/AGENTS.md`  (`dsh-agent-instructions` project scopes)
 *  - **mode**    -> `.agent-presets/<id>/agent.cordis.yml` persona row (`dsh-persona`)
 *
 * All persisted state lives under `$DSH_HOME/kmanager.prompts/` so removing the
 * folder restores the harness to a pristine state.
 * @module @deepseek-ai/dsh-prompt-kmanager/types
 */

/** Stable error codes surfaced to the UI through the HTTP seam. */
export type PromptManagerErrorCode =
  | 'PROMPT_NOT_FOUND'
  | 'PROMPT_INVALID'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_INVALID'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_INVALID'
  | 'SKILL_READONLY'
  | 'MODE_NOT_FOUND'
  | 'MODE_UNMANAGED'
  | 'MODE_READONLY'
  | 'MODE_WRITE_FAILED'
  | 'STORE_READ_FAILED'
  | 'STORE_WRITE_FAILED'
  | 'STORE_INVALID'
  | 'TARGET_READ_FAILED'
  | 'TARGET_WRITE_FAILED'
  | 'UNSUPPORTED_SOURCE'
  | 'REGISTRATION_FAILED'

/** One managed prompt entry inside a scope. Content lives in the store. */
export interface PromptEntryMeta {
  /** Stable entry id (also used as the marker scope tag in target files). */
  readonly id: string
  /** Display title rendered as `## <title>` above the content. */
  title: string
  /** Disabled entries keep their content but are not rendered. */
  enabled: boolean
}

/** Global scope: `$DSH_HOME/AGENTS.md`. */
export interface GlobalState {
  entries: PromptEntryMeta[]
  /** Entry ids deleted since a target was last rendered; their blocks are dropped on next apply. */
  deleted: string[]
}

/** Project scope: one registered project directory. */
export interface ProjectState {
  readonly id: string
  /** Absolute path of the project root. */
  path: string
  enabled: boolean
  /**
   * Candidate file the manager writes into the project root. Defaults to
   * `AGENTS.md`; the official plugin reads every existing candidate.
   */
  writeCandidate: string
  /** Informational: base candidates the official plugin scans in this dir. */
  readonly candidates: readonly string[]
  /** Informational: local-overlay candidates (`*.local.md`). */
  readonly localCandidates: readonly string[]
  entries: PromptEntryMeta[]
  /** Entry ids deleted since a target was last rendered; their blocks are dropped on next apply. */
  deleted: string[]
}

/** Managed persona of one mode (agent preset). */
export interface ModePersona {
  text: string
  /** `complete: true` makes the persona the sole system-prompt section. */
  complete: boolean
  /** `includeRuntimeContext: false` suppresses dynamic runtime-context snapshots. */
  includeRuntimeContext: boolean
}

/** Mode scope: one `.agent-presets/<id>` directory. */
export interface ModeState {
  readonly id: string
  /** True once this mode is managed (a persona is stored under modes/). */
  managed: boolean
  persona: ModePersona
  /** Managed `preset.yml` display name override. */
  name?: string
  /** Managed `preset.yml` description override. */
  description?: string
}

/** The persisted prompt-store document (`kmanager.prompts/index.json`). */
export interface PromptStore {
  readonly version: 1
  global: GlobalState
  projects: ProjectState[]
  /** Keyed by mode id. */
  modes: Record<string, ModeState>
}

/** One apply target with a preview of what would change. */
export interface TargetPatch {
  readonly kind: 'global' | 'project' | 'mode'
  readonly id?: string
  readonly path: string
  readonly beforeBytes: number
  readonly afterBytes: number
  readonly changed: boolean
  /** Unified-ish preview: previous managed rendering vs new one. */
  readonly preview: string
  /** Dry-run mode only ever returns this patch without writing. */
  written?: boolean
}

/** Which skill root a skill came from; writable roots are managed, others listed. */
export type SkillLayer = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents' | 'bundled'

/** Invocation policy of a skill (defaults to both invocable). */
export interface SkillInvocationState {
  /** Whether the model may invoke this skill (`disable-model-invocation` inverted). */
  readonly modelInvocable: boolean
  /** Whether the user may invoke this skill (`user-invocable`, default true). */
  readonly userInvocable: boolean
}

/** One discovered SKILL.md, mirroring the official `dsh-skill-filesystem` roots. */
export interface SkillView extends SkillInvocationState {
  /** Kebab-case skill name (directory or flat file name). */
  readonly name: string
  readonly description: string
  /** `whenToUse` routing guidance; absent when the SKILL.md omits it. */
  readonly whenToUse?: string
  readonly layer: SkillLayer
  /** Absolute path of the SKILL.md file. */
  readonly path: string
  /** Project id when the skill lives in a project layer; undefined for user/bundled. */
  readonly pid?: string
  /** Writable roots (`project-dsh` / `user-dsh`) are editable; the rest are official. */
  readonly editable: boolean
}

/** A skill with its full markdown body loaded. */
export interface SkillDetail extends SkillView {
  readonly content: string
}

/** Input for creating or updating a manageable skill. */
export interface SkillWriteInput {
  readonly layer: 'project-dsh' | 'user-dsh'
  /** Project id when layer is `project-dsh`. */
  readonly projectId?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
}

/** Partial invocation-policy patch applied to a manageable skill. */
export interface SkillInvocationPatch {
  readonly modelInvocable?: boolean
  readonly userInvocable?: boolean
}

/** The mode's on-disk persona extracted from its composition file. */
export interface OnDiskPersona {
  readonly text: string | null
  readonly complete: boolean | null
  readonly includeRuntimeContext: boolean | null
  /** Composition file path (when the mode is a real directory). */
  readonly path: string | null
}

/** A mode as shown in the UI (official roster view + managed state). */
export interface ModeView {
  readonly id: string
  /** `preset.yml` display name when present, else the id. */
  readonly name: string
  readonly description: string
  readonly trust: 'system' | 'user'
  /** Broken presets carry a human-readable reason. */
  broken?: string
  readonly managed: boolean
  /** Per-mode agent-instructions `maxBytes` budget read from its composition. */
  readonly budgetBytes: number | null
  readonly onDisk: OnDiskPersona
}

/** Overview snapshot served by GET /api/prompt-kmanager/status. */
export interface StatusSnapshot {
  readonly storeDir: string
  readonly seams: {
    /** Whether the host composition provides `ctx.agentPresets`. */
    readonly agentPresets: boolean
  }
  readonly global: {
    readonly entries: readonly PromptEntryMeta[]
    readonly targetPath: string
    readonly targetExists: boolean
    readonly targetBytes: number
    readonly renderedBytes: number
    /** Unmanaged text currently in the target file (importable). */
    readonly unmanagedText: string
  }
  readonly projects: readonly (ProjectState & {
    readonly targetExists: boolean
    readonly targetBytes: number
    readonly renderedBytes: number
  })[]
  readonly modes: readonly ModeView[]
}

/** One rendered line change for the mode persona preview. */
export interface LineChange {
  readonly line: number
  readonly before: string
  readonly after: string
}

/** Body of POST /api/prompt-kmanager/mode-set. */
export interface ModeSetInput {
  id: string
  persona?: ModePersona
  name?: string
  description?: string
}
