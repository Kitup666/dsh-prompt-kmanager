// Plain-Node smoke test for the built lib: store round-trips, marker
// composition preserving foreign text, and persona line-surgery against a
// throwaway harness home. Run `node tests/smoke.mjs` after build.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis')
const lib = require(`../lib/index.js` /* @vite-ignore */)
const { PromptKManagerService } = lib
const { splitFile, composeFile, diffPreview } = lib

const home = mkdtempSync(join(tmpdir(), 'pkmgr-'))
const ctx = new Context()
const service = new PromptKManagerService(ctx, { home })

// ---- marker composition semantics ----
{
  const file = '# 手写标题\n\n请保持这段内容原样。\n'
  const segments = splitFile(file)
  assert.equal(segments.blocks.length, 0, 'no markers yet')
  const active = new Map([['g-a', { title: '语言', content: '用中文交流。' }]])
  const composed = composeFile(segments, active, new Set(['g-a']))
  assert.match(composed, /# 手写标题/, 'foreign heading preserved')
  assert.match(composed, /km-prompts:g-a:begin/, 'managed block rendered')
  assert.match(composed, /## 语言/, 'heading rendered')

  // disable -> block removed, foreign text still there
  const disabled = composeFile(splitFile(composed), new Map(), new Set(['g-a']))
  assert.match(disabled, /# 手写标题/, 'foreign text survives removal')
  assert.ok(!disabled.includes('km-prompts:g-a:begin'), 'disabled block dropped')

  // unknown block (not ours) is preserved verbatim
  const foreignBlock = '<!-- other-manager:x:begin -->\nhello\n<!-- other-manager:x:end -->'
  const kept = composeFile(splitFile(foreignBlock + '\n' + composed), active, new Set(['g-a']))
  assert.match(kept, /other-manager:x:begin/, 'foreign block preserved')
}

// ---- global scope ----
{
  const e1 = service.addGlobalEntry('语言', '偏好中文。')
  const e2 = service.addGlobalEntry('网络', '优先 web_search。')
  assert.equal(service.listGlobalEntries().length, 2)
  const patch = service.applyGlobal(true)
  assert.equal(patch.changed, true)
  assert.equal(patch.written, undefined, 'dry-run never writes')
  const applied = service.applyGlobal(false)
  assert.equal(applied.written, true)
  const text = readFileSync(join(home, 'AGENTS.md'), 'utf8')
  assert.match(text, /偏好中文/, 'content written')
  assert.match(text, /优先 web_search/, 'second content written')

  // apply again -> unchanged
  const again = service.applyGlobal(false)
  assert.equal(again.changed, false, 'idempotent render')

  // reorder reflected in the rendered file order
  service.reorderGlobalEntries([e2.id, e1.id])
  const reorderedText = service.renderGlobal().text
  assert.ok(reorderedText.indexOf('优先 web_search') < reorderedText.indexOf('偏好中文'), 'reorder reflected')

  // remove
  service.removeGlobalEntry(e1.id)
  assert.equal(service.listGlobalEntries().length, 1)
  assert.ok(!service.renderGlobal().text.includes('偏好中文'), 'removed entry no longer rendered')
  // emitted apply actually strips the deleted block from the target
  service.applyGlobal(false)
  assert.ok(!readFileSync(join(home, 'AGENTS.md'), 'utf8').includes('偏好中文'), 'deleted block stripped on apply')
  assert.ok(!service.status().global.unmanagedText.includes('偏好中文'), 'deleted block not shown as unmanaged')

  // re-add a fresh entry keeps rendering; deleted block stays gone
  const e3 = service.addGlobalEntry('语言', '新语言规则。')
  service.applyGlobal(false)
  const fileText = readFileSync(join(home, 'AGENTS.md'), 'utf8')
  assert.match(fileText, /新语言规则/, 're-added entry rendered')
  assert.ok(!fileText.includes('偏好中文'), 'old deleted block still gone after re-add')

  // import existing file with foreign text
  writeFileSync(join(home, 'AGENTS.md'), '# 手写\n\n外部内容\n')
  const imported = service.importGlobal('imported')
  assert.equal(imported.title, 'imported')
  const rendered = service.applyGlobal(true)
  assert.match(rendered.preview, /外部内容/, 'imported content managed')
}

// ---- project scope ----
{
  const projDir = mkdtempSync(join(tmpdir(), 'proj-'))
  const project = service.registerProject(projDir, 'AGENTS.md')
  const pe = service.addProjectEntry(project.id, '项目规则', '只改本仓库。')
  const patch = service.applyProject(project.id, false)
  assert.equal(patch.written, true)
  assert.match(readFileSync(join(projDir, 'AGENTS.md'), 'utf8'), /只改本仓库/)
  service.removeProjectEntry(project.id, pe.id)
  service.unregisterProject(project.id)
  assert.ok(!existsSync(join(home, 'kmanager.prompts', 'projects', project.id)))
}

// ---- mode (persona) line surgery ----
{
  const modeDir = join(home, '.agent-presets', 'demo')
  mkdirSync(modeDir, { recursive: true })
  const comp = [
    '# The `demo` agent preset.',
    '',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: You are a helpful software engineer assistant.',
    '    complete: true',
    '    includeRuntimeContext: false',
    '',
    '- id: shell',
    "  name: '@deepseek-ai/dsh-tool-pwsh'",
    "  disabled: !!js process.platform !== 'win32'",
    '',
  ].join('\n')
  writeFileSync(join(modeDir, 'agent.cordis.yml'), comp)
  writeFileSync(join(modeDir, 'preset.yml'), 'name: 演示模式\ndescription: 演示。\n')

  service.setMode({ id: 'demo', persona: { text: '你是演示助手。\n第二行。', complete: true, includeRuntimeContext: true } })

  // dry-run preview first: on-disk still holds the old text, so it must differ
  const preview = await service.applyMode('demo', true)
  assert.equal(preview.changed, true)
  assert.ok(preview.preview !== '(unchanged)', 'dry-run shows a diff')
  assert.equal(preview.written, undefined, 'dry-run never writes')

  // apply for real
  const applied = await service.applyMode('demo', false)
  assert.equal(applied.written, true)
  const onDisk = readFileSync(join(modeDir, 'agent.cordis.yml'), 'utf8')
  assert.match(onDisk, /你是演示助手。\n      第二行。/s, 'multiline persona written')
  assert.match(onDisk, /disabled: !!js process\.platform !== 'win32'/, 'official dialect preserved')
  assert.match(onDisk, /complete: true/, 'complete flag kept')
  assert.match(onDisk, /includeRuntimeContext: true/, 'includeRuntimeContext updated')
  assert.ok(!onDisk.includes('helpful software engineer'), 'old text replaced')

  // reading back returns the managed persona
  const read = await service.readMode('demo')
  assert.equal(read.managedPersona.text, '你是演示助手。\n第二行。')
  assert.equal(read.budgetBytes, null)
  assert.equal(read.onDisk.text, '你是演示助手。\n第二行。')

  // idempotent re-apply
  const again = await service.applyMode('demo', false)
  assert.equal(again.changed, false, 'persona apply idempotent')

  // preset.yml metadata round trip
  const yml = readFileSync(join(modeDir, 'preset.yml'), 'utf8')
  assert.match(yml, /name: 演示模式/)
  assert.match(yml, /description: 演示。/)
}

// ---- skill scope ----
{
  // user-dsh root default from home; create then read back
  const created = service.createSkill({ layer: 'user-dsh', name: 'demo-skill', description: '演示技能', content: '# 正文\n\n规则。' })
  assert.equal(created.editable, true)
  assert.equal(created.layer, 'user-dsh')
  assert.ok(created.path.startsWith(join(home, 'skills')), 'user skill under home')
  const listed = service.listSkills()
  const found = listed.find(s => s.name === 'demo-skill' && s.layer === 'user-dsh')
  assert.ok(found, 'skill listed')
  const detail = service.readSkill('demo-skill', 'user-dsh')
  assert.match(detail.content, /规则。/, 'body round-trips')
  assert.equal(detail.description, '演示技能')

  // on-disk frontmatter is exactly what the official provider parses
  const raw = readFileSync(join(home, 'skills', 'demo-skill', 'SKILL.md'), 'utf8')
  assert.match(raw, /^---\nname: demo-skill\ndescription: '演示技能'\n---/, 'frontmatter written')
  assert.match(raw, /# 正文/, 'body written')

  // project-dsh skill under a registered project
  const projDir = mkdtempSync(join(tmpdir(), 'skproj-'))
  const project = service.registerProject(projDir, 'AGENTS.md')
  service.createSkill({ layer: 'project-dsh', projectId: project.id, name: 'proj-rule', description: '项目规则', content: '只改本仓库。' })
  const projSkill = service.listSkills().find(s => s.name === 'proj-rule')
  assert.ok(projSkill, 'project skill listed')
  assert.equal(projSkill.pid, project.id)
  assert.ok(existsSync(join(projDir, '.dsh', 'skills', 'proj-rule', 'SKILL.md')), 'file on disk')

  // update rewrites content
  service.updateSkill({ layer: 'user-dsh', name: 'demo-skill', description: '演示技能改', content: '# 新正文\n' })
  assert.match(service.readSkill('demo-skill', 'user-dsh').description, /改/, 'description updated')
  assert.match(service.readSkill('demo-skill', 'user-dsh').content, /新正文/, 'content updated')

  // invocation defaults are both on
  assert.equal(service.readSkill('demo-skill', 'user-dsh').modelInvocable, true)
  assert.equal(service.readSkill('demo-skill', 'user-dsh').userInvocable, true)

  // disabling model invocation writes the frontmatter line and re-parses
  const patched = service.setSkillInvocation('user-dsh', 'demo-skill', { modelInvocable: false, userInvocable: false })
  assert.equal(patched.modelInvocable, false)
  assert.equal(patched.userInvocable, false)
  const rawAfter = readFileSync(join(home, 'skills', 'demo-skill', 'SKILL.md'), 'utf8')
  assert.match(rawAfter, /disable-model-invocation: true/, 'model-disable line written')
  assert.match(rawAfter, /user-invocable: false/, 'user-invocable line written')
  assert.match(rawAfter, /name: demo-skill/, 'frontmatter otherwise intact')
  assert.match(rawAfter, /# 新正文/, 'body intact after patch')

  // re-enabling drops the lines
  const back = service.setSkillInvocation('user-dsh', 'demo-skill', { modelInvocable: true, userInvocable: true })
  assert.equal(back.modelInvocable, true)
  assert.equal(back.userInvocable, true)
  const rawBack = readFileSync(join(home, 'skills', 'demo-skill', 'SKILL.md'), 'utf8')
  assert.ok(!rawBack.includes('disable-model-invocation'), 'disable line dropped when re-enabled')
  assert.ok(!rawBack.includes('user-invocable'), 'user-invocable dropped when re-enabled')

  // invalid name rejected, removable
  assert.throws(() => service.createSkill({ layer: 'user-dsh', name: 'Bad Name', description: 'x', content: 'y' }), /invalid skill name/)
  service.removeSkill('user-dsh', 'demo-skill')
  assert.equal(service.listSkills().find(s => s.name === 'demo-skill' && s.layer === 'user-dsh'), undefined, 'removed')
  assert.ok(!existsSync(join(home, 'skills', 'demo-skill')), 'dir gone')
  service.unregisterProject(project.id)
  rmSync(projDir, { recursive: true, force: true })
}

// ---- one-shot apply + export/restore ----
{
  const patches = await service.applyAll(true)
  assert.ok(Array.isArray(patches))
  const dumped = JSON.parse(service.exportStore())
  assert.ok(dumped.global.entries.length >= 1)
  assert.ok(dumped.projects.length === 0)
  assert.ok(dumped.modes.demo, 'mode exported')
  const restored = mkdtempSync(join(tmpdir(), 'pkmgr2-'))
  const service2 = new PromptKManagerService(new Context(), { home: restored })
  service2.restoreStore(service.exportStore())
  const entries = service2.listGlobalEntries()
  assert.equal(entries.length, dumped.global.entries.length)
  assert.ok(JSON.parse(service2.exportStore()).modes.demo, 'restore keeps modes')
  rmSync(home, { recursive: true, force: true })
}

console.log('smoke ok')