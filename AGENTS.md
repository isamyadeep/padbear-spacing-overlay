# AGENTS.md — Padbear working instructions

Instructions for AI agents working in this repository. Read this before
exploring; it exists to keep sessions focused and cheap.

## What this project is

Padbear: an AI-assisted semantic spacing overlay inspector + token
reconciliation framework. Single-file deployable (`index.html`) plus a
generated engine build (`padbear-npm/padbear.js`). Full context: read `README.md` first,
then `docs/SESSION-HANDOFF.md` for current status and open work.

## READ FIRST (only these)

1. `README.md` — architecture + usage
2. `docs/SESSION-HANDOFF.md` — current state, known issues, next steps
3. `index.html` — the engine (single source of truth; `padbear-npm/padbear.js` is GENERATED)
4. `padbear-npm/skill.md` — agent mutation instructions (only when doing spacing edits)

## DO NOT READ / SCAN — token-burn zones

These folders are NOT needed to develop the core product. Never list, grep,
summarize, or open them unless the user explicitly asks:

- `brand/` — logo assets and brand-marketfing files (design deliverable only)
- `site/` — marketing/docs-site HTML (non-product)
- `*.log`, binary assets, image files
- any `node_modules/`, `.git/`, build output directories

Reason: a fresh session that walks the whole tree wastes context on
non-product files and burns tokens for zero progress. When you need a file
inside an ignored folder because the user asks for it, read exactly that one
file — don't enumerate the folder.

## Editing rules

- `index.html` is the single source of truth for the engine. After editing
  it, ALWAYS run: `node tools/extract-engine.mjs` (regenerates `padbear-npm/padbear.js`).
  Never edit `padbear-npm/padbear.js` directly.
- The deployed companion project lives at
  `D:\Work\Experiments\Open Source\Heimdall\redesign\` (copy of `padbear.js` +
  `<script src="/padbear.js">`). After engine changes, copy the new `padbear.js`
  there if the user is testing against it.
- Keep the token dictionary schema (`padbear-npm/schemas/padbear-token-dictionary.schema.json`)
  stable — the user has decided the token system stays as it is. Extensions
  (e.g. color tokens) are additive only, following the researched pattern in
  `docs/SESSION-HANDOFF.md` §"Token research".
- Test changes against the live dashboard at `http://localhost:8137/index.html`
  (user runs `python -m http.server` there) before claiming anything works.
