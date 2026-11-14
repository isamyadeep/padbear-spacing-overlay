# MODULE 4 — Padbear Framework Adaptability Matrix

How the Padbear engine extracts spacing data from, and mutates source across,
different technology stacks. The runtime overlay engine (Module 1, `index.html`)
is stack-agnostic — it reads **computed styles**. What changes per stack is:

1. **Extraction** — how a region ID maps back to the source construct that
   produced it (trace strategy).
2. **Mutation** — what text the agent writes when substituting a token.

## 0. Matrix at a glance

| | Tailwind + React (JSX/TSX) | Vue SFC | Traditional Web (SCSS / CSS Modules) | Flutter / Dart |
|---|---|---|---|---|
| Style source of record | utility classes in `className` | utilities + `<style scoped>` | stylesheet rules | widget constructors |
| Region → source trace | grep class tokens + tag | grep class tokens + `data-v-` scope | class name → rule (CSS Modules via import map) | widget type + constructor args |
| Token form | `p-2`, `gap-4`, `mt-3` | same + `var(--space-N)` | `var(--space-N)` / `$space-200` | `AppSpacing.space200` constant |
| Shorthand hazard | `p-4` owns 4 regions | same | `padding: 8px 16px` | `EdgeInsets.all/symmetric` |
| Collision surface | class token shared across files | scoped styles leak via `:deep()` | global selectors, mixins, `!important` | shared constants, themes |
| Rescan verification | dev-server HMR + overlay rescan | same | rebuild + rescan | hot reload + rescan |

Cross-cutting rule for **all** stacks: the agent edits the *abstraction*
(class token / variable / constant), never a raw pixel string, when the token
dictionary has an exact or user-approved match (see `skill.md` §4).

---

## 1. Tailwind CSS + React (JSX/TSX)

### 1.1 Extraction model

Every Tailwind spacing utility is `prefix + scaleKey`, and the dictionary
stores `spacingScale` (key → px) plus legal `spacingPrefixes`. The overlay
shows measured px; tracing means finding the utility that computes to it.

**Class token extraction (offline pre-pass, recommended for large repos):**

```ts
// tools/padbear-trace-tailwind.ts
// Builds a map: region-ish CSS property → [file, line, utility, elementHint]
import fs from 'node:fs';
import path from 'node:path';
import type {} from 'tailwindcss'; // types only

const SPACING_PROPS: Record<string, string> = {
  p: 'padding', px: 'padding-inline', py: 'padding-block',
  pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left',
  m: 'margin', mx: 'margin-inline', my: 'margin-block',
  mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom', ml: 'margin-left',
  gap: 'gap', 'gap-x': 'column-gap', 'gap-y': 'row-gap',
};

// e.g. "md:pt-4" → { variant: 'md', prefix: 'pt', key: '4' }
const UTIL_RE = /^(?:(\w+):)?(!)?(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-(-?[\d.]+)$/;

export function* walkFiles(dir: string): Generator<string> { /* readdir recursive */ }

export function scanUtilities(files: string[], scale: Record<string, string>) {
  const index: Array<{
    file: string; line: number; util: string; property: string;
    px: number | null; variant?: string; important?: boolean;
  }> = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((lineText, i) => {
      for (const raw of lineText.split(/\s+/)) {
        const m = UTIL_RE.exec(raw);
        if (!m) continue;
        const [, variant, bang, prefix, key] = m;
        const px = parseFloat(scale[key]);          // rem→px handled by dictionary
        index.push({
          file, line: i + 1, util: raw,
          property: SPACING_PROPS[prefix],
          px: Number.isFinite(px) ? px : null,
          variant, important: !!bang,
        });
      }
    });
  }
  return index;
}
```

The agent consults this index (or does the equivalent grep live) to go from
`pad_top_0013 = 16px on article.demo-card` → `src/CardGrid.tsx:22` → `p-4`.

**Dynamic class traps:** `clsx`/`cn` composition and template strings
(`p-${size}`) hide utilities from grep. If a trace fails to find a literal
utility, search for the *property word* (`'pt-'`, `padding-top`) inside the
component and follow the variable.

### 1.2 Mutation rules

| Requested change | Edit |
|---|---|
| One side of a 4-sided utility (`p-4`, only top changes) | Expand: `p-4` → `pt-1 pr-4 pb-4 pl-4` (or scoped override rule), never two conflicting `p*` tokens that both claim `padding-top` |
| Whole box | Swap scale key: `p-4` → `p-1` |
| Gap | `gap-4` → `gap-2`; for flex rows prefer `gap-x`/`gap-y` when the request is axis-specific |
| Exact px has no utility | Arbitrary property that still references the token: `[padding-top:var(--space-1)]` — allowed because it references a token, unlike `[padding-top:5px]` |
| Responsive context | Only touch the variant under inspection (`md:p-4` stays; add/adjust `md:pt-1`) |

**Verification:** after edit, dev-server HMR re-renders; the agent reruns
`window.Padbear.scan()` and asserts the target region's badge reports the
requested px with the expected token annotation.

---

## 2. Vue 3 SFC (brief)

- Trace: class tokens inside `<template>`; scoped CSS in `<style scoped>`
  compiles to `[data-v-xxx]` selectors — the rendered element carries the
  scope attribute, so the overlay engine sees the final specificity.
- Mutate utilities exactly as §1.2. For scoped rules, replace raw lengths
  with `var(--space-N)`.
- Beware `:deep()` rules styling children from a parent — impact check must
  include every SFC containing the selector (skill.md §5).

---

## 3. Traditional Web (SCSS / CSS Modules)

### 3.1 Extraction model

Here the class on the element points to a **rule** in a companion stylesheet;
the rule body is the style source.

```text
region snapshot:  { id: "pad_left_0009", property: "padding-left", valuePx: 16,
                    element: { classes: ["card_active"] } }

TRACE:
  1. Plain CSS/SCSS global class:
       grep -rn "\.card_active" src/styles/   →  src/styles/_card.scss:41
  2. CSS Modules:
       source class authored as styles.cardActive
       hashed on the element as  CardGrid_cardActive__2fKx9
       → search the AUTHOR name ("cardActive") in CardGrid.module.scss
       (the runtime engine intentionally reports only stable class tokens;
        strip CSS-Module hashes before matching)
  3. If the matched rule body has no padding-left, walk the cascade:
       shared partials/@include → base layer → element/global defaults.
       The winning declaration must compute to valuePx (±0.5px).
```

**Mixin trap:** the declaration may be generated:

```scss
@mixin card-pad($y: var(--space-4), $x: var(--space-4)) {
  padding: $y $x;               // ← the real source
}
.card { @include card-pad; }
```

If the matched declaration lives inside a mixin, the impact check runs on the
mixin's *call sites* (grep `@include card-pad`), and the edit happens either
at a call site (pass an argument) or in the mixin (shared edit → isolation
rules apply).

### 3.2 Mutation rules

```scss
// BEFORE (measured pad_left_0009 = 16px, user asks for 8px)
.card {
  padding: 16px;              // raw px — off-token already
}

// AFTER — longhand for the requested side, token for everything else
.card {
  padding: var(--space-4);
  padding-left: var(--space-2);   // GG: pad_left_0009 → space.200 (exact match)
}
```

- Prefer `var(--space-N)` (dictionary `cssVariables`) or the Sass variable
  named by the scale entry's `ref` (`$space-200`).
- Expand shorthands per skill.md §4.2; keep unchanged sides byte-identical.
- Check specificity/`!important`: if an `!important` rule loses to a later
  one, editing it changes nothing visually — trace the actual winner first.
- PostCSS/lint: run the project's stylelint; most design systems forbid raw
  px in declarations (`declaration-property-value-allowed-list`) — the token
  substitution satisfies it automatically.

---

## 4. Programmatic Trees (Flutter / Dart)

Flutter has no DOM and no CSS; **spacing is structural**. The overlay engine
runs in a `FlutterWeb` build or (more commonly) the workflow uses a desktop/
device inspector that exports the same region snapshot shape. The mapping:

### 4.1 Construct → region mapping

| Flutter construct | Padbear regions |
|---|---|
| `Padding(padding: EdgeInsets.all(16))` | `pad_top/right/bottom/left_*` @ 16px |
| `Container(margin: EdgeInsets.symmetric(horizontal: 24))` | `mar_left/right_*` @ 24px |
| `SizedBox(height: 12)` between `Column` children | `gap_row_*` @ 12px |
| `Wrap(spacing: 8, runSpacing: 12)` | `gap_col_*` @ 8px, `gap_row_*` @ 12px |
| `ListView.separated(separatorBuilder: SizedBox(height: 8))` | `gap_row_*` @ 8px |
| `EdgeInsets.only(left: 4)` | `pad_left_*` @ 4px only |

### 4.2 Extraction: an analyzer-based indexer

```dart
// tool/padbear_trace_dart.dart
// Indexes every spacing construct: file, line, widget, edge, px.
import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';

class SpacingIndexer extends RecursiveAstVisitor<void> {
  final List<Map<String, Object?>> hits = [];

  @override
  void visitInstanceCreationExpression(InstanceCreationExpression node) {
    final type = node.constructorName.type.toString(); // e.g. "EdgeInsets"
    switch (type) {
      case 'EdgeInsets':
      case 'EdgeInsetsDirectional':
        _recordEdgeInsets(node);
      case 'SizedBox':
        _recordSizedBox(node);
      case 'Padding' || 'Container' || 'Wrap' || 'Gap':
        _recordSpacingProperty(node);
    }
    node.visitChildren(this);
  }

  void _recordEdgeInsets(InstanceCreationExpression node) {
    // named constructor determines edge semantics:
    //   all(v)            → 4 regions @ v
    //   symmetric(h:, v:) → 2 or 4 regions
    //   only(a, b, …)     → exactly those regions
    //   fromLTRB(l, t, r, b) → 4 regions, positional order L,T,R,B
    hits.add({
      'file': node.declaredElement!.source!.uri,
      'line': node.constructorName.beginToken.line,
      'construct': 'EdgeInsets',
      'factory': node.constructorName.name?.lexeme ?? 'new',
      'args': node.argumentList.arguments.map(_evalConst).toList(),
    });
  }
  // … _recordSizedBox reads width/height args (gap proxy),
  //   _recordSpacingProperty reads `padding:` / `margin:` / `spacing:` …

  /// Constant-fold: numbers, AppSpacing.space400 (→ px via tokens map),
  /// double literals. Non-const args (functions, MediaQuery) → null px,
  /// flagged "dynamic" so the agent knows the overlay value is contextual.
  Object? _evalConst(Expression e) => /* fold literals + token constants */;
}
```

Run once per repo (or on changed files via `dart run`) to produce
`padbear-dart-index.json` — the Flutter equivalent of the Tailwind utility
index. Unambiguous tracing trick: widgets can embed the region ID directly,
`Padding(key: const Key('pad_top_0013'), …)`, which the snapshot then echoes.

### 4.3 Mutation rules

```dart
// BEFORE (pad_top_0013 measured 16px, user asks 8px)
Padding(
  padding: const EdgeInsets.all(16),          // GG-RAW: magic number
  child: Card(child: content),
)

// AFTER — token constant from AppSpacing (mirrors padbear.tokens.json scale)
Padding(
  padding: const EdgeInsets.only(
    top: AppSpacing.space200,                 // 8px — exact token match
    right: AppSpacing.space400,               // unchanged sides stay
    bottom: AppSpacing.space400,
    left: AppSpacing.space400,
  ),
  child: Card(child: content),
)
```

- `EdgeInsets.all`/`symmetric` are the Dart analogue of CSS shorthand — expand
  to `only`/`fromLTRB` when a single edge changes (skill.md §4.2).
- Never edit `AppSpacing` itself to satisfy one widget (shared constant =
  shared state; skill.md §5).
- `SizedBox` acting as a gap: prefer replacing the widget with the project's
  `Gap(AppSpacing.space200)` extension if one exists; otherwise resize.
- After `flutter run` hot reload, rescan the inspector to verify the region
  reports the new px; check sibling widgets sharing the constant.

---

## 5. Verification loop (all stacks)

1. Apply the token substitution (never raw px without explicit approval).
2. Rebuild / hot-reload.
3. `window.Padbear.scan()` (web) or inspector rescan (Flutter).
4. Assert: target region badge = requested px + expected token annotation;
   all other regions at their previous values; snapshot diff contains exactly
   one region delta.
5. Emit the §7 report from `skill.md`.
