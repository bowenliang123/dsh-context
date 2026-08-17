/**
 * Theme-native styles, injected as a plugin-owned <style> tag (the web boot
 * loader claims and removes tags carrying data-plugin on unload).
 */

export const STYLES = [
  '.lc-root { padding: 16px 20px 32px; overflow-y: auto; height: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }',
  '.lc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }',
  '.lc-card-title { font-weight: 600; margin-bottom: 10px; display: flex; align-items: baseline; gap: 8px; }',
  '.lc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 8px; }',
  '.lc-stat { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
  '.lc-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.lc-stat-value { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }',
  '.lc-stat-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.lc-card-sub { font-weight: 400; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
  '.lc-gran, .lc-kinds { margin-left: auto; display: flex; gap: 2px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 1px; }',
  '.lc-gran-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; padding: 3px 8px; border-radius: 5px; cursor: pointer; font-family: inherit; }',
  '.lc-gran-btn:hover { color: var(--dsw-alias-label-primary); }',
  '.lc-gran-on, .lc-gran-on:hover { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }',
  '.lc-overview-num { margin-bottom: 8px; }',
  '.lc-overview-num b { font-size: 20px; }',
  '.lc-overview-num span { color: var(--dsw-alias-label-secondary); }',
  '.lc-stacked-wrap { position: relative; width: 100%; }',
  '.lc-stacked { display: flex; width: 100%; border-radius: 5px; overflow: hidden; background: rgba(128,128,128,0.18); position: relative; }',
  // Hover reference frame around the OCCUPIED region of the composition bar:
  // dashes from the left edge to the used/window boundary, so the legend's
  // "share of used" percentages visibly map to the boxed part (the free track
  // sits outside it). pointer-events: none keeps hover on the segments/free.
  // Deliberately high-contrast (label-primary) and thick so the frame reads at
  // a glance, and the other parts dim underneath it (`.lc-stacked-dim`).
  '.lc-occupied-box { position: absolute; top: 0; bottom: 0; left: 0; border: 2px dashed var(--dsw-alias-label-primary); border-radius: 5px; box-sizing: border-box; pointer-events: none; opacity: 1; box-shadow: 0 0 0 1px var(--dsw-alias-bg-layer-2); }',
  '.lc-bar-tip { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5; white-space: nowrap; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; font-size: 12px; color: var(--dsw-alias-label-primary); box-shadow: 0 2px 8px rgba(0,0,0,0.18); pointer-events: none; }',
  '.lc-stacked > div { height: 100%; }',
  '.lc-stacked-seg-on { filter: brightness(1.18); }',
  '.lc-stacked-free-on { box-shadow: inset 0 0 0 1px var(--dsw-alias-label-secondary); border-radius: 3px; }',
  // Hover focus: everything except the hovered part (segment, legend chip, or
  // free track) recedes, so the composition highlight and the occupied-region
  // frame read clearly. The selected segment/free keeps full opacity.
  '.lc-stacked-dim .lc-stacked-seg { opacity: 0.35; }',
  '.lc-stacked-dim .lc-stacked-seg-on { opacity: 1; }',
  '.lc-stacked-dim .lc-stacked-free { opacity: 0.35; }',
  '.lc-stacked-dim .lc-stacked-free-on { opacity: 1; }',
  '.lc-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; }',
  '.lc-chip { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-primary); }',
  '.lc-chip i, .lc-detail-row i, .lc-node i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }',
  '.lc-chip em { font-style: normal; color: var(--dsw-alias-label-secondary); }',
  '.lc-chip-on { font-weight: 600; }',
  '.lc-chip-on i { box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }',
  '.lc-tools { margin-top: 10px; color: var(--dsw-alias-label-secondary); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
  '.lc-tool-chip { background: var(--dsw-alias-bg-layer-2); border-radius: 4px; padding: 1px 7px; font-size: 12px; color: var(--dsw-alias-label-primary); }',
  '.lc-chartrow { display: flex; gap: 6px; align-items: stretch; }',
  '.lc-axis { position: relative; width: 40px; height: 150px; padding-top: 18px; box-sizing: border-box; color: var(--dsw-alias-label-secondary); font-size: 11px; }',
  '.lc-axis span { position: absolute; right: 0; line-height: 1; }',
  '.lc-axis-top { top: 13px; }',
  '.lc-axis-mid { top: 69px; }',
  '.lc-axis-bot { top: 125px; }',
  '.lc-chart-scroll { position: relative; flex: 1; overflow-x: auto; overflow-y: hidden; min-width: 0; scrollbar-width: thin; }',
  '.lc-chart-fade { position: absolute; top: 0; bottom: 0; width: 26px; pointer-events: none; z-index: 2; }',
  '.lc-chart-fade-l { left: 0; background: linear-gradient(to right, var(--dsw-alias-bg-layer-1), transparent); }',
  '.lc-chart-fade-r { right: 0; background: linear-gradient(to left, var(--dsw-alias-bg-layer-1), transparent); }',
  '.lc-chart { position: relative; display: flex; align-items: flex-end; gap: 2px; height: 130px; padding-top: 18px; box-sizing: border-box; width: max-content; min-width: 100%; }',
  '.lc-grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--dsw-alias-border-l1); pointer-events: none; }',
  '.lc-grid-top { top: 18px; }',
  '.lc-grid-mid { top: 74px; }',
  '.lc-bar { position: relative; width: 14px; flex: none; height: 100%; display: flex; align-items: flex-end; cursor: pointer; border-radius: 2px; transition: opacity 120ms ease; }',
  // Turn-aware dimming: while a turn is focused, bars OUTSIDE the active
  // turn fade to 35% and the whole current turn stays fully opaque.
  '.lc-chart-dim .lc-bar { opacity: 0.35; }',
  '.lc-chart-dim .lc-bar-in-turn { opacity: 1; }',
  '.lc-chart-dim .lc-turn { opacity: 0.35; }',
  '.lc-chart-dim .lc-turn-on { opacity: 1; }',
  '.lc-chart-tip { position: absolute; top: 0; transform: translateX(-50%); z-index: 5; white-space: nowrap; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; font-size: 12px; color: var(--dsw-alias-label-primary); box-shadow: 0 2px 8px rgba(0,0,0,0.18); pointer-events: none; }',
  '.lc-bar:hover { background: var(--dsw-alias-bg-layer-2); }',
  '.lc-bar-selected { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
  '.lc-bar-hovered { outline: 1px dashed var(--dsw-alias-brand-primary); outline-offset: 1px; }',
  '.lc-bar-in-turn { background: rgba(99,102,241,0.14); }',
  '.lc-bar-stack { display: flex; flex-direction: column-reverse; width: 100%; }',
  '.lc-bar-stack > div { width: 100%; }',
  '.lc-bar-marker { position: absolute; top: -16px; left: 50%; transform: translateX(-50%); font-size: 11px; color: var(--dsw-alias-state-warn-primary); }',
  '.lc-turns { display: flex; gap: 2px; width: max-content; min-width: 100%; margin-top: 4px; }',
  '.lc-turn { flex: none; box-sizing: border-box; text-align: center; font-size: 10px; line-height: 14px; font-weight: 600; color: #fff; border-radius: 3px; height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; transition: filter 120ms, opacity 120ms; }',
  '.lc-turn-on { filter: brightness(1.35); box-shadow: 0 0 0 1px rgba(255,255,255,0.4); }',
  '.lc-detail { margin-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; }',
  '.lc-detail-head { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 8px; color: var(--dsw-alias-label-secondary); }',
  '.lc-detail-head b { color: var(--dsw-alias-label-primary); }',
  '.lc-detail-marker { color: var(--dsw-alias-state-warn-primary); font-size: 11px; background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 1px 7px; }',
  '.lc-detail-head .lc-actual { color: var(--dsw-alias-state-success-primary); }',
  '.lc-detail-tag { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
  '.lc-detail-rows { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; }',
  '.lc-detail-row { display: flex; align-items: center; gap: 8px; }',
  '.lc-detail-label { min-width: 70px; white-space: nowrap; color: var(--dsw-alias-label-secondary); }',
  '.lc-bar-track { flex: 1; height: 5px; border-radius: 3px; background: rgba(128,128,128,0.18); overflow: hidden; display: block; }',
  '.lc-bar-fill { display: block; height: 100%; border-radius: 3px; }',
  '.lc-detail-num { width: 44px; text-align: right; }',
  '.lc-detail-pct { width: 34px; text-align: right; color: var(--dsw-alias-label-secondary); }',
  '.lc-cols { display: flex; gap: 14px; flex-wrap: wrap; }',
  '.lc-col { flex: 1; min-width: 280px; }',
  // Head row: stats board + plugin info sit side by side under the shared
  // `lc-cols` flex — stats takes ~7/10 of the row, plugin info ~3/10, both
  // wrap onto their own line when the available width falls below each card's
  // min-width (so a narrow viewport keeps both readable). Both children are
  // `.lc-card` themselves (rendered by StatsBoard / PluginInfo); the flex
  // sizing lives on the head row's direct children so the existing card
  // chrome doesn't change.
  '.lc-head > .lc-card { margin-bottom: 0; }',
  '.lc-head > .lc-card:first-child { flex: 7 1 0; min-width: 360px; }',
  '.lc-head > .lc-card:last-child { flex: 3 1 0; min-width: 220px; }',
  // Plugin info: two full-width rows (Plugin / GitHub), each one horizontal
  // line with the label on the left and the value on the right — a compact
  // definition list rather than a multi-cell grid.
  '.lc-pi-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }',
  // The row IS the link: an `<a>` with the label + value on one baseline.
  // Hovering a row underlines its value — the only hover affordance.
  '.lc-pi-row { display: flex; flex-direction: row; justify-content: space-between; align-items: baseline; gap: 12px; min-width: 0; text-decoration: none; color: inherit; }',
  '.lc-pi-row:hover .lc-pi-value { text-decoration: underline; }',
  // Upgrade chip appended to the Plugin value when the npm registry has a
  // newer version than the baked-in one.
  '.lc-pi-update { color: var(--dsw-alias-state-warn-primary); font-size: 11px; margin-left: 6px; white-space: nowrap; }',
  '.lc-pi-label { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  // min-width: 0 lets the value shrink inside the flex row and truncate with
  // an ellipsis; without it a narrow card pushes the value over the label.
  '.lc-pi-value { min-width: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }',
  '.lc-events, .lc-nodes { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }',
  '.lc-event { display: flex; align-items: center; gap: 8px; padding: 3px 0; }',
  '.lc-event-icon { width: 18px; text-align: center; color: var(--dsw-alias-state-warn-primary); }',
  '.lc-event-icon.lc-event-inject { color: #a855f7; }',
  '.lc-event-icon.lc-event-model { color: var(--dsw-alias-brand-primary); }',
  // Kind chip: the event classification at a glance; the tint matches the
  // impact direction (inject = adds context, compaction/prune = frees it,
  // model switch = neutral), mirroring the token sign colors below.
  '.lc-kind { flex: none; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; white-space: nowrap; }',
  '.lc-kind-inject { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent); color: var(--dsw-alias-state-success-primary); }',
  '.lc-kind-compaction { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent); color: var(--dsw-alias-state-error-primary); }',
  '.lc-kind-prune { background: color-mix(in srgb, #8b5cf6 15%, transparent); color: #8b5cf6; }',
  '.lc-kind-model { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent); color: var(--dsw-alias-brand-primary); }',
  '.lc-event-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.lc-event-at { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }',
  '.lc-event-tokens { color: var(--dsw-alias-state-success-primary); font-weight: 600; white-space: nowrap; }',
  '.lc-event-tokens.lc-up { color: var(--dsw-alias-state-warn-primary); }',
  '.lc-event-time { color: var(--dsw-alias-label-secondary); font-size: 12px; }',
  '.lc-node { display: flex; align-items: center; gap: 8px; padding: 3px 0; }',
  '.lc-node-preview { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }',
  '.lc-node-time { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 54px; text-align: right; }',
  '.lc-node-tokens { color: var(--dsw-alias-label-secondary); }',
  '.lc-nodes-more { color: var(--dsw-alias-label-secondary); padding: 3px 0; }',
  '.lc-empty { color: var(--dsw-alias-label-secondary); padding: 18px 0; text-align: center; }',
  '.lc-foot { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 4px; }',
  // ---- /context modal (centered dialog; escapes the composer anchor via fixed positioning) ----
  '.lc-modal-backdrop { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; }',
  '.lc-modal-card { width: min(720px, calc(100vw - 48px)); max-height: min(82vh, 760px); overflow-y: auto; box-sizing: border-box; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0, 0, 0, 0.4)); padding: 16px 18px 18px; color: var(--dsw-alias-label-primary); font-size: 13px; }',
  '.lc-modal-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }',
  '.lc-modal-title { font-weight: 600; font-size: 14px; }',
  '.lc-modal-close { margin-left: auto; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; cursor: pointer; font-family: inherit; }',
  '.lc-modal-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
  '.lc-modal-trend { margin-top: 14px; }',
  // ---- Context browser card (progressive disclosure: category accordion ->
  // element rows -> per-kind content) ----
  '.lc-br-pick { margin-left: auto; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 6px; max-width: 240px; }',
  '.lc-br-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 8px; color: var(--dsw-alias-label-secondary); }',
  '.lc-br-meta b { color: var(--dsw-alias-label-primary); }',
  '.lc-br-meta .lc-actual { color: var(--dsw-alias-state-success-primary); }',
  '.lc-br-note { margin-top: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
  '.lc-br-cats { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }',
  '.lc-br-cat { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }',
  '.lc-br-cat-empty { opacity: 0.55; }',
  '.lc-br-cat-row { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; padding: 7px 10px; cursor: pointer; text-align: left; }',
  '.lc-br-cat-row:hover { background: var(--dsw-alias-bg-layer-1); }',
  '.lc-br-cat-row i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; flex: none; }',
  '.lc-br-cat-label { font-weight: 600; }',
  '.lc-br-cat-count { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: 1; }',
  '.lc-br-chev { flex: none; width: 12px; color: var(--dsw-alias-label-secondary); transition: transform 120ms ease; }',
  '.lc-br-chev-on { transform: rotate(90deg); }',
  '.lc-br-tokens { flex: none; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
  '.lc-br-pct { flex: none; width: 36px; text-align: right; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
  '.lc-br-body { border-top: 1px solid var(--dsw-alias-border-l1); padding: 4px 6px; display: flex; flex-direction: column; gap: 2px; }',
  '.lc-br-elem { border-radius: 6px; }',
  '.lc-br-elem-on { background: var(--dsw-alias-bg-layer-1); }',
  '.lc-br-elem-row { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 5px 6px; cursor: pointer; text-align: left; border-radius: 6px; }',
  '.lc-br-elem-row:hover { background: var(--dsw-alias-bg-layer-1); }',
  '.lc-br-tag { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 6px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.lc-br-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.lc-br-time { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; }',
  '.lc-br-content { padding: 2px 6px 8px 26px; display: flex; flex-direction: column; gap: 6px; }',
  '.lc-br-pre { margin: 0; padding: 8px 10px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto; scrollbar-width: thin; }',
  '.lc-br-dim { color: var(--dsw-alias-label-secondary); }',
  '.lc-br-call { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }',
].join('\n')
