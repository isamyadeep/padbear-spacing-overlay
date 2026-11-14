#!/usr/bin/env node
/**
 * padbear — project installer/updater/remover CLI.
 *
 *   npx padbear init     [--static <dir>] [--root <project>] [--no-skill]
 *   npx padbear update   [--static <dir>] [--root <project>] [--no-skill]
 *   npx padbear remove   [--static <dir>] [--root <project>]
 *
 * init does the mechanical part of installing the Padbear overlay into a web
 * project:
 *   1. copies the overlay engine (padbear-engine.js) into the project's
 *      static dir — v0.2.0 renamed it from padbear.js so the file can never
 *      shadow the `padbear` command on Windows (cmd.exe resolves commands
 *      from the current directory first, and padbear.js would win over the
 *      npm shim via the .js file association). init migrates v0.1.x
 *      installs: rewrites the old script tag src and deletes the old engine.
 *   2. inserts a dev script tag into index.html (idempotent, marker-tagged)
 *   3. installs the `padbear` mutation skill into <root>/.agents/skills/
 *
 * update re-runs the latest published version's init with the same
 * arguments — the engine is a COPY in the static dir, not a dependency, so
 * `npm update padbear` would leave it stale.
 *
 * remove undoes exactly those three (leaves padbear.tokens.json in place —
 * it may have been hand-curated for the project).
 *
 * The agent calling this still handles the smart parts: token-dictionary
 * generation (Tailwind config / CSS vars) and framework edge cases (Next.js
 * has no index.html — see skill.md).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
// Flags that consume the next token as their value (everything else is a
// boolean flag). Used to tell real positionals apart from flag values.
const VALUE_FLAGS = new Set(['--root', '--static']);
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a)) i++;   // skip this flag's value
    continue;
  }
  positionals.push(a);
}
// The command is the first real positional, wherever it appears — so both
// `padbear remove --root X` and `padbear --root X remove` work.
const cmd = positionals[0] ?? 'init';
const arg = (name, def) => {
  const eq = args.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf('--' + name);
  // raw value — --root resolves against cwd, --static is joined with ROOT below
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

/** Files shipped with this package. */
const PKG_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const ENGINE_NAME = 'padbear-engine.js';
const LEGACY_ENGINE_NAME = 'padbear.js';
const engineSrc = join(PKG_ROOT, ENGINE_NAME);
const skillSrc = join(PKG_ROOT, 'skill.md');
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));

const HELP = `Padbear — spacing overlay installer

Usage:
  npx padbear <command> [options]

Commands:
  init      Install the Padbear overlay into a project (default)
  update    Refresh the overlay to the latest published version (re-runs init)
  remove    Uninstall the overlay, script tag and agent skill

Options:
  --root <dir>     Project folder to install into (default: current folder)
  --static <dir>   Where to put padbear-engine.js, relative to --root
                   (default: first of public/, static/, www/, src/public/,
                   or the project root)
  --no-skill       Don't install .agents/skills/padbear/
  -h, --help       Show this help
  -v, --version    Show the version

What init does:
  1. copies padbear-engine.js into the static folder
  2. inserts one <script src="/padbear-engine.js" data-padbear> line into
     index.html (v0.1.x installs get their old tag migrated automatically)
  3. installs the agent skill into .agents/skills/padbear/

What update does:
  re-runs init from the latest published package version — same options
  apply; rewrites only files whose contents changed

What remove does:
  undoes the three steps above; leaves padbear.tokens.json in place

Examples:
  npx padbear init
  npx padbear update
  npx padbear init --root "D:\\Work\\my-dashboard"
  npx padbear init --static assets
  npx padbear remove
  npx padbear init --no-skill

Windows note:
  Since v0.2.0 the engine installs as padbear-engine.js, so a project never
  contains a file that shadows the \`padbear\` command (cmd.exe resolves
  commands from the current directory first). Legacy v0.1.x installs still
  have a padbear.js — run this CLI once from a different folder (or with
  --root) to migrate; in-place runs work afterwards.`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (!existsSync(engineSrc)) {
  console.error(`✗ engine not found at ${engineSrc} — the package seems broken; try  npm i padbear@latest`);
  process.exit(1);
}

const ROOT = resolve(arg('root', process.cwd()));
const MARKER = 'data-padbear';
const TAG =
  '  <!-- Padbear dev overlay — remove this line to uninstall -->\n  <script src="/padbear-engine.js" data-padbear></script>\n';

/* ---- locate static dir ---------------------------------------------------- */
const CANDIDATES = ['public', 'static', 'www', 'src/public', ''];
const staticDirName = arg('static', null);
const staticDir = staticDirName
  ? (isAbsolute(staticDirName) ? staticDirName : join(ROOT, staticDirName))
  : join(ROOT, CANDIDATES.find((c) => c !== '' && existsSync(join(ROOT, c))) ?? '');

const htmlCandidates = ['index.html', 'src/index.html', 'public/index.html', 'app/index.html'];
const htmlPath = htmlCandidates.map((c) => join(ROOT, c)).find(existsSync);

/**
 * Copy `src` to `dest` only when the bytes differ.
 *
 * Unconditional overwrites bump mtime and fire a filesystem-change event even
 * though nothing changed — which makes dev servers reload and can make editors
 * reload the window (VS Code re-scans `.agents/skills/**` on change). Re-running
 * `init` should be a no-op, so compare first.
 */
function installFile(src, dest, ok) {
  const bytes = readFileSync(src);
  if (existsSync(dest) && readFileSync(dest).equals(bytes)) {
    console.log(`✓ ${ok(dest).slice(2)}  (already up to date)`);
    return;
  }
  writeFileSync(dest, bytes);
  console.log(ok(dest));
}

/* ---- init ------------------------------------------------------------------ */
function init() {
  mkdirSync(staticDir, { recursive: true });
  installFile(engineSrc, join(staticDir, ENGINE_NAME), (p) => `✓ engine  → ${p}`);

  if (!htmlPath) {
    console.log('⚠ no index.html found — add this line yourself:');
    console.log('    Next.js (app/layout.tsx):  <Script src="/padbear-engine.js" strategy="beforeInteractive" />');
    console.log('    any HTML page (<head>):    <script src="/padbear-engine.js" data-padbear></script>');
    console.log('  `npx padbear remove` cannot undo a hand-added tag — it will remind you which line to delete.');
  } else {
    let html = readFileSync(htmlPath, 'utf8');
    // v0.1.x migration: the engine was renamed from padbear.js to
    // padbear-engine.js so the file can never shadow the `padbear` command on
    // Windows. Rewrite the src only on marker-tagged lines — other
    // padbear.js mentions may be user content.
    if (html.includes(MARKER) && html.includes(LEGACY_ENGINE_NAME)) {
      const migrated = html
        .split('\n')
        .map((line) =>
          /data-padbear|Padbear dev overlay/.test(line)
            ? line.replaceAll(LEGACY_ENGINE_NAME, ENGINE_NAME)
            : line,
        )
        .join('\n');
      if (migrated !== html) {
        html = migrated;
        writeFileSync(htmlPath, html);
        console.log(`✓ migrated  script tag src → "/${ENGINE_NAME}"  (v0.1.x rename)`);
      }
    }
    if (html.includes(MARKER)) {
      console.log(`✓ script tag already present in ${basename(htmlPath)}`);
    } else if (html.includes('</head>')) {
      html = html.replace('</head>', TAG + '</head>');
      writeFileSync(htmlPath, html);
      console.log(`✓ script tag added to ${basename(htmlPath)}`);
    } else {
      console.log(`⚠ ${basename(htmlPath)} has no </head> — add manually:\n${TAG}`);
    }
    // Hand-added tags (e.g. Next.js <Script>) carry no marker, so the rewrite
    // above skipped them — say so loudly instead of leaving a 404 behind.
    if (html.includes(LEGACY_ENGINE_NAME) && !html.includes(ENGINE_NAME)) {
      console.log(`⚠ a hand-added tag still points at "/${LEGACY_ENGINE_NAME}" — update its src to "/${ENGINE_NAME}".`);
    } else if (html.includes(LEGACY_ENGINE_NAME)) {
      console.log(`ℹ index.html still mentions "/${LEGACY_ENGINE_NAME}" somewhere without the data-padbear marker — update it by hand if it is a script tag.`);
    }
  }

  if (!args.includes('--no-skill')) {
    const skillDir = join(ROOT, '.agents', 'skills', 'padbear');
    mkdirSync(skillDir, { recursive: true });
    const skillDest = join(skillDir, 'SKILL.md');
    installFile(skillSrc, skillDest, (p) => `✓ skill   → ${p}  (region-ID mutation instructions for AI agents)`);
  }

  // v0.1.x cleanup: a stale padbear.js shadows the `padbear` command on
  // Windows (cwd-first command resolution + .js file association), so after
  // the tag migration the old copy has no purpose left.
  const legacyEngine = join(staticDir, LEGACY_ENGINE_NAME);
  if (existsSync(legacyEngine)) {
    const head = readFileSync(legacyEngine, 'utf8').slice(0, 200);
    if (head.includes('Padbear engine')) {
      rmSync(legacyEngine);
      console.log(`✓ removed  legacy ${LEGACY_ENGINE_NAME} (engine renamed to ${ENGINE_NAME} in v0.2.0)`);
    } else {
      console.log(`ℹ left in place: ${legacyEngine} (not a Padbear engine build — not touching it)`);
    }
  }

  const needsTokens = !existsSync(join(staticDir, 'padbear.tokens.json'));
  console.log('\nNext steps:');
  console.log('  1. Reload the dev server page — the Padbear panel appears top-right.');
  if (needsTokens) {
    console.log('  2. Tokens: none found yet. Add padbear.tokens.json to the static dir');
    console.log('     (schema: schemas/padbear-token-dictionary.schema.json in this package),');
    console.log('     then in the page console:  Padbear.loadTokens(\'/padbear.tokens.json\')');
  } else {
    console.log('  2. Tokens already present — the overlay will offer them automatically.');
  }
  console.log('  3. SPA route changes need a console  Padbear.scan()  (no auto-rescan).');
}

/* ---- update ----------------------------------------------------------------- */
/**
 * The engine is a COPY in the static dir, not a dependency — `npm update`
 * wouldn't refresh it, and the already-installed CLI can't ship new logic.
 * So `update` re-runs the latest published version's init with the same
 * arguments. PADBEAR_UPDATE_SPEC overrides the version spec (handy for
 * testing a pre-release locally).
 */
function update() {
  const forwarded = args.filter((a) => a !== 'update' && a !== 'upgrade');
  const spec = process.env.PADBEAR_UPDATE_SPEC || 'padbear@latest';
  // spec is quoted: a local path (PADBEAR_UPDATE_SPEC) may contain spaces.
  const cmdLine = `npx --yes "${spec}" init${forwarded.length ? ' ' + forwarded.join(' ') : ''}`;
  console.log(`→ refreshing the overlay from ${spec} …`);
  const res = spawnSync(cmdLine, { stdio: 'inherit', shell: true });
  if (res.error || res.status !== 0) {
    console.error(
      `\n✗ update failed${res.error ? ` (${res.error.code || res.error.message})` : ''} — run it manually:\n\n  ${cmdLine}`,
    );
    process.exit(res.status || 1);
  }
}

/* ---- remove ----------------------------------------------------------------- */
function remove() {
  let removed = 0;

  for (const name of [ENGINE_NAME, LEGACY_ENGINE_NAME]) {
    const engineFile = join(staticDir, name);
    if (existsSync(engineFile)) {
      rmSync(engineFile);
      console.log(`✓ removed  ${engineFile}`);
      removed++;
    }
  }

  if (htmlPath) {
    let html = readFileSync(htmlPath, 'utf8');
    const before = html;
    // Strip the exact block init inserts, not whole lines: minified or
    // single-line HTML has no line boundaries, and a line-based filter would
    // delete the entire document up to </head>.
    html = html
      .replace(/[ \t]*<!-- Padbear dev overlay[^\n]*-->\n?/, '')
      .replace(/[ \t]*<script[^>]*\bdata-padbear\b[^>]*>\s*<\/script>\n?/, '');
    if (html !== before) {
      writeFileSync(htmlPath, html);
      console.log(`✓ removed  dev script tag from ${basename(htmlPath)}`);
      removed++;
    }
  } else {
    // Frameworks with no index.html (Next.js, some Vue/Angular setups) get the
    // tag added by hand, so there is nothing here to remove — say so loudly
    // instead of reporting a clean uninstall over a dangling script tag.
    console.log('⚠ no index.html found — remove the line you added by hand:');
    console.log('    Next.js (app/layout.tsx):  <Script src="/padbear-engine.js" strategy="beforeInteractive" />');
    console.log('    any HTML page (<head>):    <script src="/padbear-engine.js" data-padbear></script>');
    console.log('  Left in place, the page will request a padbear-engine.js that no longer exists.');
  }

  const skillDir = join(ROOT, '.agents', 'skills', 'padbear');
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
    console.log(`✓ removed  ${skillDir}`);
    removed++;
  }

  const tokensFile = join(staticDir, 'padbear.tokens.json');
  if (existsSync(tokensFile)) {
    console.log(`ℹ left in place: ${tokensFile} (hand-curated token dictionary — delete if unwanted)`);
  }

  console.log(removed ? `\nPadbear uninstalled (${removed} item(s)).` : '\nNothing to remove — Padbear was not installed here.');
}

if (cmd === 'remove') {
  remove();
} else if (cmd === 'init') {
  init();
} else if (cmd === 'update' || cmd === 'upgrade') {
  update();
} else {
  console.log(`Unknown command "${cmd}". Run  npx padbear --help  for usage.`);
  process.exit(1);
}
