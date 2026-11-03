---
name: vue-component-analyzer
description: Analyze Vue 3 single-file component structure and produce a ranked, evidence-backed report of performance optimizations and code-reuse opportunities (duplicated helpers, copy-pasted modals/markup/CSS, composable extraction, oversized components, render-path waste, v-for key problems, lazy loading). Use this whenever the user asks to review, audit, analyze, refactor, speed up, slim down, or "clean up" Vue components or a Vue frontend, asks why a Vue page is slow or re-renders too much, asks what could be shared/extracted into composables or base components, or wants to find duplicated code in .vue files — even if they don't say "analyze" or name this skill. Prefer it over a generic code review when the target is .vue files.
---

# Vue Component Analyzer

Find the changes that make a Vue 3 codebase faster and smaller to maintain, prove each one with file:line evidence, rank them by payoff, and then offer to apply the ones the user picks.

The value of this skill is **judgement on top of measurement**. A bundled scanner does the counting (sizes, keys, duplicates, unresolved components) in well under a second; your job is to verify what it flags, weigh how much each issue actually matters for this app, and find what a scanner can't see.

## Workflow

### 1. Scope

Work out what to analyze: one component, a folder, or the whole frontend. If the user didn't say, analyze the app's whole `src/` and say so. Find the directory with the app's `package.json` and `node_modules/vue` (often the repo root, or `client/`, `frontend/`, `web/`).

### 2. Run the scanner

```bash
node <skill-dir>/scripts/scan-vue.mjs <src-dir-or-files> --json <scratch>/vue-scan.json
```

- It prints a markdown summary (component table, findings by rule, duplicated functions/markup/CSS) and writes full detail to the JSON file. Read the printed summary first; open the JSON only if you need a list the summary truncated.
- It loads `vue/compiler-sfc` from the app's own `node_modules`. If the files are outside the app, pass `--root <app-dir>`. If Vue isn't installed, tell the user, then continue by reading files directly; the checklist still applies.
- `--min-dup N` changes the element threshold for duplicated-markup detection (default 8). Lower it for small codebases.

### 3. Verify every lead before it reaches the report

Scanner output is a list of leads, not conclusions. For each one you intend to report, open the code at the cited line and confirm it. This step is what makes the report trustworthy. One wrong "bug" makes the user doubt every other finding.

Things to check:

- **Severity in context.** Function calls in a `v-for` over 5 rows don't matter, but over 2,000 rows they do. Look at where the data comes from (API, store, mock JSON) and estimate its real size before calling something a performance problem. Say what size you assumed.
- **`composable-outside-setup`**: read the composable. If it registers lifecycle hooks, calls `inject()`, or creates per-call state, calling it from a render-time helper is a **bug**. If it only returns module-level singletons, it's wasted work, so report it as a low-cost cleanup, not a bug.
- **Duplicated functions** with "N different versions": diff them. Small differences (one handles invalid dates, another doesn't) are themselves a finding, because they make the UI inconsistent. Say which version should win.
- **Duplicated CSS / markup**: check whether the copies really are the same component (e.g. five modals sharing overlay, header, close button and footer). If they are, that's one finding ("extract a BaseModal"), not five.
- **`unresolved-component`**: confirm it isn't registered globally (`app.component(...)` in `main.js`, or an auto-import plugin in the Vite config) before calling it a bug.

Drop anything that doesn't hold up. If a whole rule is noise for this codebase, say so in one line rather than listing it.

### 4. Look past the scanner

Read the largest components and the router or entry file, and go through `references/checklist.md`. It covers what static counting misses: methods that should be computeds, large static data wrapped in deep reactivity, routes and modals that should be lazy-loaded, request waterfalls on mount, watchers that should be computeds, prop drilling, and when to choose a composable, a base component with slots, or a plain util.

Respect the codebase's existing conventions. If the app consistently uses `setup()` inside `defineComponent` rather than `<script setup>`, don't recommend a migration as an "optimization". Mention it at most once as optional.

### 5. Write the report

Use this structure. Keep it scannable: one finding per distinct problem, with repeated instances grouped under it.

```markdown
# Vue component analysis: <scope>

## Summary

<3–5 sentences: overall health, the biggest wins, anything that is actually broken.>

## Bugs found along the way

<Only real defects confirmed in step 3, e.g. a component used but never imported. Omit the section if none.>

## Recommendations (ranked)

| #   | Recommendation                         | Type  | Impact | Effort | Where                       |
| --- | -------------------------------------- | ----- | ------ | ------ | --------------------------- |
| 1   | Extract BaseModal from 5 detail modals | Reuse | High   | M      | components/*DetailModal.vue |

### 1. <Recommendation title>

**Where:** file:line, file:line (all instances)
**Problem:** what is wrong and the concrete cost: render work per update, KB shipped, lines duplicated, bugs a fix in one copy would miss.
**Change:** what to do, with a short before/after snippet using the real names from this code.
**Risk / verify:** what could break and how to check it (build, tests, the page to click through).

## Quick wins

<Bullet list of small, safe changes, each one line with file:line.>

## Not worth doing (and why)

<Flagged items you checked and decided against, so the user doesn't re-investigate them.>
```

How to rank: put correctness first, then real user-facing performance, then reuse that removes the most duplicated lines or prevents inconsistency. Impact is High, Med or Low. Effort is S (under 30 min), M (a few hours) or L (a day or more). Use the app's real names in snippets. A generic snippet makes the reader translate it back into their own code.

Write the report in chat. If it runs past about 150 lines, or the user wants to share it, also save it to a markdown file and give the path.

### 6. Offer to apply fixes

After the report, ask which recommendations to apply, e.g. "Want me to apply the quick wins and #1–#2?" Don't edit files before the user answers. The report is the deliverable, and refactors across many components need their go-ahead.

When applying:

- Follow the project's own rules for who edits `.vue` files. If CLAUDE.md requires a specific agent for Vue work (for example a `vue-expert` subagent), give the edits to that agent with the finding's file:line, problem and change.
- Apply one recommendation at a time, smallest and safest first.
- After each change, verify it: run the build (`npm run build`), the frontend tests if there are any, and re-run the scanner to confirm the finding is gone. If a dev server and browser tool are available, load the affected page and check the console.
- Report what changed, what you verified, and anything you skipped.

## Project notes: this repository (Factory Inventory app)

When run inside this repo (`client/` is the Vue app):

- Shared logic lives in `client/src/composables/` (`useFilters`, `useI18n`, `useAuth`), and helpers in `client/src/utils/` (e.g. `utils/currency.js`). New shared code belongs there, not in a new folder.
- `useI18n` and `useFilters` share module-level singleton state. `useI18n()` only builds closures, so calling it per render is waste. `useFilters()` creates a new `computed` on each call, so calling it outside `setup()` leaks reactive effects. Both belong in `setup()`, called once.
- Views use `defineComponent` + `setup()`. Newer components in `components/` use `<script setup>`. Both are fine.
- CLAUDE.md requires `.vue` changes to go through the **vue-expert** subagent and v-for keys to be stable ids (`sku`, `id`, `month`), never the index.
- Charts are custom SVG/CSS. Don't suggest adding a chart library as an optimization.
