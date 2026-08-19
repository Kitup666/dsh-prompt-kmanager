/**
 * Browser HTTP carrier for the prompt manager. Registers a
 * `/api/prompt-kmanager` prefix route on the Host `webServer` service when it
 * exists, answering the JSON calls that drive the `/prompts` page. Route seats
 * are composition-level contracts: a second prompt manager fails loudly
 * instead of hijacking the API. Every response is strict JSON:
 * `{ ok: true, data }` or `{ ok: false, code, message }`.
 * @module @deepseek-ai/dsh-prompt-kmanager/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { PromptManagerError, type PromptKManagerService } from './service.ts'
import type { ModePersona, ModeSetInput, SkillLayer, SkillWriteInput } from './types.ts'

/** Route prefix claimed by this package on the Host web server. */
export const PROMPT_API_PREFIX = '/api/prompt-kmanager'

/** One result or error carrying the operation's stable code. */
type HandlerResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Parse a JSON request body defensively; null when empty or malformed. */
function readJsonBody(req: IncomingMessage, limit = 5_000_000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total > limit) reject(new Error('request body too large'))
    })
    req.on('end', () => {
      if (total === 0) { resolve(null); return }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        resolve(parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null)
      } catch { resolve(null) }
    })
    req.on('error', reject)
  })
}

/** Write one strict-JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: HandlerResult): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Normalize a string value from a JSON body. */
function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PromptManagerError('PROMPT_INVALID', `${field} must be a non-empty string`)
  }
  return value
}

/** Normalize an optional string; undefined when absent. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Normalize a boolean value. */
function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PromptManagerError('PROMPT_INVALID', `${field} must be a boolean`)
  }
  return value
}

/** Normalize a string array. */
function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((i) => typeof i !== 'string')) {
    throw new PromptManagerError('PROMPT_INVALID', `${field} must be a string array`)
  }
  return value as string[]
}

/** Normalize an optional skill layer string. */
function asOptionalSkillLayer(value: unknown): SkillLayer | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SKILL_LAYERS.has(value)) {
    throw new PromptManagerError('SKILL_INVALID', 'layer must be a skill layer name')
  }
  return value as SkillLayer
}

/** Normalize a writable skill layer. */
function asSkillWriteLayer(value: unknown): 'project-dsh' | 'user-dsh' {
  if (value !== 'project-dsh' && value !== 'user-dsh') {
    throw new PromptManagerError('SKILL_INVALID', 'layer must be project-dsh or user-dsh')
  }
  return value
}

const SKILL_LAYERS = new Set(['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'bundled'])

/** Build a SkillWriteInput from a JSON body. */
function skillWriteInput(body: Record<string, unknown> | null): SkillWriteInput {
  const pid = asOptionalString(body?.projectId)
  const when = asOptionalString(body?.whenToUse)
  return {
    layer: asSkillWriteLayer(body?.layer),
    ...(pid !== undefined ? { projectId: pid } : {}),
    name: asString(body?.name, 'name'),
    description: asString(body?.description, 'description'),
    ...(when !== undefined ? { whenToUse: when } : {}),
    content: typeof body?.content === 'string' ? body.content : '',
  }
}

/** Build a patch object including only defined fields (exactOptionalPropertyTypes-safe). */
function patchOf(values: Record<string, unknown>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value as string | boolean
  }
  return out
}

/**
 * Create the `/api/prompt-kmanager` route bound to the given service.
 * @param service - the manager service answering the calls.
 * @returns the route to register on the Host web server.
 */
export function createPromptApiRoute(service: PromptKManagerService): WebRoute {
  return {
    kind: 'prefix',
    path: PROMPT_API_PREFIX,
    handler: async (req, res): Promise<void> => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const method = req.method ?? 'GET'
      const segment = pathname.length > PROMPT_API_PREFIX.length
        ? pathname.slice(PROMPT_API_PREFIX.length + 1)
        : ''
      const result = await dispatch(service, method, segment, req)
      sendJson(res, result.ok ? 200 : 400, result)
    },
  }
}

/** Dispatch one request; errors map to error-shaped results. */
async function dispatch(
  service: PromptKManagerService,
  method: string,
  segment: string,
  req: IncomingMessage,
): Promise<HandlerResult> {
  try {
    // Pure GET reads.
    if (method === 'GET') {
      if (segment === 'status') return { ok: true, data: service.status() }
      if (segment === 'global') return { ok: true, data: service.listGlobalEntries() }
      if (segment === 'projects') return { ok: true, data: service.listProjects() }
      if (segment === 'modes') return { ok: true, data: await service.listModes() }
      if (segment === 'skills') return { ok: true, data: service.listSkills() }
      if (segment === 'export') {
        return { ok: true, data: JSON.parse(service.exportStore()) }
      }
      throw new PromptManagerError('UNSUPPORTED_SOURCE', `unknown prompt-kmanager route: ${segment}`)
    }
    if (method !== 'POST') {
      throw new PromptManagerError('UNSUPPORTED_SOURCE', `unsupported method ${method}`)
    }

    const body = await readJsonBody(req)

    // ---- global scope ----
    if (segment === 'global-add') {
      const entry = service.addGlobalEntry(
        asString(body?.title, 'title'),
        typeof body?.content === 'string' ? body.content : '',
      )
      return { ok: true, data: entry }
    }
    if (segment === 'global-update') {
      const entry = service.updateGlobalEntry(asString(body?.id, 'id'), patchOf({
        title: asOptionalString(body?.title),
        content: asOptionalString(body?.content),
        enabled: body?.enabled,
      }))
      return { ok: true, data: entry }
    }
    if (segment === 'global-remove') {
      service.removeGlobalEntry(asString(body?.id, 'id'))
      return { ok: true, data: { removed: true } }
    }
    if (segment === 'global-reorder') {
      return { ok: true, data: service.reorderGlobalEntries(asStringArray(body?.ids, 'ids')) }
    }
    if (segment === 'global-apply') {
      return { ok: true, data: service.applyGlobal(body?.dryRun === true) }
    }
    if (segment === 'global-import') {
      return { ok: true, data: service.importGlobal(asOptionalString(body?.title)) }
    }

    // ---- project scope ----
    if (segment === 'project-register') {
      const project = service.registerProject(
        asString(body?.path, 'path'),
        asOptionalString(body?.writeCandidate),
        asOptionalString(body?.id),
      )
      return { ok: true, data: project }
    }
    if (segment === 'project-unregister') {
      service.unregisterProject(asString(body?.id, 'id'))
      return { ok: true, data: { removed: true } }
    }
    if (segment === 'project-update') {
      const project = service.updateProject(asString(body?.id, 'id'), patchOf({
        enabled: body?.enabled,
        writeCandidate: asOptionalString(body?.writeCandidate),
      }))
      return { ok: true, data: project }
    }
    if (segment === 'project-entry-add') {
      const entry = service.addProjectEntry(
        asString(body?.projectId, 'projectId'),
        asString(body?.title, 'title'),
        typeof body?.content === 'string' ? body.content : '',
      )
      return { ok: true, data: entry }
    }
    if (segment === 'project-entry-update') {
      const entry = service.updateProjectEntry(
        asString(body?.projectId, 'projectId'),
        asString(body?.id, 'id'),
        patchOf({
          title: asOptionalString(body?.title),
          content: asOptionalString(body?.content),
          enabled: body?.enabled,
        }),
      )
      return { ok: true, data: entry }
    }
    if (segment === 'project-entry-remove') {
      service.removeProjectEntry(asString(body?.projectId, 'projectId'), asString(body?.id, 'id'))
      return { ok: true, data: { removed: true } }
    }
    if (segment === 'project-entry-reorder') {
      return {
        ok: true,
        data: service.reorderProjectEntries(asString(body?.projectId, 'projectId'), asStringArray(body?.ids, 'ids')),
      }
    }
    if (segment === 'project-apply') {
      return { ok: true, data: service.applyProject(asString(body?.id, 'id'), body?.dryRun === true) }
    }
    if (segment === 'project-import') {
      return { ok: true, data: service.importProject(asString(body?.id, 'id'), asOptionalString(body?.title)) }
    }

    // ---- mode scope ----
    if (segment === 'mode-read') {
      return { ok: true, data: await service.readMode(asString(body?.id, 'id')) }
    }
    if (segment === 'mode-set') {
      const id = asString(body?.id, 'id')
      const input: ModeSetInput = { id }
      if (body?.persona !== null && typeof body?.persona === 'object') {
        const p = body.persona as Record<string, unknown>
        const persona: ModePersona = {
          text: typeof p.text === 'string' ? p.text : '',
          complete: p.complete === true,
          includeRuntimeContext: p.includeRuntimeContext !== false,
        }
        input.persona = persona
      }
      if (body?.name !== undefined) input.name = asString(body.name, 'name')
      if (body?.description !== undefined) input.description = asString(body.description, 'description')
      return { ok: true, data: service.setMode(input) }
    }
    if (segment === 'mode-apply') {
      return { ok: true, data: await service.applyMode(asString(body?.id, 'id'), body?.dryRun === true) }
    }

    // ---- skill scope ----
    if (segment === 'skill-read') {
      return { ok: true, data: service.readSkill(asString(body?.name, 'name'), asOptionalSkillLayer(body?.layer)) }
    }
    if (segment === 'skill-create') {
      return { ok: true, data: service.createSkill(skillWriteInput(body)) }
    }
    if (segment === 'skill-update') {
      return { ok: true, data: service.updateSkill(skillWriteInput(body)) }
    }
    if (segment === 'skill-remove') {
      service.removeSkill(asSkillWriteLayer(body?.layer), asString(body?.name, 'name'), asOptionalString(body?.projectId))
      return { ok: true, data: { removed: true } }
    }
    if (segment === 'skill-invocation') {
      const patch: { modelInvocable?: boolean; userInvocable?: boolean } = {}
      if (body?.modelInvocable !== undefined) {
        patch.modelInvocable = asBoolean(body.modelInvocable, 'modelInvocable')
      }
      if (body?.userInvocable !== undefined) {
        patch.userInvocable = asBoolean(body.userInvocable, 'userInvocable')
      }
      return {
        ok: true,
        data: service.setSkillInvocation(
          asSkillWriteLayer(body?.layer),
          asString(body?.name, 'name'),
          patch,
          asOptionalString(body?.projectId),
        ),
      }
    }

    // ---- global actions ----
    if (segment === 'apply') {
      return { ok: true, data: await service.applyAll(body?.dryRun === true) }
    }
    if (segment === 'restore') {
      service.restoreStore(asString(body?.json, 'json'))
      return { ok: true, data: { restored: true } }
    }

    throw new PromptManagerError('UNSUPPORTED_SOURCE', `unknown prompt-kmanager route: ${segment}`)
  } catch (error) {
    if (error instanceof PromptManagerError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'REGISTRATION_FAILED', message: String(error) }
  }
}
