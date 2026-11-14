# Trying Padbear on another project

The overlay engine is a self-contained script (`padbear-engine.js`, auto-extracted from
`index.html`) that runs on **any page you can open DevTools on** — your local
app, a teammates' build, a deployed staging site. No framework integration
required to *inspect*; framework strategy only matters when the agent *edits*
source (Module 4).

## 1. Serve or deploy the engine once

```bash
cd padbear
npx serve .                        # local: http://localhost:3000/padbear-engine.js
# or deploy once:
npx wrangler pages deploy .        # → https://<you>.pages.dev/padbear-engine.js
```

If you edit the engine later, regenerate: `node tools/extract-engine.mjs`.

## 2. Inject into the target page

Open the target project in your browser, paste in the DevTools console:

```js
(() => {
  const s = document.createElement('script');
  s.src = 'http://localhost:3000/padbear-engine.js';   // or https://<you>.pages.dev/padbear-engine.js
  document.head.append(s);
})();
```

A `<script>` tag is not CORS-restricted, so this works across origins.
On SPA reloads / route changes, re-run `Padbear.scan()` (or re-paste).

## 3. Give it the project's token dictionary

Without a dictionary the engine still measures and tags everything, but chips
can't annotate tokens and the reconciliation loop can't suggest anything.
Three ways to supply one:

```js
// a) same-origin file (dictionary served from the target app itself)
Padbear.loadTokens('/padbear.tokens.json');

// b) deployed alongside the engine — works only if that host sends CORS headers
Padbear.loadTokens('https://<you>.pages.dev/padbear.tokens.json');

// c) paste it (always works) — build the object per Module 2 schema:
Padbear.setTokens({
  cssVariables: { '--space-2': '8px', '--space-4': '16px' },
  frameworks:   { tailwind: { spacingScale: { 2: '8px', 4: '16px' },
                              spacingPrefixes: ['p', 'm', 'gap'] } },
  tokens:       { spacing: { namingConvention: { pattern: 'space.<step>' },
                             boundaries: { minPx: 2, maxPx: 96 },
                             scale: [{ name: 'space.200', value: '8px', usage: '…' }] } },
});
```

Tip: for a Tailwind project you can generate the scale straight from
`tailwind.config.js` — the keys are the spacing scale, the prefixes the list.

## 4. Work the overlay

- Toggle kinds / label density in the panel (`Minimal` for clean screenshots).
- Hover chips and elements; click a chip (or `copy all IDs` on the box-model
  card) to put exact IDs on the clipboard.
- The hover **set** box and console are a **preview sandbox** — they mutate
  only the live DOM, never your source. Use them to rehearse a change;
  nothing to undo in your repo.

## 5. Hand off to the agent (the step that edits code)

For each change you want in the repo, give your agent one task containing:

1. the region ID(s) — e.g. `p_28` (or "copy all IDs" from a box-model card);
2. the target value (`8px`, or "match the card padding");
3. `padbear.tokens.json` for the project (Module 2 schema);
4. the `skill.md` file — load it as the agent's instruction set
   (in ZCode: save it as a skill; in Claude/other tools: attach as system
   prompt or paste at the top of the task);
5. optionally `padbear-snapshot.json` (`Export` button) so the agent has the
   element hints without re-rendering.

The agent then runs the ID tracing algorithm and reconciliation loop from
`skill.md`, edits the right abstraction for that stack
(`docs/framework-matrix.md`), and reports per the §7 contract. Re-inject the
overlay after the dev server hot-reloads to verify the region now reports the
new value.

## Constraints to know

- IDs persist per tab via `sessionStorage` keyed by DOM path — refreshing is
  fine; structural changes shift serials, so re-scan before quoting IDs.
- Shadow DOM is not traversed; each shadow root would need its own scan.
- Cross-origin iframes are not measured (same restriction as DevTools).
