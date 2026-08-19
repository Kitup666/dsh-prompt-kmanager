/**
 * Host-side prompt manager for the DeepSeek Harness.
 *
 * Registers a Cordis {@link PromptKManagerService} as `ctx.promptKManager` that
 * manages the three prompt scopes the official prompt plugins read — the
 * user-global `$DSH_HOME/AGENTS.md`, per-project `AGENTS.md`-family files, and
 * per-preset persona rows in `.agent-presets/<id>/agent.cordis.yml` — by
 * writing exactly those files. Nothing in the source checkout is ever touched.
 *
 * The service registers its browser HTTP seat (`/api/prompt-kmanager` +
 * `/prompts` page) through `ctx.inject(['webServer'])`, so headless contexts
 * simply never mount the route. It deliberately does not register prompt
 * sections into `ctx.systemPrompt`: file-level collaboration with the official
 * plugins is the whole point, and the assembly stays theirs.
 * @module @deepseek-ai/dsh-prompt-kmanager
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PromptKManagerService, PromptManagerError, type Config } from './service.ts'

export { PromptKManagerService, PromptManagerError } from './service.ts'
export type { Config } from './service.ts'
export type * from './types.ts'
export {
  isEditableLayer,
  listRootSkills,
  parseSkill,
  renderSkill,
  setInvocation,
  validateSkillName,
} from './skills.ts'
// Low-level collaboration semantics, useful for tests and embedders.
export {
  composeFile,
  diffPreview,
  renderBlock,
  splitFile,
  utf8Bytes,
  MARKER,
  DEFAULT_CANDIDATES,
  DEFAULT_LOCAL_CANDIDATES,
  DEFAULT_WRITE_CANDIDATE,
} from './instructions.ts'
export {
  applyPersonaPatch,
  extractPersona,
  readInstructionsBudget,
  readOnDiskPersona,
  readPresetYml,
  writePresetYml,
  PERSONA_PACKAGE,
  INSTRUCTIONS_PACKAGE,
} from './presets.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    promptKManager: PromptKManagerService
  }
}

/** Plugin entry: default-export the service class so the Loader mounts it. */
export default PromptKManagerService
