---
name: padbear
description: >
  Operates the Padbear semantic spacing overlay workflow: traces
  data-padbear-id region IDs back to source files, reconciles requested pixel
  values against the project token dictionary, substitutes tokens (never raw
  px strings), and edits layout code across JSX / Vue / HTML+SCSS / Flutter
  without breaking other components. Use when the user issues commands like
  "Change p_13 to 4px" or "make g_2 bigger".
---

# Padbear — Spacing Mutation Skill

You are operating **Padbear**, a semantic layout overlay system. Every
spacing region in the rendered UI (each side of every element's padding and
margin, plus every flex/grid gap band) is painted on screen and labeled with a
**deterministic region ID** such as `p_1`, `m_41`, or
`g_2`. A human points at these regions and tells you things like:

> "Change p_13 to 4px"
> "m_41 should match the card padding"
> "g_2 feels too tight — make it 24px, tokenized"

Your job: map the ID → element → source code location, resolve the requested
value against the project's token dictionary, and mutate the **source file**
(the tokenized abstraction — class, variable, widget property — never a raw px
string when a token exists).

## 0. Mental model — three artifacts

| Artifact | Produced by | You consume it to… |
|---|---|---|
| **Region snapshot** (`padbear-snapshot.json`, or the live registry at `window.Padbear.snapshot()`) | Module 1 overlay engine | Resolve an ID to: CSS property, measured px, owning element (tag/id/classes/DOM path), and any auto-detected token match. |
| **Token dictionary** (`padbear.tokens.json`, validated by `schemas/padbear-token-dictionary.schema.json`) | Project (Module 2) | Map a requested px value to a legal named token / CSS var / Tailwind class. |
| **Source files** | Project | The place you actually edit. The snapshot's `element` hint tells you *which* file and block. |

Non-negotiable invariant: **the rendered value and the source must stay
reconciled.** After every edit, the value shown by the overlay badge must be
derivable from the dictionary.

## 1. ID grammar

```
<kind>_<serial>             e.g.  p_1, m_18, g_33, r_9
```

Four ID families — `p` (padding), `m` (margin), `g` (gap), `r` (corner
radius). The ID is an
**opaque join key into the region registry, not documentation**: the
registry/snapshot carry the full CSS property (which side, which gap band),
value, token and element for every ID, so the terse form loses nothing.
**Never infer the side from the ID** — always read the record.

| Kind | CSS properties | Notes |
|---|---|---|
| `p` | `padding-top/right/bottom/left` | Band between padding box and content box |
| `m` | `margin-top/right/bottom/left` | Band outside border box; auto/negative margins are never painted |
| `g` | `row-gap` / `column-gap` | Only on `flex`/`grid` containers. An element can have several gap bands — each is its own `g_<serial>`; the band's axis/position is in the record's `property` and rect. |
| `r` | `border-*-radius` | Corner radius, one record per rounded corner (uniform px only; ellipses/percentages are skipped). Records carry `token: null` — radius is measurement/display only, never reconciled against the spacing dictionary. |

Serials are **unpadded auto-increment integers**, assigned in document order,
persisted per session, and stable for a stable DOM. Never guess an ID that
isn't in the snapshot; if the user's ID isn't found, rescan (layout may have
changed) and report the closest match. Users may also quote the **legacy
per-side form** (`pt_13` = a padding region, serial 13, side top) — resolve
by searching the snapshot for the serial, then confirm the property from the
record; pre-2026-11 snapshots and old bookmarks may use it.

Disambiguation: Padbear IDs use **underscores** (`p_13`); Tailwind utilities
use **dashes** (`p-13`). Similar shapes, completely different things — never
write a Padbear ID into a class list or a utility into an ID lookup.

## 2. Inputs you require before mutating anything

1. **The region snapshot** — either the user pastes `padbear-snapshot.json`, or
   it is fetched from the live page (`Padbear.snapshot()`), or the user
   quotes the badge contents or the panel Inspector line (`p_12 16px`), which
   is enough to reconstruct a partial record.
2. **The token dictionary** — `padbear.tokens.json`. Validate it against the
   schema before trusting it. If it doesn't exist, do NOT invent tokens:
   first derive it from the project's own spacing sources — CSS custom
   properties (`--space-*`, `--s-*`…), a Tailwind theme/scale, or Sass maps —
   and write the result to `padbear.tokens.json`. Only STOP and ask the user
   when the project defines no spacing scale at all.
3. **Access to the source tree** for the framework in play (see §6).

On the page itself, hover reveals the hovered element's spacing bands and
value badges (the badge tooltip carries the quoteable region ID), the panel's
Inspector section lists every region of that element with its token match, and
Alt+drag measures a whole area. The snapshot always uses these same short IDs.

## 3. The ID Tracing Algorithm

Goal: from `data-padbear-id` → the exact block in the source file that produces
that spacing.

```
TRACE(id):
  1. rec := snapshot.regions.find(r => r.id == id)
     # rec = { id, kind, property, valuePx, token?, element:{tag,id,classes,path,sourceHint} }

  2. FRAMEWORK DETECTION — pick a tracing strategy by file extensions present:
       *.tsx/*.jsx + tailwind.config  → JSX/Tailwind strategy   (§6.1)
       *.vue                          → Vue SFC strategy        (§6.1)
       *.scss/*.module.css/*.css      → Stylesheet strategy     (§6.2)
       *.dart                         → Flutter strategy        (§6.3)

  3. LOCATE THE NODE
     a. PRIMARY: search the codebase for the element hint:
          tag + id (#nav) + classes (.demo-card)
        In JSX/Vue this is a literal string match on the tag/class tokens.
        Rank matches by (most class tokens matched, fewest total matches).
     b. CROSS-CHECK: the snapshot's element.path is the DOM index path
        ("body/2/1/0"). Render the app or count structurally to confirm the
        candidate is the Nth match in document order, not merely the first.
     c. If the element carries a framework debug hook (React: component name
        via DevTools, Vue: data-v-xxx scope id), prefer it over class text.

  4. LOCATE THE STYLE SOURCE — walk, in precedence order, where the measured
     `property`/`valuePx` can come from:
       1. inline style={} / style="" on the node
       2. utility classes on the node (Tailwind: p-4, m-2, gap-3 …)
       3. CSS variables in the class chain (var(--space-4))
       4. component-scoped stylesheet rule matching the node
       5. inherited/global rule (last resort — flag this as high-risk, §5)
     Confirm by matching the VALUE: the winning source must compute to
     rec.valuePx (± subpixel tolerance 0.5px). If no source matches the
     measured value, the value is likely a *consequence* (e.g. margin
     collapse, stretch) — say so instead of editing blindly.

  5. OUTPUT the trace: { id, file, line range, style source kind,
     current expression, rec.property }. Show it to the user before editing.
```

If two source candidates are equally plausible, ask the user to confirm
rather than picking one. Wrong-file edits are the worst failure mode.

## 4. Smart Token Reconciliation Loop

Trigger example: *"Change m_41 to 8px"*.

```
RECONCILE(id, requested):
  rec  := TRACE(id)
  targetPx := parse(requested)            # "8px" → 8; "--space-2" → 8; "p-2" → 8

  # --- STEP 1: what abstraction owns this property? -------------------------
  owner := classify(rec)                   # utility class | css var | token name
                                           #   | inline px | framework construct

  # --- STEP 2: dictionary lookup --------------------------------------------
  exact := DICT.findByPx(targetPx)         # any token whose value == targetPx (±0.5px)

  if exact exists:
      emit substitution for `owner` kind:              # see table below
      return report(exact)

  # --- STEP 3: no exact match — nearest-token protocol -----------------------
  nearest := DICT.nearest(targetPx)
  if |nearest.px - targetPx| <= ADJUST_TOLERANCE (default 2px):
      PROPOSE: "8px isn't on the scale; nearest is space.200 (8px? no — e.g.
      10px → nearest 8px, Δ2). Use it?"
      if user accepts: substitute nearest; return report(nearest, adjusted=true)
  else:
      PROPOSE one of, in preference order:
        a) reuse a semantically-adjacent token whose `usage` field fits
        b) declare a NEW token (only if targetPx within dictionary
           boundaries [minPx, maxPx] and follows namingConvention):
             1. add to padbear.tokens.json scale (sorted position)
             2. add the CSS variable in the project's tokens file
             3. then substitute as in STEP 2
        c) last resort ONLY with explicit user approval: write the raw px,
           and append a `// PADBEAR-RAW:` comment + a report flag so it can be
           found later by `grep "PADBEAR-RAW:"`.

  NEVER silently hardcode a raw px string. That is the single hard rule.
```

### 4.1 Substitution matrix (what literal text to write)

| Current owner | CSS/SCSS | JSX + Tailwind | Flutter/Dart |
|---|---|---|---|
| Tailwind utility class | — | swap class: `m-1` → `m-2`; keep responsive variants (`md:`) and `!` important markers intact | — |
| CSS variable | `padding-top: 16px` → `padding-top: var(--space-4)` | `style={{ paddingTop: 'var(--space-4)' }}` | not applicable |
| Structured token (no var exists) | write the `ref` from the dictionary (default: token name) or introduce the var first | prefer introducing the var | `EdgeInsets.symmetric` w/ `AppSpacing.space400` constant |
| Inline raw px | replace with var/token | replace with utility class OR var | replace with `AppSpacing` constant |
| Framework construct (gap via `space-x-*`, Flutter `SizedBox(width: 8)`) | map to nearest native equivalent | `space-x-2` → `gap-2` if flex/grid, else adjust `space-x` | `SizedBox` width/height → `AppSpacing` constant |

### 4.2 Multi-value shorthand caution

`padding: 8px 16px` is two logical targets (`pad_top/bottom` and
`pad_left/right`). When the user changes one side of a shorthand:
- Tailwind: switch the affected sides to directional utilities
  (`p-4` + user changes top → `pt-2 p-4` minus overlap → actually write
  `p-4` for unchanged sides and `pt-2` before it; prefer explicit
  `pt-2 pr-4 pb-4 pl-4` only if ≥2 sides diverge).
- CSS: expand the shorthand into longhand properties, keeping unchanged
  sides' values byte-identical.
- Never leave a stale shorthand that re-overwrites your longhand later in
  the cascade.

## 5. Collision Avoidance Rules

A class, variable, or widget constant is **shared state**. Before any edit:

```
IMPACT CHECK(edit):
  1.Enumerate the exact string being changed:
     - utility class token (e.g. p-4 as a whole token in class lists)
     - CSS selector + property
     - token name / constant
  2. SEARCH all usages:
     - Tailwind: grep -w the class token across source; also check the
       safelist in tailwind.config and any className composition helpers
       (clsx/cn templates) — dynamic strings like `p-${n}` can hide usages.
     - CSS var: grep the var name; check calc() usages that depend on it.
     - Structured token: grep token name AND its ref.
  3. CLASSIFY:
     - PRIVATE  (single component / single rule)  → edit directly.
     - SHARED   (≥2 call sites)                   → DO NOT edit in place.
  4. ISOLATION STRATEGIES for SHARED, in order of preference:
     a. Add a MORE SPECIFIC class/util on this node only
        (e.g. add `pt-2` alongside `p-4`? NO — conflicts; instead use a
        one-off override class or `[padding-top:var(--space-2)]` arbitrary
        property in Tailwind, still token-referencing).
     b. Introduce a new semantic class with a scoped rule, value = token.
     c. Prop-level override in the component (React prop / Vue prop),
        defaulting to the shared token.
  5. VERIFY: after edit, re-render + rescan the overlay; confirm:
     - target region now shows requested px and the expected token badge
     - all OTHER regions with the same original ID set are unchanged
     - no new visual regressions at the same DOM path.
```

Additional hard guards:
- Never edit a design-token *definition* to satisfy one component. Adding a
  token is allowed (§4 STEP 3b); redefining one is not.
- Never remove a class/property that other selectors depend on (e.g.
  removing `p-4` where it also affects a child via `> *` rules).
- Media-query / container-query variants: changes must be applied inside the
  same breakpoint context the user is looking at. Ask which breakpoints the
  request applies to if the node has responsive variants.
- Margin collapse: if `margin-top` of a child and `margin-bottom` of a parent
  collapse, changing one may not change the overlay. Detect, explain, and
  edit the winning margin.

## 6. Framework Adaptability Matrix (operational summary)

Full implementation guide with code: `docs/framework-matrix.md` in the Padbear
repository (not shipped in this package).

### 6.1 Tailwind + React (JSX/TSX) & Vue SFC
- Trace: string-match the tag + class tokens; utilities ARE the style source.
- Substitute: replace utility tokens `p-1`→`p-2`, `gap-3`→`gap-4`, `mt-2`→`mt-3`.
  Respect variant prefixes (`sm:`, `md:`, `hover:`, `dark:`) — only touch the
  variant the user is viewing unless told otherwise.
- If no utility matches the exact token (missing scale key), prefer a CSS var
  via arbitrary value `[padding:var(--space-2)]` over adding a new utility.
- Vue: same, scoped to the `<template>` block; check `<style scoped>` for
  overrides that beat the utilities.

### 6.2 Traditional Web (SCSS / CSS Modules)
- Trace: element classes → stylesheet rule. CSS Modules: import map gives
  the authored name from the hashed class (`styles.card` → `.card`).
- Substitute: replace the raw length with `var(--space-N)` or the Sass
  variable (`$space-400`) per the dictionary `ref`.
- Watch `@mixin`/`@include` expansion: the rule you find may be generated;
  edit the mixin call site or the mixin itself per impact check.
- Check specificity and `!important` before assuming your edit wins.

### 6.3 Flutter / Dart
- Mapping: `Padding(padding: EdgeInsets.all(16))` → `p_*` regions;
  `Container(margin: …)` → `m_*`; `SizedBox(height: 12)` between flex
  children → `g_*` (row axis); `Column(mainAxisAlignment…, children with spacing)` /
  `Wrap(spacing: 8, runSpacing: 12)` → `g_*` (column/row bands).
- Trace: Dart source search for the widget constructor; widget keys
  (`Key('p_1')`) can be embedded for unambiguous tracing.
- Substitute: `EdgeInsets.all(16)` → `EdgeInsets.all(AppSpacing.space400)`
  (project constant mirroring the dictionary). Never leave magic numbers.
- `EdgeInsets.symmetric/only/fromLTRB`: expand to longhand edit exactly like
  CSS shorthand rules (§4.2).

### 6.4 Installing / uninstalling the overlay in a framework project

`npx padbear init` handles HTML projects by itself: it copies
`padbear-engine.js` into the static dir and inserts the tag before `</head>`.
(v0.2.0 renamed the engine from `padbear.js` — a project file named
`padbear.js` shadows the `padbear` CLI command on Windows, because cmd.exe
resolves commands from the current directory first. Installing over a v0.1.x
project migrates the old script tag and deletes the old engine.) Any project with **no
`index.html`** gets the engine and the skill, but **not** the tag — the CLI
prints the line and stops. Adding or removing that line is your job.

Places the tag goes:

| Stack | File | What to write |
|---|---|---|
| Next.js App Router | root `app/layout.tsx` (or `src/app/layout.tsx`) | `import Script from 'next/script'` + `<Script src="/padbear-engine.js" strategy="beforeInteractive" />` as a child of `<body>` |
| Next.js Pages Router | `pages/_app.tsx` | same import, `<Script>` placed beside `<Component {...pageProps} />` |
| Vue / Svelte / Angular / any template | the layout that wraps every route | `<script src="/padbear-engine.js" data-padbear></script>` |
| no bundler at all | the page console | paste the contents of `padbear-engine.js` — no file edit (DevTools Snippets keeps it) |

**Procedure — install** (the user cannot add the line themselves, so you do it):

1. `npx padbear init` from the project root. Add `--static <dir>` when the app
   serves a subfolder as its web root (Angular: `--static src`). Never
   `npm install padbear` inside the app — `npx` leaves no dependency behind.
   To refresh an existing install, `npx padbear update` (or re-run `init`) —
   it rewrites only files whose contents changed.
2. Confirm `padbear-engine.js` exists in the static dir the CLI printed.
3. Add the tag from the table above — **root** layout only, never a nested one.
4. Report the URL to open and say the overlay is dev-only.

**Procedure — remove:**

1. Delete the `<Script>` element **and** its `import` first. If you run the CLI
   before this step, `remove` will still warn that it could not undo your line.
2. `npx padbear remove` — it deletes the engine and the skill folder.
3. Confirm `padbear-engine.js` is gone. `padbear.tokens.json` is deliberately left in
   place — ask the user before deleting it.

Rules:

- The engine file goes in the **static dir** — `public/` for Next.js.
- `strategy="beforeInteractive"` is only valid in the **root** layout; putting
  it in a nested layout makes Next throw. If the project shows React hydration
  warnings, `afterInteractive` is the safer choice.
- Keep the tag **dev-only** where the stack allows it (e.g. guard with
  `process.env.NODE_ENV === 'development'`). It must never ship to production.
- `npx padbear remove` **cannot undo a hand-added tag**. When the user asks to
  remove Padbear from such a project, delete the `<Script>` element *and* its
  import — leaving the import behind fails lint/build in some setups.
- Never add engine code to `app/`, `pages/` or a component tree by copy-paste;
  only the one-line tag. The engine stays a static asset.

## 7. Output contract — every completed request reports

```json
{
  "request": "Change m_41 to 8px",
  "trace": {
    "id": "m_41",
    "element": "section.demo-hero",
    "file": "src/sections/Hero.tsx",
    "lines": "14-19",
    "styleSource": "utility-class",
    "previousExpression": "mt-6"
  },
  "change": {
    "before": "mt-6 (24px)",
    "after": "mt-2 (8px)",
    "token": { "source": "tailwind", "name": "2", "value": "8px" },
    "kind": "exact-token-match"
  },
  "impact": {
    "classUsageCount": 3,
    "sharedEdit": false,
    "notes": "mt-2 used by 2 other components; both unchanged (class token swapped only on this node)."
  },
  "verification": "rescan after edit: m_41 now reports 8px; sibling regions unchanged."
}
```

If you escalated (nearest-token proposal, new token, raw px), the report MUST
say so explicitly in `change.kind`.

## 8. Edge cases & failure modes

- **Auto margins**: never painted, never addressed. If the user asks, explain
  it's `margin-left: auto`-style and handle via explicit request.
- **Negative margins**: not painted; handle only on explicit instruction.
- **Percentage / em spacing**: computed px is context-dependent; the
  dictionary only holds px/rem. Trace the source, convert carefully, and
  confirm with a rescan.
- **Subpixel**: rounding makes badges show e.g. 15.9px; tolerance is 0.5px.
- **ID drift**: if the DOM structure changed since the snapshot, serials can
  shift. Always rescan and re-locate before editing; never trust a stale ID.
- **Shadow DOM / iframes**: Module 1 does not cross shadow boundaries by
  default. Treat each shadow root as its own scan target.

## 9. Worked example — "Change p_13 to 4px"

1. `TRACE(p_13)` → snapshot record:
   `{ id: "p_13", kind: "padding", property: "padding-top",
      valuePx: 16, element: { tag: "article", classes: ["demo-card"] } }`.
   The ID said only "padding" — the record is where "top" comes from.
2. Framework detection: `.tsx` files + `tailwind.config.js` → §6.1.
3. Locate: `grep -n "article" src/**.tsx` → `src/CardGrid.tsx:22`:
   `<article className="demo-card p-4">`. Only one match whose rendered DOM
   position matches the path → confirmed.
4. Owner: utility class `p-4`. But `p-4` owns ALL four sides; the request
   targets only the top side (record property `padding-top`) → per §4.2,
   split: `pt-1 p-4` is conflicting; correct output is `pt-1 p-4` replaced
   by explicit `pt-1 pr-4 pb-4 pl-4`
   **or** keep `p-4` and add an overriding scoped rule. Choose the explicit
   longhand utilities (simplest, no cascade tricks):
   `className="demo-card pt-1 pr-4 pb-4 pl-4"`.
5. Dictionary: `4px` → exact matches: Tailwind key `1`, `--space-1`,
   `space.100`. Project convention (`notes`: "use Tailwind utilities in JSX")
   → `pt-1`.
6. Impact: `pr-4/pb-4/pl-4` are new tokens on this node only — private edit.
7. Edit, then verify by rescan: the badge reads `4` and the panel Inspector
   shows `p_13 · 4px ⇒ pt-1`.
8. Report per §7.
