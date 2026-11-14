# Padbear

**AI-assisted semantic layout overlay inspector & AST/code mutation framework.**

Padbear paints labeled, color-coded overlays over every live spacing region
of a web page — each side of each element's **padding**, **margin**, every
**flex/grid gap**, and every **corner radius** — and assigns each region a
deterministic ID (`p_1`, `m_41`, `g_2`, `r_9`). The canvas stays clean —
hovering an element reveals its spacing bands and value badges (plus a zoom
lens for tiny elements) and fills the panel's Inspector with every region and
token match, while Alt+drag measures any area. A human quotes an ID and tells
an AI agent:

> "Change p_13 to 4px."

The agent traces that ID back to the source file, reconciles the requested
value against the project's **token dictionary**, and swaps in the proper
abstraction — Tailwind class, CSS variable, Sass variable, Dart constant —
**never a hardcoded raw pixel string** when a token exists.

```
┌─────────────┐  region IDs   ┌──────────────┐  token match  ┌─────────────────┐
│ Overlay     │ ────────────▶ │ AI agent     │ ────────────▶ │ Source mutation  │
│ (Module 1)  │  + snapshot   │ (Module 3)   │  (Module 2)   │ per stack rules  │
└─────────────┘               └──────────────┘               │ (Module 4)       │
                                                             └─────────────────┘
```

## Repository layout

| File | Module | What it is |
|---|---|---|
| `index.html` | **1** (+ demo) | Single-file deployable playground: full client-side tagging & overlay canvas engine inline, plus a demo app and a live command console that executes the reconciliation loop. |
| `padbear-npm/schemas/padbear-token-dictionary.schema.json` | **2** | Strict JSON Schema (draft 2020-12) for the token dictionary. |
| `padbear-npm/padbear.tokens.json` | **2** | Example populated dictionary: CSS variables, Tailwind scale, structured tokens with naming conventions & boundaries. |
| `padbear-npm/skill.md` | **3** | The LLM agent system prompt: ID grammar, ID tracing algorithm, smart token reconciliation loop, collision-avoidance rules, **framework install/uninstall (§6.4)**, output contract, worked examples. |
| `docs/framework-matrix.md` | **4** | Extraction & mutation strategies + implementation code for Tailwind+React, Vue, SCSS/CSS Modules, and Flutter/Dart. |
| `padbear-npm/padbear-engine.js` | **1** | Standalone engine build (auto-extracted — `node tools/extract-engine.mjs`) for injecting into any page. v0.2.0 renamed it from `padbear.js` so it can never shadow the `padbear` CLI command on Windows. See [`docs/try-on-another-project.md`](docs/try-on-another-project.md). |

## Quick start

```bash
# local
npx serve .            # or: python -m http.server
# → open http://localhost:3000

# deploy (Cloudflare Pages — it's one static file)
npx wrangler pages deploy .
```

## Install into any project

```bash
npx padbear init          # run inside your project root
```

Copies `padbear-engine.js` into your static dir (`public/`, `static/`, `www/`…),
tags `index.html` with a dev-only `<script data-padbear>` line, and installs
the `padbear` mutation skill into `.agents/skills/` for AI agents working in
that repo. Reload your dev server — the panel appears top-right.

- **It must be served over HTTP.** `init` writes
  `<script src="/padbear-engine.js">`, a root-absolute path. Opening
  `index.html` as `file://` makes the browser look for
  `file:///padbear-engine.js`, so the script 404s and no panel appears. Run
  any static server (`python -m http.server 8000`, `npx serve .`) and open
  `http://localhost:8000/index.html`.
- **No `public/` / `static/` / `www/`?** `padbear-engine.js` lands in the
  project root and the tag still says `/padbear-engine.js` — so serve the
  project root as the web root. For `file://` use, change the tag to
  `src="./padbear-engine.js"`.
- **Why not `padbear.js`?** v0.2.0 renamed the engine file: on Windows,
  cmd.exe resolves commands from the current directory first, so a project
  file named `padbear.js` shadows the `padbear` CLI command and `npx padbear
  init` in-place would execute the engine through the `.js` file association
  instead. Installing over a v0.1.x project migrates the old script tag and
  deletes the old engine automatically.
- **Next.js / no `index.html`:** add `<Script src="/padbear-engine.js" strategy="beforeInteractive" />` in `app/layout.tsx`.
- **Tokens:** `init` does not generate the dictionary. If the project already
  defines spacing as CSS custom properties (`--space-*`, `--s-*`…) or a
  Tailwind scale, derive `padbear.tokens.json` from that (schema:
  `padbear-npm/schemas/padbear-token-dictionary.schema.json`) rather than
  starting empty, then call `Padbear.loadTokens('/padbear.tokens.json')` so
  the overlay can annotate token names and suggest substitutions.
- **SPA route changes:** re-run `Padbear.scan()` in the console (no auto-rescan).
- **Re-running is a no-op:** `init` only writes a file whose contents actually
  changed, so a second run touches nothing — no dev-server reload, and no
  editor window reload from a rewritten `.agents/skills/**/SKILL.md`.

**Where the files land.** `init` picks the first of `public/`, `static/`,
`www/`, `src/public/` that exists (else the project root), and inserts the tag
into the first of `index.html`, `src/index.html`, `public/index.html`,
`app/index.html` that exists. Override the destination with `--static <dir>`.

| Project | Engine | `<script>` tag | |
|---|---|---|---|
| Vite, CRA, plain static | `public/` or root | `index.html` | ✅ automatic |
| Static site with the homepage under `www/` | `www/` | — not detected | ⚠️ add by hand |
| Angular (`src/index.html`) | project root | `src/index.html` | ⚠️ pass `--static src` |
| Next.js, Nuxt, SvelteKit, Laravel | `public/` | — no `index.html` | ⚠️ add by hand, see `skill.md` §6.4 |
| Flutter web | — | — | ❌ draws to canvas, nothing to measure |

Full per-framework recipes (and the exact line to remove again) live in
`padbear-npm/skill.md` §6.4, which `init` installs into
`.agents/skills/padbear/`.

```bash
npx padbear remove        # clean uninstall — removes exactly what init added
```

To **update** an installed overlay, re-run init with the latest version:

```bash
npx padbear update        # re-runs init from padbear@latest, same options apply
```

`npm update padbear` won't help — the engine is a **copy** in your static
folder, not a dependency.

## Handing region IDs to an agent

Region IDs live in the page, not on disk. An agent with shell access but no
browser cannot resolve `p_13` by itself: the region registry is built in
memory by `scan()` from real computed styles, and the only persistence is
`sessionStorage`, scoped to the tab that allocated it. You have to serialize
the join key.

**Whole snapshot** — writes `padbear-snapshot.json` to your Downloads folder,
then move it into the repo:

```js
Padbear.export()
```

**Just the records you were asked about** — copy them from the console:

```js
copy(JSON.stringify(
  Padbear.snapshot().regions.filter(r => ['p_13', 'm_8'].includes(r.id)),
  null, 2))
```

Paste that into the chat, or save it as `padbear-snapshot.json` in the repo.
Each record carries `id`, `property`, `valuePx`, `cssValue`, the detected
`token`, and the element hint (`tag`, `id`, `classes`, `path`) the agent needs
to locate the source block.

A snapshot is only valid for the engine build and DOM state that produced it —
re-export after structural changes or after swapping `padbear-engine.js`.

## Using the playground

1. Open the page — the overlay engine scans `#padbear-stage` immediately.
   - 🟪 purple/striped = padding · 🟥 coral = margin · 🟩 sage/dashed = gap ·
     🟨 lime = corner radius (`r_<n>`, one per rounded corner)
     (brand palette: core `#A580BB`, padding `#A580BB`, margin `#EC8F94`,
     gap `#B7DB9E`, radius `#CDD87B`)
   - **Hover any element** → its spacing appears in place: translucent
     padding/margin/gap/radius bands (purple, coral, sage, lime) with
     solid pill badges showing each region's ID (`p_20`), plus guide lines
     along its four edges. Move away and it's gone — the page stays clean by
     default. Hovering a badge reveals its value and token match; click it to
     copy the ID. The panel's
     **Inspector** section lists every region of the hovered element with
     its px value, its token match (`p_20 32px ⇒ var(--space-6)`) and a
     `raw` marker where no token matches. For very small elements a **zoom
     lens** floats beside them with a scaled (up to 3×) static replica plus
     its bands and badges.
   - **Alt+drag over an area** → **marquee scope**: every measured element
     intersecting the rect gets a purple outline and contributes its own
     records, clipped to the marquee — with the dashed marquee box + live
     `W × H` size chip left on screen. These badges are outlined chips that
     print the measured **value** — visually distinct from hover mode's solid
     ID badges — and the quoteable region ID stays in each tooltip and on
     click-to-copy. The scope survives mouse-out,
     rescans, and framework re-renders (region IDs re-resolve through the
     registry). **Esc** clears (a new drag replaces the scope). Plain
     clicks are never intercepted.
2. Use the panel (top-right) — a dark frosted-glass command palette: region
   toggles with live counts (they re-measure immediately, gating what hover
   and Alt+drag show), a Rescan action row, built-in "how to inspect" hints
   (hover for names, Alt+drag for measurements), a persistent **Inspector**
   readout of the last hovered element, and key hints in the footer. The
   panel is draggable and collapses to a header pill. Snapshots are
   programmatic (`Padbear.export()`) — the panel has no download button.
3. Commands (the Module 3 loop) run programmatically — the panel has no
   console surface:
   ```js
   Padbear.exec('help')             // list commands
   Padbear.exec('find mb')          // list matching region IDs
   Padbear.exec('set p_1 16px')     // exact token match → var(--space-4)
   Padbear.exec('set p_1 p-2')      // named token → substitutes directly
   Padbear.exec('set p_1 17px')     // no exact token → warns, suggests nearest,
                                 // applies raw px flagged for review
   Padbear.exec('export')           // download snapshot JSON
   ```
4. The **Legacy card** in the demo grid uses hardcoded `17px 21px` — run a
   `set` against one of its `p*` region IDs with `16px` to watch it get token-ized.

## Programmatic API

```js
Padbear.scan()                 // re-measure + repaint (IDs are stable)
Padbear.toggle('gap', false)   // show/hide a kind (re-measures immediately)
Padbear.clearSelection()       // clear the active marquee scope
Padbear.setTarget(el)          // inspect a different subtree
Padbear.snapshot()             // region snapshot object (JSON-ready)
Padbear.export()               // download padbear-snapshot.json
Padbear.applyChange(id, val)   // run the reconciliation loop
Padbear.loadTokens(url)        // swap in an external padbear.tokens.json
Padbear.setTokens(dict)        // set the dictionary programmatically
Padbear.registry               // Map<id, region record>
```

## Agent workflow (summary)

Full detail in [`skill.md`](padbear-npm/skill.md):

1. **Trace** — snapshot record → element hint (tag/#id/.classes/DOM path) →
   source block, following the per-stack strategies in
   [`docs/framework-matrix.md`](docs/framework-matrix.md).
2. **Reconcile** — requested px → exact token in the dictionary → substitute;
   else propose nearest token or a new (boundaries-respecting) token; raw px
   only with explicit approval, flagged `PADBEAR-RAW`.
3. **Avoid collisions** — impact-check the class/variable/constant across the
   repo; shared state gets isolated, not edited in place.
4. **Verify** — rescan the overlay; assert the delta and report per contract.

## Notes & limits

- The engine reads computed styles, so it works on any stack that renders to
  the DOM; Flutter uses the analyzer-based index in Module 4 instead.
- Auto and negative margins are not painted (documented in Module 1).
- IDs persist per session via `sessionStorage`, keyed by structural DOM path —
  a stable DOM yields stable IDs; always rescan after structural changes.
- The overlay never mutates host layout: one document layer, `pointer-events:none`
  (only the value badges take pointer events; the panel and zoom lens are
  separate fixed elements).
