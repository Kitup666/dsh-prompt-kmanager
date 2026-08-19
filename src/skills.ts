/**
 * SKILL.md discovery and I/O for `@deepseek-ai/dsh-prompt-kmanager`.
 *
 * Mirrors the official `dsh-skill-filesystem` provider's local roots: skill
 * directories or flat `<name>.md` files under each root, parsed for YAML
 * frontmatter (`name` + `description` required). Writable roots are the
 * `project-dsh` (`<project>/.dsh/skills`) and `user-dsh` (`$DSH_HOME/skills`)
 * layers; the project/user `.agents/skills` and bundled roots are listed
 * read-only so the page can show the official skills the user cannot edit.
 * @module @deepseek-ai/dsh-prompt-kmanager/skills
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillDetail, SkillLayer, SkillView } from './types.ts'

/** Kebab-case skill name grammar, matching the official registry. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Name of the skill body file inside a directory-bundle skill. */
const SKILL_FILE = 'SKILL.md'

/** Editable layers; the rest are official and read-only. */
const EDITABLE_LAYERS: readonly SkillLayer[] = ['project-dsh', 'user-dsh']

/** Whether a layer is user-manageable. */
export function isEditableLayer(layer: SkillLayer): boolean {
  return EDITABLE_LAYERS.includes(layer)
}

/** A managed skill root: a filesystem directory plus its layer semantics. */
export interface SkillRoot {
  readonly path: string
  readonly layer: SkillLayer
  /** Project id when the root belongs to a registered project. */
  readonly pid?: string
}

/** Validate a skill name against the official kebab-case grammar. */
export function validateSkillName(name: string): void {
  if (!SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name "${name}"; use lowercase kebab-case (a-z0-9 and single hyphens)`)
  }
}

/** Invocation policy parsed from a SKILL.md. */
export interface ParsedInvocation {
  /** Whether the model may invoke this skill (`disable-model-invocation` inverted). */
  readonly modelInvocable: boolean
  /** Whether the user may invoke this skill (`user-invocable`, default true). */
  readonly userInvocable: boolean
}

/** A parsed SKILL.md document. */
export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: ParsedInvocation
  readonly content: string
}

/** Byte range of the YAML frontmatter block (between the two `---` lines). */
interface FrontmatterRange {
  readonly start: number
  readonly end: number
}

/** Locate the frontmatter block; undefined when not a `---`-delimited doc. */
function frontmatterRange(raw: string): FrontmatterRange | undefined {
  const firstEnd = raw.indexOf('\n')
  if (firstEnd < 0 || raw.slice(0, firstEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const next = raw.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? raw.length : next
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { start, end: lineStart }
    }
    if (next < 0) return undefined
    lineStart = next + 1
  }
  return undefined
}

/** Parse YAML frontmatter plus body; returns undefined when not a SKILL.md. */
export function parseSkill(raw: string): ParsedSkill | undefined {
  const range = frontmatterRange(raw)
  if (range === undefined) return undefined
  const fields = parseFrontmatterFields(raw.slice(range.start, range.end))
  if (fields === undefined) return undefined
  const name = fields.get('name')
  const description = fields.get('description')
  if (typeof name !== 'string' || name.length === 0 || typeof description !== 'string' || description.length === 0) return undefined
  if (!SKILL_NAME.test(name)) return undefined
  const whenToUse = typeof fields.get('whenToUse') === 'string' ? String(fields.get('whenToUse')) : undefined
  const bodyStart = range.end + 4 <= raw.length && raw.slice(range.end, range.end + 4) === '---\n' ? range.end + 4 : range.end + 3
  return {
    name,
    description,
    ...(whenToUse !== undefined && whenToUse.length > 0 ? { whenToUse } : {}),
    invocation: parseInvocation(fields),
    content: raw.slice(bodyStart).trim(),
  }
}

/** Parse the invocation policy from frontmatter fields. */
function parseInvocation(fields: Map<string, string>): ParsedInvocation {
  const disableModel = fields.get('disable-model-invocation')
  const userInvocable = fields.get('user-invocable')
  return {
    modelInvocable: !isTruthy(disableModel),
    userInvocable: !(userInvocable !== undefined && isFalsy(userInvocable)),
  }
}

/** Whether a scalar frontmatter value reads as true. */
function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === 'yes' || value === '1' || value === 'on'
}

/** Whether a scalar frontmatter value reads as false. */
function isFalsy(value: string | undefined): boolean {
  return value === 'false' || value === 'no' || value === '0' || value === 'off'
}

/** Parse the simple scalar frontmatter keys we write; unknown syntax gives up. */
function parseFrontmatterFields(yaml: string): Map<string, string> | undefined {
  const fields = new Map<string, string>()
  for (const line of yaml.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line.trim())
    if (!match) return undefined
    fields.set(match[1]!, stripYamlScalar(match[2]!))
  }
  return fields
}

/** Unwrap a single- or double-quoted scalar, else keep the raw value. */
function stripYamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  return value
}

/** Render a SKILL.md document for a managed skill. */
export function renderSkill(input: { readonly name: string; readonly description: string; readonly whenToUse?: string; readonly content: string }): string {
  const lines = ['---', `name: ${input.name}`, `description: ${yamlQuote(input.description)}`]
  if (input.whenToUse !== undefined && input.whenToUse.length > 0) {
    lines.push(`whenToUse: ${yamlQuote(input.whenToUse)}`)
  }
  lines.push('---', '', input.content.trim())
  return lines.join('\n') + '\n'
}

/** Quote a scalar for YAML frontmatter (single quotes, doubling internal quotes). */
function yamlQuote(value: string): string {
  const single = value.replace(/\r?\n/g, ' ').replaceAll("'", "''")
  return `'${single}'`
}

/** Patch a skill's invocation fields by rewriting the frontmatter lines. */
export function setInvocation(raw: string, patch: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean }): string {
  const range = frontmatterRange(raw)
  if (range === undefined) return raw
  const lines = raw.slice(range.start, range.end).split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const dropped = lines.filter((line) => {
    const key = /^([A-Za-z][A-Za-z0-9-]*):/.exec(line.trim())?.[1]
    return key !== 'disable-model-invocation' && key !== 'user-invocable'
  })
  const out = [...dropped]
  if (patch.modelInvocable === false) out.push('disable-model-invocation: true')
  if (patch.userInvocable === false) out.push('user-invocable: false')
  return raw.slice(0, range.start) + out.join('\n') + '\n' + raw.slice(range.end)
}

/** Discover SKILL.md documents under one root. */
export function listRootSkills(root: SkillRoot): SkillDetail[] {
  const out: SkillDetail[] = []
  if (!existsSync(root.path)) return out
  let entries: string[] = []
  try {
    entries = readdirSync(root.path)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (root.layer === 'user-dsh' && entry === '.system') continue
    const isDir = existsSync(join(root.path, entry, SKILL_FILE))
    const isFlat = /\.md$/.test(entry) && !isDir
    const file = isDir ? join(root.path, entry, SKILL_FILE) : isFlat ? join(root.path, entry) : undefined
    if (file === undefined) continue
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const parsed = parseSkill(raw)
    if (parsed === undefined) continue
    out.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      modelInvocable: parsed.invocation.modelInvocable,
      userInvocable: parsed.invocation.userInvocable,
      layer: root.layer,
      ...(root.pid !== undefined ? { pid: root.pid } : {}),
      path: file,
      editable: isEditableLayer(root.layer),
      content: parsed.content,
    })
  }
  return out
}

/** Resolve the SKILL.md path for a managed skill, create the parent file when absent. */
export function skillFilePath(root: string, name: string, ensure = false): string {
  const dir = join(root, name)
  const file = join(dir, SKILL_FILE)
  if (ensure && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  return file
}

/** Write a SKILL.md document for a managed skill. */
export function writeSkillFile(root: string, input: { readonly name: string; readonly description: string; readonly whenToUse?: string; readonly content: string }): string {
  const file = skillFilePath(root, input.name, true)
  writeFileSync(file, renderSkill(input), 'utf8')
  return file
}

/** Remove a managed skill directory. */
export function deleteSkillDir(root: string, name: string): void {
  rmSync(join(root, name), { recursive: true, force: true })
}

/** Whether a managed skill directory already exists. */
export function skillExists(root: string, name: string): boolean {
  return existsSync(join(root, name, SKILL_FILE))
}