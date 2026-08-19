/**
 * Prompt manager page: a single self-contained HTML document served at
 * `/prompts`, driving the `/api/prompt-kmanager` JSON API. Tabs cover the
 * three managed scopes (global / project / mode) plus an overview and a
 * backup tab; every write is previewable through dry-run before it lands.
 * @module @deepseek-ai/dsh-prompt-kmanager/page
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROMPT_API_PREFIX } from './http.ts'

/** Exact route serving the prompt manager page. */
export const PROMPTS_PAGE_PATH = '/prompts'

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>提示词管理器 · dsh-prompt-kmanager</title>
<style>
  /* Token scale aligned with the harness design platform (ui-theme), matching
     the plugin manager page. Rendered outside the theme owner's DOM, so the
     scale is declared locally. */
  :root {
    color-scheme: dark;
    --c-bg-base: #151517;
    --c-bg-layer-1: #232326;
    --c-bg-layer-2: #2c2c2e;
    --c-bg-layer-3: #35353a;
    --c-bg-mask: rgba(0, 0, 0, 0.55);
    --c-label-primary: #eef0f3;
    --c-label-secondary: #cfd3da;
    --c-label-tertiary: #9ea4ad;
    --c-label-dimmed: #6a6f76;
    --c-border-l1: rgba(255, 255, 255, 0.06);
    --c-border-l2: rgba(255, 255, 255, 0.12);
    --c-border-l3: rgba(255, 255, 255, 0.18);
    --c-interactive-hover: rgba(255, 255, 255, 0.08);
    --c-interactive-active: rgba(255, 255, 255, 0.14);
    --c-brand: #5686fe;
    --c-brand-hover: #4176e6;
    --c-success: #22c55e;
    --c-danger: #f25a5a;
    --c-warn: #f5a03b;
    --c-focus: rgba(86, 134, 254, 0.5);
    --c-radius: 10px;
    --c-ease: cubic-bezier(0.4, 0, 0.2, 1);
    --c-duration: 0.2s;
    --c-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.6 var(--c-font);
    background: var(--c-bg-base); color: var(--c-label-primary);
  }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--c-border-l1); background: var(--c-bg-base); position: sticky; top: 0; z-index: 10; }
  header .logo { width: 22px; height: 22px; display: inline-block; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .sub { color: var(--c-label-tertiary); font-size: 12px; }
  nav { display: flex; gap: 6px; padding: 8px 20px; border-bottom: 1px solid var(--c-border-l1); background: var(--c-bg-base); overflow-x: auto; }
  nav button {
    border: none; background: transparent; color: var(--c-label-tertiary); padding: 7px 14px; border-radius: 8px;
    cursor: pointer; font-size: 13px; white-space: nowrap;
    transition: background var(--c-duration) var(--c-ease), color var(--c-duration) var(--c-ease);
  }
  nav button:hover { background: var(--c-interactive-hover); color: var(--c-label-primary); }
  nav button.active { background: var(--c-interactive-active); color: var(--c-label-primary); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }
  main { padding: 16px 20px 40px; max-width: 1080px; margin: 0 auto; }
  .card { background: var(--c-bg-layer-1); border: 1px solid var(--c-border-l1); border-radius: var(--c-radius); padding: 14px 16px; margin-bottom: 14px; }
  .card h2 { margin: 0 0 10px; font-size: 14px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 220px; }
  input[type=text], input[type=search], select, textarea {
    background: var(--c-bg-base); color: var(--c-label-primary); border: 1px solid var(--c-border-l2); border-radius: 8px;
    padding: 7px 10px; font: inherit; width: 100%;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--c-brand); }
  textarea { font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.5; min-height: 120px; resize: vertical; }
  button.act {
    background: var(--c-brand); color: #fff; border: none; border-radius: 8px; padding: 7px 14px;
    cursor: pointer; font-size: 13px; transition: background var(--c-duration) var(--c-ease);
  }
  button.act:hover { background: var(--c-brand-hover); }
  button.ghost { background: transparent; border: 1px solid var(--c-border-l2); color: var(--c-label-secondary); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  button.ghost:hover { border-color: var(--c-border-l3); color: var(--c-label-primary); background: var(--c-interactive-hover); }
  button.ghost:disabled { opacity: .4; cursor: default; }
  button.danger { background: transparent; border: 1px solid rgba(242, 90, 90, 0.45); color: var(--c-danger); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  button.danger:hover { background: rgba(242, 90, 90, 0.12); border-color: var(--c-danger); }
  button:focus-visible { outline: 2px solid var(--c-focus); outline-offset: 2px; }
  .meta { color: var(--c-label-dimmed); font-size: 12px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: var(--c-bg-layer-2); color: var(--c-label-tertiary); }
  .badge.on { background: rgba(34, 197, 94, 0.15); color: var(--c-success); }
  .badge.off { background: rgba(242, 90, 90, 0.15); color: var(--c-danger); }
  .badge.warn { background: rgba(245, 160, 59, 0.15); color: var(--c-warn); }
  .badge.err { background: rgba(242, 90, 90, 0.15); color: var(--c-danger); }
  .sw { position: relative; width: 38px; height: 20px; border: 1px solid var(--c-border-l3); border-radius: 999px; background: var(--c-bg-layer-2); padding: 0; margin: 0; cursor: pointer; vertical-align: middle; transition: background .15s, border-color .15s; }
  .sw .kw { position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--c-label-tertiary); transition: left .15s, background .15s, transform .15s; }
  .sw.on { background: var(--c-brand); border-color: var(--c-brand); }
  .sw.on .kw { left: 21px; background: #fff; }
  .sw:hover { border-color: var(--c-brand-hover); }
  .sw:hover .kw { background: var(--c-label-secondary); }
  .sw.on:hover { background: var(--c-brand-hover); border-color: var(--c-brand-hover); }
  .sw:active { background: var(--c-brand); }
  .sw:active .kw { transform: scale(.9); }
  .sws { display: inline-block; padding: 1px 7px; font-size: 11px; line-height: 16px; border: 1px dashed var(--c-border-l2); border-radius: 3px; color: var(--c-label-dimmed); cursor: not-allowed; user-select: none; }
  .sws.on { color: #c8d6f5; border-color: #5b7fd4; background: rgba(86, 134, 254, 0.08); }
  .sws.off { color: var(--c-label-tertiary); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--c-border-l1); font-size: 13px; vertical-align: top; }
  th { color: var(--c-label-dimmed); font-weight: 500; }
  .entry { border: 1px solid var(--c-border-l1); border-radius: var(--c-radius); padding: 10px 12px; margin-bottom: 10px; background: var(--c-bg-layer-1); }
  .entry .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .entry .bar .title { font-weight: 600; }
  .preview { background: var(--c-bg-base); border: 1px solid var(--c-border-l1); border-radius: 8px; padding: 10px 12px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; max-height: 260px; overflow: auto; color: var(--c-label-secondary); }
  .muted { color: var(--c-label-dimmed); }
  .check { display: flex; align-items: center; gap: 6px; }
  .check input { accent-color: var(--c-brand); }
  .tabs-inner { display: none; }
  .tabs-inner.active { display: block; }
  .toast { position: fixed; right: 16px; bottom: 16px; background: var(--c-bg-layer-2); border: 1px solid var(--c-border-l2); padding: 10px 16px; border-radius: 10px; font-size: 13px; z-index: 99; max-width: 60vw; }
  .toast.err { border-color: var(--c-danger); color: var(--c-danger); }
  code { background: var(--c-bg-layer-2); padding: 1px 6px; border-radius: 5px; font-size: 12px; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { border-radius: 999px; background: rgba(255, 255, 255, 0.16); border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); background-clip: padding-box; border: 2px solid transparent; }
  ::-webkit-scrollbar-corner { background: transparent; }
</style>
</head>
<body>
<header>
  <svg class="logo" viewBox="0 0 24 24" aria-hidden><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8.2a2.5 2.5 0 0 1-2.5 2.5H9.3l-3.9 3.4c-.5.44-1.4.1-1.4-.56V5.5z" fill="#5686fe"/><path d="M7.5 7.6h9M7.5 11.2h6" stroke="#5686fe" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>
  <h1>提示词管理器</h1>
  <span class="sub">dsh-prompt-kmanager · 全局 / 项目 / 模式 三层提示词</span>
</header>
<nav>
  <button data-tab="overview" class="active">概览</button>
  <button data-tab="global">全局提示词</button>
  <button data-tab="projects">项目提示词</button>
  <button data-tab="modes">模式提示词</button>
  <button data-tab="skills">技能</button>
  <button data-tab="backup">备份</button>
</nav>
<main>
  <section id="tab-overview" class="tabs-inner active"></section>
  <section id="tab-global" class="tabs-inner"></section>
  <section id="tab-projects" class="tabs-inner"></section>
  <section id="tab-modes" class="tabs-inner"></section>
  <section id="tab-skills" class="tabs-inner"></section>
  <section id="tab-backup" class="tabs-inner"></section>
</main>
<script>
'use strict';
const api = '${PROMPT_API_PREFIX}';
let state = { status: null, projects: [], modes: [], skills: [], currentProject: null, currentMode: null };

function el(id) { return document.getElementById(id); }
function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
async function http(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, code: 'BAD_RESPONSE', message: '非 JSON 响应' }));
  if (!json.ok) throw new Error(json.message || json.code || '请求失败');
  return json.data;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function diffHtml(patch) {
  if (!patch.changed) return '<div class="preview muted">(unchanged)</div>';
  return '<div class="preview">' + esc(patch.preview) + '</div>';
}
function bytes(n) {
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' B';
}
function patchMeta(p) {
  const mark = p.written ? '<span class="badge on">已写入</span>' : (p.changed ? '<span class="badge warn">需写入</span>' : '<span class="badge">无变化</span>');
  return '<div class="row"><span class="meta">' + esc(p.path) + '</span> ' + mark + ' <span class="meta">' + bytes(p.beforeBytes) + ' → ' + bytes(p.afterBytes) + '</span></div>';
}

// ---------- overview ----------
async function loadOverview() {
  state.status = await http('GET', '/status');
  const s = state.status;
  const modesOk = state.modes.length > 0 ? state.modes : await http('GET', '/modes');
  try { state.skills = await http('GET', '/skills'); } catch { state.skills = []; }
  let html = '<div class="card"><h2>仓库与 seam</h2>';
  html += '<p class="meta">存储目录: <code>' + esc(s.storeDir) + '</code></p>';
  html += '<p class="meta">官方协作: <code>ctx.agentPresets</code> ' + (s.seams.agentPresets ? '<span class="badge on">已装配</span>' : '<span class="badge off">未装配(回退目录扫描)</span>') + '</p></div>';

  html += '<div class="card"><h2>目标文件</h2><table><tr><th>作用域</th><th>路径</th><th>现状</th><th>渲染后</th></tr>';
  html += '<tr><td>全局</td><td>' + esc(s.global.targetPath) + '</td><td>' + (s.global.targetExists ? bytes(s.global.targetBytes) : '不存在') + '</td><td>' + bytes(s.global.renderedBytes) + ' <span class="meta">(' + s.global.entries.length + ' 条目)</span></td></tr>';
  for (const p of s.projects) {
    html += '<tr><td>项目 ' + esc(p.id) + '</td><td>' + esc(p.path + '/' + p.writeCandidate) + '</td><td>' + (p.targetExists ? bytes(p.targetBytes) : '不存在') + '</td><td>' + bytes(p.renderedBytes) + ' <span class="meta">(' + p.entries.length + ' 条目)</span></td></tr>';
  }
  html += '</table></div>';

  html += '<div class="card"><h2>模式预算 (agent-instructions maxBytes)</h2><table><tr><th>模式</th><th>名称</th><th>预算</th><th>受管</th><th>唯一提示词</th><th>运行时上下文</th></tr>';
  for (const m of modesOk) {
    const onDisk = m.onDisk || {};
    const complete = onDisk.complete === true ? '<span class="badge on">是</span>' : (onDisk.complete === false ? '<span class="badge">否</span>' : '<span class="muted">—</span>');
    const ctx = onDisk.includeRuntimeContext === false ? '<span class="badge off">否</span>' : (onDisk.includeRuntimeContext === true ? '<span class="badge on">是</span>' : '<span class="muted">—</span>');
    html += '<tr><td>' + esc(m.id) + '</td><td>' + esc(m.name) + '</td><td>' + (m.budgetBytes === null ? '未配置' : bytes(m.budgetBytes)) + '</td><td>' + (m.managed ? '<span class="badge on">是</span>' : '<span class="badge">否</span>') + '</td><td>' + complete + '</td><td>' + ctx + '</td></tr>';
  }
  html += '</table></div>';
  html += skillsOverviewCard();
  el('tab-overview').innerHTML = html;
}
function skillsOverviewCard() {
  let skills = state.skills || [];
  if (skills.length === 0) return '';
  let html = '<div class="card"><h2>技能 (SKILL.md)</h2><table><tr><th>名称</th><th>层</th><th>模型可调</th><th>用户可调</th><th>描述</th></tr>';
  for (const s of skills) {
    const layerName = LAYER_NAMES[s.layer] || s.layer;
    const model = s.editable
      ? '<button class="sw' + (s.modelInvocable ? ' on' : '') + '" title="模型可调" onclick="skillToggle(\\'' + esc(s.name) + '\\',\\'' + esc(s.layer) + '\\',\\'' + esc(String(s.pid || '')) + '\\',\\'modelInvocable\\',\\'' + (s.modelInvocable ? '0' : '1') + '\\')"><span class="kw"></span></button>'
      : '<span class="sws' + (s.modelInvocable ? ' on' : ' off') + '">' + (s.modelInvocable ? '可调' : '关') + '</span>';
    const user = s.editable
      ? '<button class="sw' + (s.userInvocable ? ' on' : '') + '" title="用户可调" onclick="skillToggle(\\'' + esc(s.name) + '\\',\\'' + esc(s.layer) + '\\',\\'' + esc(String(s.pid || '')) + '\\',\\'userInvocable\\',\\'' + (s.userInvocable ? '0' : '1') + '\\')"><span class="kw"></span></button>'
      : '<span class="sws' + (s.userInvocable ? ' on' : ' off') + '">' + (s.userInvocable ? '可调' : '关') + '</span>';
    html += '<tr><td>' + esc(s.name) + (s.editable ? '' : ' <span class="badge">官方</span>') + '</td><td>' + esc(layerName) + '</td><td>' + model + '</td><td>' + user + '</td><td class="meta">' + esc(s.description) + '</td></tr>';
  }
  return html + '</table></div>';
}

// ---------- global ----------
async function loadGlobal() {
  const entries = await http('GET', '/global');
  const s = state.status || await http('GET', '/status');
  let html = '<div class="card"><div class="row"><span class="meta">目标: <code>' + esc(s.global.targetPath) + '</code></span>';
  html += '<span class="meta">' + (s.global.targetExists ? '当前 ' + bytes(s.global.targetBytes) : '文件不存在') + ' · 管理后 ' + bytes(s.global.renderedBytes) + ' <span class="badge on">自动同步中</span></span></div></div>';
  html += '<div class="card"><h2>添加条目</h2><div class="row"><input type="text" id="g-title" class="grow" placeholder="标题,如: 语言偏好"></div>';
  html += '<textarea id="g-content" placeholder="提示词内容(Markdown)…" style="margin-top:8px"></textarea>';
  html += '<div class="row" style="margin-top:8px"><button class="act" onclick="globalAdd()">添加</button></div></div>';
  html += '<div id="g-list"></div>';
  el('tab-global').innerHTML = html;
  renderGlobalEntries(entries);
  el('tab-global').querySelector('#apply-preview')?.remove();
  if (window.__gPreview) { window.__gPreview = null; }
}
function renderGlobalEntries(entries) {
  const list = el('g-list');
  if (!list) return;
  if (entries.length === 0) { list.innerHTML = '<p class="muted">还没有全局提示词条目。</p>'; return; }
  list.innerHTML = entries.map((e, i) => {
    const on = e.enabled ? 'on' : 'off';
    return '<div class="entry" data-id="' + esc(e.id) + '">'
      + '<div class="bar"><span class="title">' + esc(e.title) + '</span>'
      + '<span class="badge ' + on + '">' + (e.enabled ? '启用' : '停用') + '</span>'
      + '<span class="grow"></span>'
      + '<button class="ghost" onclick="globalToggle(\\'' + esc(e.id) + '\\')">' + (e.enabled ? '停用' : '启用') + '</button>'
      + '<button class="ghost" onclick="globalMove(\\'' + esc(e.id) + '\\',-1)" ' + (i === 0 ? 'disabled' : '') + '>↑</button>'
      + '<button class="ghost" onclick="globalMove(\\'' + esc(e.id) + '\\',1)" ' + (i === entries.length - 1 ? 'disabled' : '') + '>↓</button>'
      + '<button class="danger" onclick="globalRemove(\\'' + esc(e.id) + '\\')">删除</button></div>'
      + '<textarea data-edit="' + esc(e.id) + '" placeholder="内容…">' + esc('') + '</textarea>'
      + '<div class="row" style="margin-top:6px"><button class="ghost" onclick="globalSave(\\'' + esc(e.id) + '\\')">保存内容</button></div>'
      + '</div>';
  }).join('');
  loadGlobalContents(entries);
}
async function loadGlobalContents(entries) {
  const all = await http('GET', '/export');
  const globals = ((all.global && all.global.entries) || []).filter(g => entries.some(e => e.id === g.id));
  const map = Object.fromEntries(globals.map(g => [g.id, g.content || '']));
  document.querySelectorAll('#g-list textarea[data-edit]').forEach(t => {
    const id = t.getAttribute('data-edit');
    t.value = map[id] || '';
  });
}
async function globalAdd() {
  const title = el('g-title').value.trim();
  const content = el('g-content').value;
  if (!title) { toast('标题不能为空', true); return; }
  await http('POST', '/global-add', { title, content });
  toast('已添加');
  loadGlobal();
}
async function globalSave(id) {
  const t = document.querySelector('#g-list textarea[data-edit="' + id + '"]');
  await http('POST', '/global-update', { id, content: t ? t.value : '' });
  toast('已保存');
}
async function globalToggle(id) {
  const entries = await http('GET', '/global');
  const e = entries.find(x => x.id === id);
  await http('POST', '/global-update', { id, enabled: !e.enabled });
  loadGlobal();
}
async function globalMove(id, dir) {
  const entries = await http('GET', '/global');
  const ids = entries.map(x => x.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await http('POST', '/global-reorder', { ids });
  loadGlobal();
}
async function globalRemove(id) {
  await http('POST', '/global-remove', { id });
  toast('已删除');
  loadGlobal();
}

// ---------- projects ----------
async function loadProjects() {
  state.projects = await http('GET', '/projects');
  let html = '<div class="card"><h2>注册项目</h2><div class="row">'
    + '<input type="text" id="p-path" class="grow" placeholder="项目根目录绝对路径, 如 D:\\MyProject">'
    + '<input type="text" id="p-cand" style="width:140px" placeholder="写入文件(默认 AGENTS.md)">'
    + '<button class="act" onclick="projectAdd()">注册</button></div></div>';
  html += '<div id="p-list"></div>';
  el('tab-projects').innerHTML = html;
  renderProjects();
}
function renderProjects() {
  const list = el('p-list');
  list.innerHTML = state.projects.map(p => {
    const on = p.enabled ? 'on' : 'off';
    return '<div class="entry" data-pid="' + esc(p.id) + '">'
      + '<div class="bar"><span class="title">' + esc(p.id) + '</span>'
      + '<span class="meta">' + esc(p.path) + '</span>'
      + '<span class="badge ' + on + '">' + (p.enabled ? '启用' : '停用') + '</span>'
      + '<span class="grow"></span>'
      + '<button class="ghost" onclick="projectToggle(\\'' + esc(p.id) + '\\')">' + (p.enabled ? '停用' : '启用') + '</button>'
      + '<button class="ghost" onclick="projectManage(\\'' + esc(p.id) + '\\')">管理条目(' + p.entries.length + ')</button>'
      + '<button class="danger" onclick="projectRemove(\\'' + esc(p.id) + '\\')">注销</button></div>'
      + '<div id="p-detail-' + esc(p.id) + '"></div></div>';
  }).join('') || '<p class="muted">还没有注册项目。</p>';
}
async function projectAdd() {
  const path = el('p-path').value.trim();
  if (!path) { toast('路径不能为空', true); return; }
  try {
    await http('POST', '/project-register', { path, writeCandidate: el('p-cand').value.trim() || undefined });
  } catch (e) { toast(String(e.message || e), true); return; }
  toast('已注册');
  loadProjects();
}
async function projectToggle(id) {
  const p = state.projects.find(x => x.id === id);
  await http('POST', '/project-update', { id, enabled: !p.enabled });
  loadProjects();
}
async function projectRemove(id) {
  await http('POST', '/project-unregister', { id });
  toast('已注销');
  loadProjects();
}
async function projectManage(id, forceReload) {
  const detail = el('p-detail-' + id);
  if (!forceReload && detail.dataset.loaded === '1') {
    detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    return;
  }
  detail.dataset.loaded = '1';
  detail.style.display = 'block';
  const data = await http('GET', '/export');
  const proj = data.projects.find(p => p.id === id);
  const map = new Map((proj?.entries || []) .map(e => [e.id, e.content || '']));
  let html = '<div class="card"><h2>' + esc(id) + ' 条目管理</h2>';
  html += '<div class="row"><input type="text" id="pj-title-' + esc(id) + '" class="grow" placeholder="标题"><textarea id="pj-content-' + esc(id) + '" placeholder="内容…" style="min-height:80px;margin-top:8px"></textarea></div>';
  html += '<div class="row" style="margin-top:8px"><button class="act" onclick="projectEntryAdd(\\'' + id + '\\')">添加条目</button></div></div>';
  html += '<div id="pj-list-' + esc(id) + '"></div>';
  detail.innerHTML = html;
  const listBox = el('pj-list-' + id);
  const entries = proj?.entries || [];
  if (entries.length === 0) { listBox.innerHTML = '<p class="muted">该项目的条目为空。</p>'; return; }
  listBox.innerHTML = entries.map((e, i) => {
    const on = e.enabled ? 'on' : 'off';
    return '<div class="entry"><div class="bar"><span class="title">' + esc(e.title) + '</span>'
      + '<span class="badge ' + on + '">' + (e.enabled ? '启用' : '停用') + '</span><span class="grow"></span>'
      + '<button class="ghost" onclick="projectEntryToggle(\\'' + id + '\\',\\'' + esc(e.id) + '\\')">切换</button>'
      + '<button class="ghost" onclick="projectEntryMove(\\'' + id + '\\',\\'' + esc(e.id) + '\\',-1)" ' + (i === 0 ? 'disabled' : '') + '>↑</button>'
      + '<button class="ghost" onclick="projectEntryMove(\\'' + id + '\\',\\'' + esc(e.id) + '\\',1)" ' + (i === entries.length - 1 ? 'disabled' : '') + '>↓</button>'
      + '<button class="danger" onclick="projectEntryRemove(\\'' + id + '\\',\\'' + esc(e.id) + '\\')">删除</button></div>'
      + '<textarea data-pj="' + esc(e.id) + '">' + esc(map.get(e.id) || '') + '</textarea>'
      + '<div class="row" style="margin-top:6px"><button class="ghost" onclick="projectEntrySave(\\'' + id + '\\',\\'' + esc(e.id) + '\\')">保存</button></div></div>';
  }).join('');
}
async function projectEntryAdd(pid) {
  const title = el('pj-title-' + pid).value.trim();
  const content = el('pj-content-' + pid).value;
  if (!title) { toast('标题不能为空', true); return; }
  await http('POST', '/project-entry-add', { projectId: pid, title, content });
  toast('已添加');
  projectManage(pid, true);
}
async function projectEntrySave(pid, id) {
  const t = document.querySelector('#pj-list-' + pid + ' textarea[data-pj="' + id + '"]');
  await http('POST', '/project-entry-update', { projectId: pid, id, content: t ? t.value : '' });
  toast('已保存');
}
async function projectEntryToggle(pid, id) {
  const data = await http('GET', '/export');
  const proj = data.projects.find(p => p.id === pid);
  const e = (proj?.entries || []).find(x => x.id === id);
  await http('POST', '/project-entry-update', { projectId: pid, id, enabled: !e.enabled });
  projectManage(pid, true);
}
async function projectEntryMove(pid, id, dir) {
  const data = await http('GET', '/export');
  const proj = data.projects.find(p => p.id === pid);
  const ids = (proj?.entries || []).map(x => x.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await http('POST', '/project-entry-reorder', { projectId: pid, ids });
  projectManage(pid, true);
}
async function projectEntryRemove(pid, id) {
  await http('POST', '/project-entry-remove', { projectId: pid, id });
  toast('已删除');
  projectManage(pid, true);
}

// ---------- modes ----------
async function loadModes() {
  state.modes = await http('GET', '/modes');
  let html = '<div class="card"><h2>模式列表 (Agent 预设 / persona)</h2><table><tr><th>ID</th><th>名称</th><th>预算</th><th>受管</th><th>磁盘 persona</th><th></th></tr>';
  for (const m of state.modes) {
    const disk = m.onDisk && m.onDisk.text !== null
      ? (m.onDisk.text.length > 40 ? esc(m.onDisk.text.slice(0, 40)) + '…' : esc(m.onDisk.text))
      : '<span class="muted">未找到 persona 行</span>';
    html += '<tr><td>' + esc(m.id) + '</td><td>' + esc(m.name) + (m.broken ? ' <span class="badge err">' + esc(m.broken) + '</span>' : '') + '</td>'
      + '<td>' + (m.budgetBytes === null ? '未配置' : bytes(m.budgetBytes)) + '</td>'
      + '<td>' + (m.managed ? '<span class="badge on">是</span>' : '<span class="badge">否</span>') + '</td>'
      + '<td>' + disk + '</td>'
      + '<td><button class="ghost" onclick="modeEdit(\\'' + esc(m.id) + '\\')">编辑</button></td></tr>';
  }
  html += '</table></div><div id="mode-detail"></div>';
  el('tab-modes').innerHTML = html;
}
async function modeEdit(id) {
  const data = await http('POST', '/mode-read', { id });
  const detail = el('mode-detail');
  const persona = data.managedPersona || { text: data.onDisk?.text || '', complete: data.onDisk?.complete === true, includeRuntimeContext: data.onDisk?.includeRuntimeContext !== false };
  detail.innerHTML = '<div class="card"><h2>编辑模式 <code>' + esc(data.id) + '</code></h2>'
    + '<p class="meta">磁盘: <code>' + esc(data.onDisk?.path || '(无)') + '</code> · 当前预算 '
    + (data.budgetBytes === null ? '未配置' : bytes(data.budgetBytes)) + '</p>'
    + '<div class="row"><input type="text" id="m-name" class="grow" placeholder="显示名 (preset.yml)" value="' + esc(data.name) + '"></div>'
    + '<textarea id="m-text" style="margin-top:8px">' + esc(persona.text) + '</textarea>'
    + '<div class="row" style="margin-top:8px">'
    + '<label class="check"><input type="checkbox" id="m-complete" ' + (persona.complete ? 'checked' : '') + '> 唯一系统提示词:此 persona 单独作为该模式的系统提示(不再拼接全局/项目指令)</label>'
    + '<label class="check"><input type="checkbox" id="m-ctx" ' + (persona.includeRuntimeContext ? 'checked' : '') + '> 注入运行时上下文:系统提示附带当前环境快照(cwd/平台等实时信息)</label>'
    + '</div>'
    + '<div class="row" style="margin-top:10px">'
    + '<button class="ghost" onclick="modePreview(\\'' + esc(data.id) + '\\')">预览写入 (dry-run)</button>'
    + '<button class="act" onclick="modeApply(\\'' + esc(data.id) + '\\')">写入预设</button>'
    + '</div><div id="mode-preview" style="margin-top:10px"></div></div>';
}
function modeCollect() {
  return {
    persona: {
      text: el('m-text').value,
      complete: el('m-complete').checked,
      includeRuntimeContext: el('m-ctx').checked,
    },
    name: el('m-name').value.trim() || undefined,
  };
}
async function modePreview(id) {
  const patch = await http('POST', '/mode-apply', { id, dryRun: true });
  const box = el('mode-preview');
  box.innerHTML = patchMeta(patch) + diffHtml(patch);
}
async function modeApply(id) {
  await http('POST', '/mode-set', modeCollect());
  const patch = await http('POST', '/mode-apply', { id, dryRun: false });
  toast(patch.changed ? '已写入 ' + patch.path : '无变化');
  loadModes();
}

// ---------- skills ----------
const LAYER_NAMES = { 'project-dsh': '项目自定义', 'user-dsh': '用户自定义', 'project-agents': '项目官方', 'user-agents': '用户官方', bundled: '内置' };
async function loadSkills() {
  let skills = [];
  try { skills = await http('GET', '/skills'); } catch { toast('无法读取技能列表', true); return; }
  const projects = state.projects.length > 0 ? state.projects : await http('GET', '/projects');
  const editable = skills.filter(s => s.editable);
  const official = skills.filter(s => !s.editable);
  let html = '<div class="card"><h2>新增技能 (写入 SKILL.md)</h2>'
    + '<div class="row"><select id="sk-layer"><option value="user-dsh">用户自定义 ~/.dsh/skills</option>'
    + projects.map(p => '<option value="project-dsh" data-pid="' + esc(p.id) + '">项目 ' + esc(p.id) + ' .dsh/skills</option>').join('')
    + '</select></div>'
    + '<div class="row" style="margin-top:8px"><input type="text" id="sk-name" class="grow" placeholder="技能名(kebab-case, 如 dsh-code-review)"></div>'
    + '<input type="text" id="sk-desc" placeholder="description(frontmatter, 必填)" style="margin-top:8px">'
    + '<input type="text" id="sk-when" placeholder="whenToUse(可选的触发时机提示)" style="margin-top:8px">'
    + '<textarea id="sk-content" placeholder="SKILL.md 正文(Markdown)…" style="margin-top:8px"></textarea>'
    + '<div class="row" style="margin-top:8px"><button class="act" onclick="skillCreate()">创建</button></div></div>';
  html += skillGroupHTML('可管理的技能', editable, true);
  html += skillGroupHTML('官方 / 只读技能', official, false);
  html += '<div id="sk-detail"></div>';
  el('tab-skills').innerHTML = html;
}
function skillGroupHTML(title, list, editable) {
  if (list.length === 0) return '<div class="card"><h2>' + title + '</h2><p class="muted">(空)</p></div>';
  let html = '<div class="card"><h2>' + title + ' (' + list.length + ')</h2>';
  for (const s of list) {
    const pid = esc(String(s.pid ?? ''));
    const badge = LAYER_NAMES[s.layer] ? '<span class="badge">' + LAYER_NAMES[s.layer] + '</span>' : '';
    html += '<div class="entry">'
      + '<div class="bar"><span class="title">' + esc(s.name) + '</span> ' + badge
      + '<span class="grow"></span>'
      + '<button class="ghost" onclick="skillRead(\\'' + esc(s.name) + '\\',\\'' + esc(s.layer) + '\\',\\'' + pid + '\\')">查看 / 编辑</button>'
      + (editable ? '<button class="danger" onclick="skillRemove(\\'' + esc(s.name) + '\\',\\'' + esc(s.layer) + '\\',\\'' + pid + '\\')">删除</button>' : '')
      + '</div><p class="meta" style="margin:4px 0 0">' + esc(s.description) + '</p>'
      + '<p class="meta">' + esc(s.path) + '</p>'
      + '</div>';
  }
  return html + '</div>';
}
function skillCollect() {
  const sel = el('sk-layer');
  const pid = sel.selectedOptions[0] && sel.selectedOptions[0].dataset.pid;
  return {
    layer: sel.value,
    projectId: pid,
    name: el('sk-name').value.trim(),
    description: el('sk-desc').value.trim(),
    whenToUse: el('sk-when').value.trim() || undefined,
    content: el('sk-content').value,
  };
}
async function skillCreate() {
  const input = skillCollect();
  if (!input.name) { toast('技能名不能为空', true); return; }
  try { await http('POST', '/skill-create', input); toast('已创建'); loadSkills(); }
  catch (e) { toast(String(e.message || e), true); }
}
async function skillRead(name, layer, projectId) {
  const data = await http('POST', '/skill-read', { name, layer });
  const box = el('sk-detail');
  box.innerHTML = '<div class="card"><h2>技能 <code>' + esc(name) + '</code>'
    + (data.editable ? '' : ' <span class="badge warn">只读</span>')
    + '</h2><p class="meta">' + esc(data.path) + ' · ' + esc(data.layer) + '</p>'
    + '<input type="text" id="sk-e-name" class="grow" value="' + esc(data.name) + '"' + (data.editable ? '' : ' disabled') + '>'
    + '<input type="text" id="sk-e-desc" value="' + esc(data.description) + '" style="margin-top:8px"' + (data.editable ? '' : ' disabled') + '>'
    + '<input type="text" id="sk-e-when" value="' + esc(data.whenToUse || '') + '" placeholder="whenToUse" style="margin-top:8px"' + (data.editable ? '' : ' disabled') + '>'
    + '<textarea id="sk-e-content" style="margin-top:8px" ' + (data.editable ? '' : ' disabled') + '>' + esc(data.content) + '</textarea>'
    + (data.editable ? '<div class="row" style="margin-top:8px"><button class="act" onclick="skillUpdate(\\'' + esc(layer) + '\\',\\'' + esc(projectId) + '\\')">保存修改</button></div>' : '')
    + '</div>';
  box.scrollIntoView({ behavior: 'smooth' });
}
function collectEdit() {
  return {
    name: el('sk-e-name').value.trim(),
    description: el('sk-e-desc').value.trim(),
    whenToUse: el('sk-e-when').value ? el('sk-e-when').value.trim() : undefined,
    content: el('sk-e-content').value,
  };
}
async function skillUpdate(layer, projectId) {
  const input = collectEdit();
  try { await http('POST', '/skill-update', { ...input, layer, projectId }); toast('已保存'); loadSkills(); }
  catch (e) { toast(String(e.message || e), true); }
}
async function skillRemove(name, layer, projectId) {
  try { await http('POST', '/skill-remove', { name, layer, projectId }); toast('已删除'); loadSkills(); }
  catch (e) { toast(String(e.message || e), true); }
}
async function skillToggle(name, layer, projectId, field, turnOn) {
  const body = { name, layer, ...(projectId ? { projectId } : {}), [field]: turnOn === '1' };
  try { await http('POST', '/skill-invocation', body); toast('已更新'); loadOverview(); }
  catch (e) { toast(String(e.message || e), true); }
}

// ---------- backup ----------
function loadBackup() {
  el('tab-backup').innerHTML = '<div class="card"><h2>备份 / 恢复</h2>'
    + '<p class="meta">仓库目录: <code>' + (state.status ? esc(state.status.storeDir) : '…') + '</code></p>'
    + '<div class="row"><button class="act" onclick="exportJson()">导出仓库 JSON</button>'
    + '<button class="ghost" onclick="backupDownload()">下载为文件</button></div>'
    + '<p class="meta" style="margin-top:10px">恢复(整体替换当前仓库, 请先导出):</p>'
    + '<textarea id="restore-json" placeholder="粘贴导出的 JSON…" style="min-height:120px"></textarea>'
    + '<div class="row" style="margin-top:8px"><button class="ghost" onclick="restoreJson()">从粘贴内容恢复</button></div></div>';
}
async function exportJson() {
  const data = await http('GET', '/export');
  el('restore-json').value = JSON.stringify(data, null, 2);
  toast('已导出到下方文本框');
}
function backupDownload() {
  const ta = el('restore-json');
  if (!ta.value) { exportJson().then(() => backupDownload()); return; }
  const blob = new Blob([ta.value], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'kmanager.prompts.backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
async function restoreJson() {
  const json = el('restore-json').value;
  if (!json.trim()) { toast('没有可恢复的内容', true); return; }
  await http('POST', '/restore', { json });
  toast('已恢复');
  loadEverything();
}

// ---------- tab wiring ----------
function switchTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabs-inner').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'overview') loadOverview();
  if (name === 'global') loadGlobal();
  if (name === 'projects') loadProjects();
  if (name === 'modes') loadModes();
  if (name === 'skills') loadSkills();
  if (name === 'backup') loadBackup();
}
async function loadEverything() {
  state.status = await http('GET', '/status');
  switchTab('overview');
}
// Auto-sync: every 100ms write the current store to the target files, so edits
// land without a manual "apply" step. Chained so overlapping runs never pile up.
let syncing = false;
async function autoSync() {
  if (syncing) return;
  syncing = true;
  try {
    const patches = await http('POST', '/apply', { dryRun: false });
    const dirty = patches.filter(p => p.written);
    if (dirty.length > 0) {
      const status = await http('GET', '/status');
      state.status = status;
    }
  } catch { /* transient; next tick retries */ }
  syncing = false;
}
setInterval(autoSync, 100);
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
// Support for embedding: close the host page when a close message arrives.
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'prompt-kmanager-close') {
    if (window.top === window.self) window.close();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && window.top !== window.self) {
    parent.postMessage({ type: 'prompt-kmanager-close' }, '*');
  }
});
loadEverything();
</script>
</body>
</html>`

/**
 * Serve the prompt manager page.
 * @returns the exact route to register on the Host web server.
 */
export function createPromptsPageRoute(): { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void } {
  return {
    kind: 'exact',
    path: PROMPTS_PAGE_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    },
  }
}