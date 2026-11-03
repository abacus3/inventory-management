# Vue 3 performance and reuse checklist

Use this for what the scanner can't measure. Each item says what to look for, why it matters, and the usual fix. Report an item only after confirming it in the code and judging that it matters at this app's data sizes.

## Contents

1. Render-path performance
2. Reactivity cost
3. Loading and bundle size
4. Data fetching
5. Reuse: picking the right abstraction
6. Component boundaries

---

## 1. Render-path performance

**Methods called from the template that derive data.** A function called in the template runs on every re-render of that component, and in a `v-for` it runs once per row. A `computed` is cached until its dependencies change.

- Look for `getXByY(...)`, `filteredX()` or `.filter/.sort/.map` in templates, and for formatting helpers called per row.
- Fix: one `computed` that returns ready-to-render rows, e.g. `const rows = computed(() => items.value.map(i => ({ ...i, statusClass: statusClass(i), dateLabel: formatDate(i.date) })))`.
- Leave cheap pure formatters on small lists alone. Their cost is negligible, and a computed of display rows adds complexity. Say so in "Not worth doing".

**Parameterized derived lists** (`getForecastsByTrend('increasing')` called three times): turn them into one computed that groups everything at once, e.g. `const byTrend = computed(() => groupBy(forecasts.value, 'trend'))`, then `byTrend.value.increasing.slice(0, 5)`. Better still, do the slice in the computed too.

**Static subtrees.** Markup that never changes after the first render can use `v-once`. A large `v-for` whose rows change rarely can use `v-memo="[row.id, row.updatedAt]"`. Only use these on hot paths, because they hide bugs if the dependency list is wrong.

**`v-show` vs `v-if`.** Use `v-show` for elements toggled often and cheap to keep mounted, such as tabs and dropdowns. Use `v-if` for heavy content that's rarely shown, such as modals and detail panels, so nothing is mounted until it's needed.

**Keys.** Use a stable unique id, not the index. With index keys, a filter or sort reuses DOM and component state for the wrong row, which is both a performance and a correctness issue. The scanner flags these. Confirm there's a real id field to suggest.

## 2. Reactivity cost

**Large data under deep reactivity.** `ref(bigArray)` or `reactive(bigObject)` proxies every nested object. If the data is replaced wholesale (fetched, then reassigned) rather than mutated, use `shallowRef`, and wrap static lookup tables in `markRaw`. This matters from roughly thousands of objects, or for deeply nested API payloads.

**Watchers that should be computeds.** A `watch` that only assigns a derived value to another ref (`watch(a, v => b.value = f(v))`) should be `const b = computed(() => f(a.value))`. That's one less ref, no ordering bugs, and nothing stale on the first render.

**`deep: true` watchers.** These traverse the whole object on every trigger. Watch the specific getter instead (`() => filters.value.category`), or an array of getters.

**Composables called outside setup.** These create effects or closures on every call, and hooks or `inject()` inside them silently fail. Call the composable once in setup and pass its results along.

**Effects created outside a component scope.** A `computed` or `watch` created in a plain function called at runtime is never disposed. If shared state really needs module-level effects, create them once at module level, or use `effectScope()`.

## 3. Loading and bundle size

**Route-level code splitting.** In the router file, `import Dashboard from './views/Dashboard.vue'` puts every page in the initial bundle. Use `component: () => import('./views/Dashboard.vue')` so each page loads when it's first visited. This is usually the biggest single bundle win in a multi-page app.

**Heavy components shown conditionally.** Modals, charts and editors rendered only under `v-if` can use `defineAsyncComponent(() => import('./X.vue'))`. That's worth it when the component, or a library it pulls in, is large.

**Library imports.** Importing a whole library (`import _ from 'lodash'`) for one helper ships all of it. Use per-function imports or a native equivalent.

To measure instead of guess, run `npx vite build` and compare chunk sizes before and after.

## 4. Data fetching

**Waterfalls on mount.** Sequential `await a(); await b(); await c()` calls that don't depend on each other should be `await Promise.all([a(), b(), c()])`.

**The same data fetched by several components.** If several views or modals request the same endpoint, move it into a composable with a shared cache, or a store, so they share one in-flight request.

**Refetching on every filter change with no debounce or cancellation.** Fast filter changes can deliver responses out of order. Debounce, or ignore stale responses (track a request id, or use `AbortController`).

## 5. Reuse: picking the right abstraction

Choose by what's shared:

| What's duplicated                                                | Extract into                                     | Example                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Pure function, no reactivity (formatting, mapping)               | A util module                                    | `formatDate`, `translateCategory`, `getStockStatus`                               |
| Stateful logic plus lifecycle (fetching, toggles, outside-click) | A composable `useX()`                            | `useDropdown()` for toggle/blur handling copied across menus                      |
| Markup and styling with varying content                          | A base component with slots/props                | `BaseModal` (overlay, header, close button, footer slot), `StatCard`, `DataTable` |
| Only styling                                                     | Shared CSS (global stylesheet or a common class) | `.btn-secondary`, `.badge` variants                                               |

Guidelines:

- **Unify the variants before extracting.** When copies have drifted (one `formatDate` handles invalid dates and another doesn't), the shared version should keep the most correct behavior. Point out which copies change behavior as a result, because that is a user-visible change.
- **Extract on the third copy, not the second**, unless two copies are large or have already drifted.
- **A base component should own structure and behavior** (overlay click, Esc to close, focus, transitions), not content. Content goes in slots. If you'd need more than about 6 props to cover every copy, the copies are probably different components.
- **Prefer explicit props and emits over reaching into parents.** Watch for prop drilling three or more levels deep. That's a sign for `provide`/`inject`, or for a composable holding shared state.
- Estimate the payoff: "removes ~N duplicated lines across M files". That makes reuse comparable with performance items when ranking.

## 6. Component boundaries

**Oversized components** (over about 500 lines, or a template with several unrelated sections): split along the visual sections. Each card or panel with its own data becomes a child component, and its derivations become a composable. A smaller component also re-renders less, because a child only updates when its own props or state change.

**Mixed responsibilities**: if one component fetches, transforms, formats and renders several unrelated widgets, a good split is a container that fetches data (or a composable that does) plus presentational children that receive props.

**Scoped styles that are mostly copies**: if most of a component's `<style scoped>` matches other files, move the shared part to a global stylesheet and keep only the component-specific rules scoped.
