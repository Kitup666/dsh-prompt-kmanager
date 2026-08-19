/**
 * Mode (agent-preset) persona editing.
 *
 * A mode is a `.agent-presets/<id>` directory whose `agent.cordis.yml` is a
 * top-level list of plugin rows. The official `dsh-persona` row carries the
 * mode's system prompt under `config.text`, plus `complete` and
 * `includeRuntimeContext` flags. This module performs **line-level surgery** on
 * that file: it never parses the whole YAML, so official-dialect constructs
 * such as `!!js process.platform !== 'win32'` and file comments survive
 * byte-for-byte. Only the persona row's scalar values are replaced.
 *
 * When the host composition provides `ctx.agentPresets`, discovery prefers the
 * official service; this module still edits the same files that service mounts,
 * so a new session picks the new generation up via the roster's stamp check.
 * @module @deepseek-ai/dsh-prompt-kmanager/presets
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'
import type { ModePersona, OnDiskPersona } from './types.ts'

/** The persona row's package name in a preset composition. */
export const PERSONA_PACKAGE = '@deepseek-ai/dsh-persona'
/** The instructions row whose `maxBytes` budget we surface. */
export const INSTRUCTIONS_PACKAGE = '@deepseek-ai/dsh-agent-instructions'

/** Extracted persona row facts. Line numbers are 0-based. */
export interface PersonaRow {
  readonly rowStart: number
  readonly rowEnd: number
  readonly keyIndent: number
  readonly textLine: number | null
  readonly textIndent: number
  readonly completeLine: number | null
  readonly includeLine: number | null
}

/** The persona values currently on disk. */
export interface ExtractedPersona {
  readonly text: string | null
  readonly complete: boolean | null
  readonly includeRuntimeContext: boolean | null
  readonly row: PersonaRow | null
}

/** A single changed line for dry-run previews. */
export interface LineChange {
  readonly line: number
  readonly before: string
  readonly after: string
}

function lineIndent(line: string): number {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0].length : 0
}

/** Find the row block (top-level `- id:` list item) containing a given line. */
function rowBounds(lines: readonly string[], rowStart: number): number {
  let end = rowStart + 1
  while (end < lines.length) {
    const line = lines[end] ?? ''
    if (/^-\s/.test(line)) break
    end += 1
  }
  return end
}

/**
 * Extract the persona row (matched by `name: @deepseek-ai/dsh-persona`, with
 * `id: persona` as a fallback) and its scalar values.
 */
export function extractPersona(lines: readonly string[]): ExtractedPersona {
  let row: PersonaRow | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const m = /^-\s+id:\s*(\S+)/.exec(line)
    if (!m) continue
    const rowStart = i
    const rowEnd = rowBounds(lines, rowStart)
    let isPersona = false
    let keyIndent = -1
    let textLine: number | null = null
    let textIndent = -1
    let completeLine: number | null = null
    let includeLine: number | null = null
    for (let j = rowStart; j < rowEnd; j += 1) {
      const l = lines[j] ?? ''
      const indent = lineIndent(l)
      const key = l.trim()
      if (/^name:\s*/.test(key) && key.includes(PERSONA_PACKAGE)) isPersona = true
      if (key.startsWith('text:')) {
        textLine = j
        textIndent = indent
      } else if (key.startsWith('complete:')) {
        completeLine = j
      } else if (key.startsWith('includeRuntimeContext:')) {
        includeLine = j
      }
      if (/^[a-zA-Z]/.test(key) && keyIndent < 0 && indent > 0) keyIndent = indent
    }
    if (!isPersona && (m[1] ?? '') !== 'persona') continue
    if (keyIndent < 0) keyIndent = 2
    row = { rowStart, rowEnd, keyIndent, textLine, textIndent, completeLine, includeLine }
    break
  }
  if (!row) return { text: null, complete: null, includeRuntimeContext: null, row: null }

  const text = readScalar(lines, row.textLine, row.textIndent)
  const complete = readBoolean(lines, row.completeLine)
  const include = readBoolean(lines, row.includeLine)
  return { text, complete, includeRuntimeContext: include, row }
}

/** Read a scalar after `key:` at the given line (inline or block). */
function readScalar(lines: readonly string[], line: number | null, indent: number): string | null {
  if (line === null) return null
  const raw = lines[line] ?? ''
  const sep = raw.indexOf(':')
  if (sep < 0) return null
  let value = raw.slice(sep + 1).trim()
  if (value === '|' || value === '|-' || value === '>') {
    // Block scalar: following lines strictly more indented than the key.
    const parts: string[] = []
    let j = line + 1
    const bodyIndent = indent + 2
    while (j < lines.length) {
      const l = lines[j] ?? ''
      if (lineIndent(l) <= indent) break
      parts.push(l.slice(Math.min(lineIndent(l), bodyIndent)))
      j += 1
    }
    const text = parts.join('\n')
    return value.startsWith('|') ? text.replace(/\n$/, '') : text
  }
  return unquote(value)
}

function readBoolean(lines: readonly string[], line: number | null): boolean | null {
  if (line === null) return null
  const raw = (lines[line] ?? '').trim()
  const m = /:\s*(true|false)\s*$/.exec(raw)
  return m ? (m[1] === 'true') : null
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const head = value[0]
    const tail = value[value.length - 1]
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** True when a single-line plain scalar is safe (no YAML traps). */
function plainScalarSafe(text: string): boolean {
  if (text.length === 0) return false
  if (/[\r\n]/.test(text)) return false
  if (/^[\s\-?:,.[\]{}#&*!|>'"%@`]/.test(text)) return false
  if (/:(\s|$)/.test(text)) return false
  if (/\s$/.test(text)) return false
  return true
}

/** Encode a persona text as one or more YAML lines under a key. */
function scalarLines(indent: number, value: string): string[] {
  if (plainScalarSafe(value)) {
    return [`${' '.repeat(indent)}text: ${value}`]
  }
  const pad = ' '.repeat(indent + 2)
  const body = value.split('\n').map((l) => `${pad}${l}`)
  return [`${' '.repeat(indent)}text: |`, ...body]
}

/** Replace (or insert) the value of a boolean key at a given indent. */
function setBooleanLine(
  lines: string[],
  keyLine: number | null,
  indent: number,
  key: string,
  value: boolean,
  anchor: number,
): number | null {
  const line = `${' '.repeat(indent)}${key}: ${value}`
  if (keyLine !== null) {
    lines[keyLine] = line
    return keyLine
  }
  const at = Math.min(Math.max(anchor, 0), lines.length)
  lines.splice(at, 0, line)
  return at
}

/**
 * Apply a persona patch to a composition. Returns the new text plus the exact
 * changed lines (for dry-run previews). The file is not touched here.
 */
export function applyPersonaPatch(
  source: string,
  patch: Partial<ModePersona>,
): { readonly text: string; readonly changes: readonly LineChange[] } {
  const lines = source.split('\n')
  const before = [...lines]
  const changes: LineChange[] = []
  const { row: initialRow } = extractPersona(lines)

  const record = (line: number): void => {
    const b = before[line] ?? ''
    const a = lines[line] ?? ''
    if (b !== a) changes.push({ line, before: b, after: a })
  }

  if (patch.text !== undefined) {
    if (!initialRow) {
      // No persona row: insert a minimal one at the end.
      const indent = 2
      const inserted = ['- id: persona', '  name: \'@deepseek-ai/dsh-persona\'', '  config:']
      for (const l of scalarLines(4, patch.text)) inserted.push(l)
      const at = lines.length
      lines.push(...inserted)
      for (let k = 0; k < inserted.length; k += 1) changes.push({ line: at + k, before: '', after: inserted[k] ?? '' })
    } else {
      const indent = initialRow.textIndent > 0 ? initialRow.textIndent : 4
      const replacement = scalarLines(indent, patch.text)
      if (initialRow.textLine !== null) {
        const valueStart = initialRow.textLine
        let valueEnd = valueStart + 1
        const raw = lines[valueStart] ?? ''
        const sep = raw.indexOf(':')
        const value = raw.slice(sep + 1).trim()
        if (value === '|' || value === '|-' || value === '>') {
          while (valueEnd < lines.length) {
            const l = lines[valueEnd] ?? ''
            if (lineIndent(l) <= indent) break
            valueEnd += 1
          }
        }
        const span = valueEnd - valueStart
        lines.splice(valueStart, span, ...replacement)
        for (let k = 0; k < Math.max(span, replacement.length); k += 1) {
          const idx = valueStart + k
          record(idx)
        }
      } else {
        const anchor = lines.findIndex((l) => l.trim().startsWith('config:'))
        const at = anchor >= 0 ? anchor + 1 : initialRow.rowEnd
        lines.splice(at, 0, ...replacement)
        for (let k = 0; k < replacement.length; k += 1) changes.push({ line: at + k, before: '', after: replacement[k] ?? '' })
      }
    }
  }

  // The text replacement may shift line indices; re-extract before touching booleans.
  const { row } = extractPersona(lines)

  if (row && patch.complete !== undefined) {
    const indent = configChildIndent(lines, row)
    const anchor = (row.textLine ?? row.rowStart) + 1
    const at = setBooleanLine(lines, row.completeLine, indent, 'complete', patch.complete, anchor)
    if (at !== null) record(at)
  }

  if (row && patch.includeRuntimeContext !== undefined) {
    const indent = configChildIndent(lines, row)
    const anchor = (row.textLine ?? row.rowStart) + 1
    const at = setBooleanLine(lines, row.includeLine, indent, 'includeRuntimeContext', patch.includeRuntimeContext, anchor)
    if (at !== null) record(at)
  }

  return { text: lines.join('\n'), changes }
}

/**
 * The indent under which `config:` children live (where `complete` and
 * `includeRuntimeContext` belong). Prefers the existing `text:` key indent,
 * then `config:` indent + 2, then the row's own key indent.
 */
function configChildIndent(lines: readonly string[], row: PersonaRow): number {
  if (row.textLine !== null && row.textIndent > 0) return row.textIndent
  for (let j = row.rowStart; j < row.rowEnd; j += 1) {
    const l = lines[j] ?? ''
    if (l.trim().startsWith('config:')) return lineIndent(l) + 2
  }
  return row.keyIndent > 0 ? row.keyIndent : 2
}

/** Read the on-disk persona of a preset directory. */
export function readOnDiskPersona(presetDir: string): OnDiskPersona {
  const file = join(presetDir, 'agent.cordis.yml')
  if (!existsSync(file)) return { text: null, complete: null, includeRuntimeContext: null, path: null }
  const extracted = extractPersona(readFileSync(file, 'utf8').split(/\r?\n/u))
  return {
    text: extracted.text,
    complete: extracted.complete,
    includeRuntimeContext: extracted.includeRuntimeContext,
    path: file,
  }
}

/**
 * Read `preset.yml` display metadata, healing files the harness parser rejects.
 *
 * Third-party presets (e.g. dsh-router-standard) ship `description:` values
 * containing a bare `: `, which js-yaml rejects as a nested mapping — the
 * harness's own picker then shows no description. The lenient fallback extracts
 * the two display fields and rewrites the file as valid YAML (`yaml.dump`
 * quotes such values), so this reader and the harness picker agree afterwards.
 */
export function readPresetYml(presetDir: string): { readonly name?: string; readonly description?: string } {
  const file = join(presetDir, 'preset.yml')
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf8')
  let parsed: unknown
  try {
    parsed = yamlLoad(raw)
  } catch {
    const meta = lenientPresetMeta(raw)
    let normalized = ''
    try {
      normalized = yamlDump(
        {
          ...(meta.name !== undefined ? { name: meta.name } : {}),
          ...(meta.description !== undefined ? { description: meta.description } : {}),
        },
        { lineWidth: -1 },
      )
    } catch {
      return meta
    }
    try {
      writeFileSync(file, normalized)
    } catch {
      /* v8 ignore next -- best-effort repair; the read still returns what it found. */
    }
    return meta
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const text = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const name = text(record.name)
  const description = text(record.description)
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}

/** Lenient fallback for a `preset.yml` that fails strict YAML parsing. */
function lenientPresetMeta(raw: string): { readonly name?: string; readonly description?: string } {
  let name: string | undefined
  let description: string | undefined
  for (const line of raw.split(/\r?\n/u)) {
    const m = /^name:\s*(.*)$/.exec(line)
    if (m !== null) name = unquote((m[1] ?? '').trim())
    const d = /^description:\s*(.*)$/.exec(line)
    if (d !== null) description = unquote((d[1] ?? '').trim())
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}

/** Rewrite `preset.yml` metadata, preserving unknown keys. */
export function writePresetYml(presetDir: string, patch: { readonly name?: string; readonly description?: string }): string {
  const file = join(presetDir, 'preset.yml')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = existing.split('\n')
  const set = (key: string, value: string): void => {
    const line = `${key}: ${value}`
    const idx = lines.findIndex((l) => /^(name|description):/.test(l.trim()))
    if (idx >= 0) {
      const at = lines.findIndex((l) => l.trim().startsWith(`${key}:`))
      if (at >= 0) lines[at] = line
      else lines.splice(idx, 0, line)
    } else {
      lines.push(line)
    }
  }
  if (patch.name !== undefined) set('name', patch.name)
  if (patch.description !== undefined) set('description', patch.description)
  const out = lines.join('\n').replace(/\s+$/, '') + '\n'
  writeFileSync(file, out, 'utf8')
  return out
}

/**
 * Read the `maxBytes` budget the given preset configures for
 * `@deepseek-ai/dsh-agent-instructions` (null when unset or unreadable).
 */
export function readInstructionsBudget(presetDir: string): number | null {
  const file = join(presetDir, 'agent.cordis.yml')
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf8').split(/\r?\n/u)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (!line.includes(INSTRUCTIONS_PACKAGE)) continue
    // Walk the row's block for config.maxBytes.
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] ?? ''
      if (/^-\s/.test(l) && lineIndent(l) === 0) break
      const m = /^\s*maxBytes:\s*(\d+)\s*$/.exec(l)
      if (m) {
        const n = Number(m[1])
        if (Number.isFinite(n)) return n
      }
    }
    break
  }
  return null
}
