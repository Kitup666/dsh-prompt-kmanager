/**
 * Instruction-file composition for the global and project scopes.
 *
 * The manager writes exactly the candidate files the official
 * `@deepseek-ai/dsh-agent-instructions` plugin reads (`AGENTS.md` and friends),
 * but never owns the whole file: rendered managed blocks are wrapped in
 * `<!-- km-prompts:<scopeTag>:begin/end -->` markers so a render only touches
 * blocks this store manages, and anything the user wrote by hand stays
 * verbatim. The official plugin renders the whole file content inside its own
 * `<system-reminder>` framing, so markers are harmless model-visible text.
 *
 * Semantics intentionally mirror the official plugin: broader files first,
 * more specific later; per-file content is bounded by the preset's
 * `maxBytes` budget (read elsewhere and surfaced, not enforced here).
 * @module @deepseek-ai/dsh-prompt-kmanager/instructions
 */

/** Marker family prefix; a scope tag follows after the colon. */
export const MARKER = 'km-prompts'

/** The instruction chain the official plugin scans in each directory. */
export const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
/** Local-overlay candidates loaded after the base files of the same directory. */
export const DEFAULT_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']
/** Default per-project write target (the plugin's first base candidate). */
export const DEFAULT_WRITE_CANDIDATE = 'AGENTS.md'

function beginLine(scopeTag: string): string {
  return `<!-- ${MARKER}:${scopeTag}:begin -->`
}

function endLine(scopeTag: string): string {
  return `<!-- ${MARKER}:${scopeTag}:end -->`
}

/** One managed block parsed out of a target file. */
export interface ManagedBlock {
  readonly scopeTag: string
  /** Raw text between the markers (heading + content). */
  readonly raw: string
  /** Heading without the leading `#`s ('' when the block has no heading). */
  readonly title: string
  /** The content after the optional heading, right-trimmed. */
  readonly content: string
}

/** The parts of a target file: foreign text interleaved with managed blocks. */
export interface FileSegments {
  /** Foreign segments in order; length is blocks.length + 1. */
  readonly foreign: readonly string[]
  readonly blocks: readonly ManagedBlock[]
  /** True when this file contains any of our markers. */
  readonly managed: boolean
}

const BEGIN_RE = /^<!--\s*km-prompts:([^:\s]+):begin\s*-->$/
const END_RE = /^<!--\s*km-prompts:([^:\s]+):end\s*-->$/

/**
 * Split a target file into foreign text and managed blocks. Blocks whose begin
 * marker has no matching end marker are treated as foreign text (never ours).
 */
export function splitFile(text: string): FileSegments {
  const lines = text.split('\n')
  const foreign: string[] = []
  const blocks: ManagedBlock[] = []
  let i = 0
  let buf: string[] = []
  let openTag: string | null = null
  let blockBuf: string[] = []

  const flushForeign = (): void => {
    if (buf.length === 0) return
    foreign.push(buf.join('\n'))
    buf = []
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    const begin = BEGIN_RE.exec(trimmed)
    const end = END_RE.exec(trimmed)
    if (openTag !== null) {
      if (end && end[1] === openTag) {
        blockBuf.push(line)
        blocks.push(parseBlock(openTag, blockBuf.join('\n')))
        blockBuf = []
        openTag = null
      } else {
        blockBuf.push(line)
      }
    } else if (begin) {
      flushForeign()
      openTag = begin[1] ?? ''
      blockBuf = [line]
    } else {
      buf.push(line)
    }
    i += 1
  }

  if (openTag !== null) {
    // Unclosed block: not ours, restore it into the foreign stream.
    flushForeign()
    for (const line of blockBuf) buf.push(line)
    openTag = null
  }
  flushForeign()
  if (foreign.length === 0) foreign.push('')
  return { foreign, blocks, managed: blocks.length > 0 }
}

/** Interpret the raw text between markers. */
function parseBlock(scopeTag: string, raw: string): ManagedBlock {
  const lines = raw.split('\n')
  // Drop the begin marker line itself.
  const body = lines.slice(1).join('\n').replace(/\n*$/, '')
  const heading = /^#{1,6}\s+(.*)$/.exec(body)
  if (heading) {
    const rest = body.split('\n').slice(1).join('\n')
    return {
      scopeTag,
      raw,
      title: (heading[1] ?? '').trim(),
      content: rest.replace(/^\n+/, '').replace(/\s+$/, ''),
    }
  }
  return { scopeTag, raw, title: '', content: body.replace(/^\n+/, '').replace(/\s+$/, '') }
}

/** Render one managed block to its canonical text. */
export function renderBlock(scopeTag: string, title: string, content: string): string {
  const heading = title.length > 0 ? `## ${title}\n\n` : ''
  const body = content.replace(/^\n+/, '').replace(/\s+$/, '')
  return `${beginLine(scopeTag)}\n${heading}${body}\n${endLine(scopeTag)}`
}

/**
 * Re-compose a target file from its segments plus the store's entries.
 *
 * @param segments    current file split by {@link splitFile}.
 * @param activeById  enabled entries: scopeTag -> { title, content }.
 * @param knownIds    every entry id of this scope (enabled or not); a block
 *                    whose tag is known but disabled is removed, a tag that is
 *                    unknown is not ours and is preserved verbatim.
 * @returns the composed file text.
 */
export function composeFile(
  segments: FileSegments,
  activeById: ReadonlyMap<string, { readonly title: string; readonly content: string }>,
  knownIds: ReadonlySet<string>,
): string {
  // Block output order follows the store's entry order (map insertion order),
  // not the order blocks happen to have in the target file.
  const orderedTags = [...activeById.keys()]
  const parts: string[] = []
  let slot = 0
  for (let i = 0; i < segments.foreign.length; i += 1) {
    const foreign = (segments.foreign[i] ?? '').replace(/\s+$/, '')
    if (foreign.length > 0) parts.push(foreign)
    const block = segments.blocks[i]
    if (!block) continue
    if (knownIds.has(block.scopeTag)) {
      // Ours (active, disabled, or deleted): if a store entry remains, write it
      // here in store order; otherwise the block is dropped.
      if (slot < orderedTags.length) {
        const tag = orderedTags[slot]!
        slot += 1
        const entry = activeById.get(tag)
        if (entry) parts.push(renderBlock(tag, entry.title, entry.content))
      }
    } else {
      // Not ours: keep the foreign block verbatim; it does not consume a slot.
      parts.push(block.raw.replace(/\s+$/, ''))
    }
  }
  // Append enabled entries whose block had no slot in the file.
  for (; slot < orderedTags.length; slot += 1) {
    const tag = orderedTags[slot]!
    const entry = activeById.get(tag)
    if (entry) parts.push(renderBlock(tag, entry.title, entry.content))
  }
  const text = parts.filter((p) => p && p.length > 0).join('\n\n')
  return text.length > 0 ? `${text}\n` : ''
}

/** Byte length of prompt text (the official plugin budgets by bytes). */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Minimal unified preview between two texts (previous managed rendering vs the
 * new one). Server-side it is line-based; enough for a dry-run UI to show what
 * would change without a diff library.
 */
export function diffPreview(before: string, after: string, maxLines = 40): string {
  if (before === after) return '(unchanged)'
  const a = before.split('\n')
  const b = after.split('\n')
  const lines: string[] = []
  let changed = 0
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? ''
    const right = b[i] ?? ''
    if (left === right) continue
    changed += 1
    if (lines.length < maxLines) {
      lines.push(`- ${left}`)
      lines.push(`+ ${right}`)
      if (changed >= 4) lines.push('  …')
    }
  }
  if (lines.length === 0) return '(unchanged)'
  return lines.join('\n')
}