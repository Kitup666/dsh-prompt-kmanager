/**
 * Browser half of `@deepseek-ai/dsh-prompt-kmanager` (`dsh.client` dual face).
 * Loaded by the web boot graph through the host's client-modules scan, then
 * activated as a cordis fiber with `slots` injected. Registers one
 * `sidebar.footer.action` list entry so the button renders above the Settings
 * row inside the sidebar foot (the shell declares that hole already).
 *
 * The bundle externalizes the standard kit (react, slots service) and inlines
 * nothing shared: this half owns only its button + modal chrome; the manager
 * page itself is the standalone `/prompts` HTML document.
 */

import { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** entry id for the footer action list slot (distinct from the page route). */
const ACTION_ID = 'prompt-kmanager'
const PAGE_PATH = '/prompts'

/** Services required by the plugin's client half. */
export const inject = ['slots']

/**
 * Footer action: opens the prompt manager in a floating modal (reuses the
 * standalone /prompts page via an iframe, so the browser half owns no UI).
 * @param props - owner share from the sidebar shell (column width state).
 */
export function PromptKManagerAction({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState(false)
  // Close on Escape or a close request from inside the iframe page.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'prompt-kmanager-close') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMessage)
    }
  }, [open])

  // The footer action hole is a horizontal flex, so co-registered full-width
  // entries (e.g. the cordis panel) overlap instead of stacking. The shell
  // exposes every slot as an addressable element (`data-slot`) for exactly
  // this: tweak the anchor to a vertical stack while the sidebar is expanded.
  useEffect(() => {
    const anchor = document.querySelector('[data-slot="sidebar.footer.action"]')
    if (!anchor) return
    anchor.setAttribute('data-pk-stack', wide ? 'wide' : 'rail')
    const style = document.createElement('style')
    style.textContent = `
      [data-slot="sidebar.footer.action"][data-pk-stack="wide"] {
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        width: 100% !important;
      }
    `
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [wide])

  return <>
    <button
      type="button"
      title="提示词管理"
      aria-label="提示词管理"
      onClick={() => setOpen(true)}
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: 8,
        width: wide ? 'calc(100% + 8px)' : 36,
        height: wide ? 34 : 36,
        margin: wide ? '4px -4px 4px' : '8px 0 10px',
        padding: wide ? '6px 2px 6px 10px' : 0,
        boxSizing: 'border-box',
        border: 'none',
        borderRadius: wide ? 12 : '50%',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 14,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.backgroundColor = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' }}
      onMouseLeave={(event) => { event.currentTarget.style.backgroundColor = 'transparent' }}
    >
      <span aria-hidden style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: wide ? 16 : 18, height: wide ? 16 : 18 }}>
        <svg viewBox="0 0 24 24" width={wide ? 16 : 18} height={wide ? 16 : 18}>
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8.2a2.5 2.5 0 0 1-2.5 2.5H9.3l-3.9 3.4c-.5.44-1.4.1-1.4-.56V5.5z" fill="currentColor" />
          <path d="M7.5 7.6h9M7.5 11.2h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </svg>
      </span>
      {wide && <span>提示词管理</span>}
    </button>
    {open && (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="提示词管理"
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,.55)',
          padding: 32,
        }}
      >
        <div
          onClick={(event) => { event.stopPropagation() }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: 'min(1080px, 92vw)',
            height: 'min(780px, 86vh)',
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--dsw-surface, #17181c)',
            color: 'var(--dsw-text, #ececf1)',
            boxShadow: '0 12px 40px rgba(0,0,0,.45)',
          }}
        >
          <iframe
            src={PAGE_PATH}
            title="提示词管理"
            style={{ flex: 1, width: '100%', border: 'none', background: '#0f1012' }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: '8px 12px',
              borderTop: '1px solid var(--dsw-alias-border-subtle, #26282e)',
            }}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                border: '1px solid var(--dsw-alias-border-subtle, #3a3d45)',
                background: 'transparent',
                color: 'inherit',
                borderRadius: 8,
                padding: '5px 14px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 13,
              }}
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    )}
  </>
}

/**
 * Register the footer action once ui-sidebar declares the hole. Activation
 * order is unconstrained, so the slot is waited on through inject().
 * @param ctx - client root context with the injected slots service.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: ACTION_ID, order: 0 }, PromptKManagerAction))
}