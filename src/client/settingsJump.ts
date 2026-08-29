/**
 * Best-effort jump to this plugin's settings page (Settings → Plugins →
 * Plugin configuration). The harness settings panel keeps its open state
 * inside the shell component — no plugin-facing open face exists — so the
 * jump drives the real chrome: click the sidebar's settings trigger, then
 * the Plugins section nav row, both found by their shipped attributes and
 * labels. EVERY step is individually guarded: a shell that doesn't match
 * (older host, different layout, missing sidebar) degrades the whole jump
 * to a silent no-op — this path must never throw into the caller's render.
 */

/** The Plugins settings section's shipped nav labels (en/zh locales). */
const SECTION_LABELS = new Set(['Plugins', '插件'])

/** Buttons the jump may operate on, in document order. */
function buttonsOf(doc: Document): HTMLButtonElement[] {
  return [...doc.querySelectorAll<HTMLButtonElement>('button')]
}

/** The sidebar's settings triggers: dialog semantics plus an expanded flag. */
function findTriggers(doc: Document): HTMLButtonElement[] {
  return buttonsOf(doc)
    .filter(b => b.getAttribute('aria-haspopup') === 'dialog' && b.hasAttribute('aria-expanded'))
}

/** The Plugins section's nav row, matched by its shipped label. */
function findSectionRow(doc: Document): HTMLButtonElement | undefined {
  return buttonsOf(doc).find(b => SECTION_LABELS.has(b.textContent.trim()))
}

export function openPluginSettings(
  doc: Document = document,
  schedule: (run: () => void, ms: number) => void = (run, ms) => { window.setTimeout(run, ms) },
): void {
  try {
    const triggers = findTriggers(doc)
    const open = triggers.find(b => b.getAttribute('aria-expanded') === 'true')
    // No dialog trigger at all: this shell has no settings panel — no-op.
    if (open === undefined && triggers.length === 0) return
    // A collapsed trigger opens the panel; an already-open one is left alone.
    triggers.find(b => b.getAttribute('aria-expanded') !== 'true')?.click()
    schedule(() => {
      try {
        findSectionRow(doc)?.click()
      } catch { /* no Plugins row on this host: stay on the opened section */ }
    }, 80)
  } catch { /* the settings surface doesn't match: silent no-op */ }
}
