#!/usr/bin/env node
// Static scanner for Vue 3 single-file components.
//
// Measures each .vue file and flags mechanical problems (missing v-for keys,
// unresolved components, composables called outside setup, duplicated helpers,
// repeated markup, duplicated CSS) so the reviewing model can spend its effort
// on judgement instead of counting. It never edits anything.
//
// Usage:
//   node scan-vue.mjs <dir-or-file>... [--json out.json] [--min-dup 8] [--root <app dir>]
//
// vue/compiler-sfc is loaded from the scanned project's own node_modules, so
// the parser always matches the Vue version the app actually uses.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

// ---------- CLI ----------
const argv = process.argv.slice(2);
const targets = [];
let jsonOut = null;
let minDup = 8;
let root = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json") jsonOut = argv[++i];
  else if (argv[i] === "--min-dup") minDup = Number(argv[++i]);
  else if (argv[i] === "--root") root = argv[++i];
  else if (argv[i] === "-h" || argv[i] === "--help") {
    console.log(
      "Usage: node scan-vue.mjs <dir-or-file>... [--json out.json] [--min-dup 8] [--root <app-dir-with-node_modules>]",
    );
    process.exit(0);
  } else targets.push(argv[i]);
}
if (targets.length === 0) targets.push(fs.existsSync("src") ? "src" : ".");

// ---------- locate vue/compiler-sfc ----------
function loadCompiler(start) {
  let dir = path.resolve(start);
  if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  // Walk upward: in a monorepo the .vue files may sit below the package root.
  while (true) {
    if (fs.existsSync(path.join(dir, "node_modules", "vue", "package.json"))) {
      const req = createRequire(path.join(dir, "package.json"));
      return {
        sfc: req("vue/compiler-sfc"),
        vueVersion: req("vue/package.json").version,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error(
    `Could not find node_modules/vue above ${start}. Run npm install in the app first.`,
  );
  process.exit(2);
}
// --root only matters when the scanned files live outside the app (e.g. fixtures).
const { sfc, vueVersion } = loadCompiler(root || targets[0]);

// ---------- collect files ----------
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".nuxt",
  ".output",
  "coverage",
]);
function collect(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (p.endsWith(".vue")) out.push(p);
    return;
  }
  for (const name of fs.readdirSync(p)) {
    if (SKIP_DIRS.has(name)) continue;
    collect(path.join(p, name), out);
  }
}
const files = [];
for (const t of targets) collect(t, files);
files.sort();

const cwd = process.cwd();
// Paths relative to cwd stay clickable; anything outside cwd is shown absolute.
const rel = (f) => {
  const r = path.relative(cwd, path.resolve(f));
  return r.startsWith("..") ? path.resolve(f) : r || f;
};
const hash = (s) =>
  crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

// Tags that resolve globally without an import (Vue built-ins + vue-router).
const GLOBAL_COMPONENTS = new Set([
  "component",
  "transition",
  "transition-group",
  "keep-alive",
  "teleport",
  "suspense",
  "slot",
  "template",
  "router-link",
  "router-view",
]);
const toKebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

// Template AST node types from @vue/compiler-core.
const NT = {
  ELEMENT: 1,
  TEXT: 2,
  COMMENT: 3,
  SIMPLE_EXPRESSION: 4,
  INTERPOLATION: 5,
  ATTRIBUTE: 6,
  DIRECTIVE: 7,
};
const TAG = { ELEMENT: 0, COMPONENT: 1, SLOT: 2, TEMPLATE: 3 };

const components = [];
const findings = [];
const templateSubtrees = new Map(); // structural hash -> [{file, line, size, tag, id, ancestors}]
const functionDefs = []; // {file, name, line, lines, bodyHash}
const cssRules = []; // {file, selector, body, line}
let nodeSeq = 0;

function add(file, line, rule, message, severity = "warn") {
  findings.push({ file: rel(file), line, rule, severity, message });
}

// ---------- template analysis ----------
function exprText(p) {
  if (p.type === NT.DIRECTIVE) return p.exp ? p.exp.content : "";
  return "";
}
function getDir(node, name) {
  return node.props.find((p) => p.type === NT.DIRECTIVE && p.name === name);
}
function getKey(node) {
  return node.props.find(
    (p) =>
      (p.type === NT.ATTRIBUTE && p.name === "key") ||
      (p.type === NT.DIRECTIVE &&
        p.name === "bind" &&
        p.arg &&
        p.arg.content === "key"),
  );
}
function parseFor(exp) {
  // "(item, index) in items" / "item of items" -> aliases + source
  const m = exp.match(/^\s*\(?([^)]*?)\)?\s+(?:in|of)\s+([\s\S]+)$/);
  if (!m) return { aliases: [], source: exp };
  return {
    aliases: m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    source: m[2].trim(),
  };
}
// Structural signature: tags, attribute names, static class/type values and
// directive names, but no text or bound expressions, so two cards that differ
// only in labels and data still match.
function signature(node) {
  if (node.type !== NT.ELEMENT) return "";
  const attrs = node.props
    .map((p) => {
      if (p.type === NT.ATTRIBUTE)
        return p.name === "class" || p.name === "type"
          ? `${p.name}=${p.value?.content}`
          : p.name;
      return `v-${p.name}${p.arg ? ":" + (p.arg.content || "") : ""}`;
    })
    .sort()
    .join(",");
  return `<${node.tag} ${attrs}>${node.children.map(signature).filter(Boolean).join("")}</>`;
}
function elementCount(node) {
  if (node.type !== NT.ELEMENT) return 0;
  return 1 + node.children.reduce((a, c) => a + elementCount(c), 0);
}
const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
const ARRAY_OP_RE = /\.(filter|sort|map|reduce|slice|find|toSorted)\s*\(/;

function analyzeTemplate(file, ast, info) {
  let maxDepth = 0;
  const used = new Map(); // component tag -> first line

  function visit(node, depth, loops, ancestors) {
    if (node.type === NT.INTERPOLATION || node.type === NT.ELEMENT) {
      const exprs =
        node.type === NT.INTERPOLATION
          ? [node.content.content]
          : node.props.map(exprText);
      for (const e of exprs) {
        if (!e) continue;
        if (ARRAY_OP_RE.test(e)) {
          add(
            file,
            node.loc.start.line,
            "template-array-op",
            `Array ${e.match(ARRAY_OP_RE)[1]}() inside template expression \`${e.trim().slice(0, 80)}\` re-runs on every render; move it into a computed`,
          );
        }
        // Calls inside v-for run once per row per render; count them per loop.
        if (loops.length) {
          for (const m of e.matchAll(CALL_RE))
            loops[loops.length - 1].calls.add(m[1]);
        }
      }
    }
    if (node.type !== NT.ELEMENT) return;
    const id = ++nodeSeq;
    maxDepth = Math.max(maxDepth, depth);
    info.elements++;

    if (node.tagType === TAG.COMPONENT) {
      if (!used.has(node.tag)) used.set(node.tag, node.loc.start.line);
    }

    const vfor = getDir(node, "for");
    let loop = null;
    if (vfor) {
      info.vfor++;
      const { aliases, source } = parseFor(vfor.exp ? vfor.exp.content : "");
      const key = getKey(node);
      const line = node.loc.start.line;
      if (!key && node.tag !== "template") {
        add(
          file,
          line,
          "vfor-no-key",
          `v-for over \`${source}\` has no :key`,
          "error",
        );
      } else if (key && key.type === NT.DIRECTIVE && aliases.length > 1) {
        const k = key.exp ? key.exp.content.trim() : "";
        if (k === aliases[aliases.length - 1]) {
          add(
            file,
            line,
            "vfor-index-key",
            `v-for over \`${source}\` uses the index \`${k}\` as :key; use a stable id so rows are not re-created on reorder/filter`,
          );
        }
      }
      if (getDir(node, "if")) {
        add(
          file,
          line,
          "vfor-with-vif",
          `v-if on the same element as v-for over \`${source}\`; filter in a computed instead`,
        );
      }
      if (/\(/.test(source) && !/^\d/.test(source)) {
        add(
          file,
          line,
          "vfor-call-source",
          `v-for source \`${source}\` is a function call evaluated every render; use a computed`,
        );
      }
      if (loops.length >= 1) {
        add(
          file,
          line,
          "nested-vfor",
          `v-for nested ${loops.length + 1} deep (over \`${source}\`); consider a child component or precomputed rows`,
          "info",
        );
      }
      loop = { line, source, calls: new Set() };
      loops = [...loops, loop];
    }

    const size = elementCount(node);
    if (size >= minDup) {
      const sig = hash(signature(node));
      if (!templateSubtrees.has(sig)) templateSubtrees.set(sig, []);
      templateSubtrees.get(sig).push({
        file: rel(file),
        line: node.loc.start.line,
        size,
        tag: node.tag,
        id,
        ancestors,
      });
    }

    // Sibling repetition: 3+ structurally identical consecutive siblings are
    // usually hand-unrolled data and read better as a v-for over an array.
    const kids = node.children.filter((c) => c.type === NT.ELEMENT);
    for (let i = 0; i < kids.length;) {
      const s = signature(kids[i]);
      let j = i + 1;
      while (
        j < kids.length &&
        signature(kids[j]) === s &&
        !getDir(kids[j], "for")
      )
        j++;
      if (
        j - i >= 3 &&
        elementCount(kids[i]) >= 2 &&
        !getDir(kids[i], "for") &&
        !getDir(kids[i], "if")
      ) {
        add(
          file,
          kids[i].loc.start.line,
          "repeated-siblings",
          `${j - i} identical <${kids[i].tag}${classOf(kids[i])}> siblings; drive them from an array with v-for (or extract a component)`,
          "info",
        );
      }
      i = j;
    }

    const nextAnc = [...ancestors, id];
    for (const c of node.children) visit(c, depth + 1, loops, nextAnc);

    if (loop && loop.calls.size) {
      const calls = [...loop.calls].filter((n) => n !== "t" && n !== "$t");
      if (calls.length >= 3) {
        add(
          file,
          loop.line,
          "calls-in-loop",
          `v-for over \`${loop.source}\` calls ${calls.length} functions per row (${calls.slice(0, 6).join(", ")}); precompute display fields in a computed when the list is large`,
          "info",
        );
      }
    }
  }
  for (const c of ast.children) visit(c, 1, [], []);
  info.templateDepth = maxDepth;
  return used;
}
function classOf(node) {
  const c = node.props.find(
    (p) => p.type === NT.ATTRIBUTE && p.name === "class",
  );
  return c && c.value ? ` class="${c.value.content}"` : "";
}

// ---------- script analysis ----------
const REACTIVE_APIS = [
  "ref",
  "reactive",
  "shallowRef",
  "shallowReactive",
  "computed",
  "watch",
  "watchEffect",
  "markRaw",
  "provide",
  "inject",
];

function analyzeScript(
  file,
  block,
  lineOffset,
  isSetup,
  info,
  imports,
  registered,
) {
  let ast;
  try {
    const plugins = /ts|tsx/.test(block.lang || "") ? ["typescript"] : [];
    ast = sfc.babelParse(block.content, {
      sourceType: "module",
      plugins: [...plugins, "jsx"],
    });
  } catch (e) {
    add(
      file,
      lineOffset + 1,
      "parse-error",
      `Could not parse <script>: ${e.message}`,
      "error",
    );
    return;
  }
  const src = block.content;
  const L = (n) => (n.loc ? n.loc.start.line + lineOffset : lineOffset);

  function calleeName(n) {
    if (!n.callee) return null;
    if (n.callee.type === "Identifier") return n.callee.name;
    if (
      n.callee.type === "MemberExpression" &&
      n.callee.property.type === "Identifier"
    )
      return n.callee.property.name;
    return null;
  }
  function fnName(n, parent) {
    if (n.id && n.id.name) return n.id.name;
    if (
      parent &&
      parent.type === "VariableDeclarator" &&
      parent.id.type === "Identifier"
    )
      return parent.id.name;
    if (
      parent &&
      (parent.type === "ObjectProperty" || parent.type === "ObjectMethod") &&
      parent.key
    )
      return parent.key.name || parent.key.value;
    if (n.type === "ObjectMethod" && n.key) return n.key.name;
    return null;
  }
  // Composables are only safe where setup runs synchronously: top level of
  // <script setup>, inside setup(), or inside another composable.
  function setupLike(name) {
    return name === "setup" || /^use[A-Z]/.test(name || "");
  }

  function walk(n, parent, fnStack) {
    if (!n || typeof n.type !== "string") return;
    const isFn = /Function|ArrowFunction|ObjectMethod|ClassMethod/.test(n.type);
    if (isFn) {
      const name = fnName(n, parent);
      fnStack = [...fnStack, name];
      if (
        name &&
        n.body &&
        n.body.type === "BlockStatement" &&
        name !== "setup" &&
        name !== "data"
      ) {
        const body = src.slice(n.body.start, n.body.end);
        const norm = body.replace(/\/\/.*$/gm, "").replace(/\s+/g, "");
        const lines = n.loc.end.line - n.loc.start.line + 1;
        if (norm.length > 40)
          functionDefs.push({
            file: rel(file),
            name,
            line: L(n),
            lines,
            bodyHash: hash(norm),
          });
        if (lines > 60)
          add(
            file,
            L(n),
            "long-function",
            `\`${name}\` is ${lines} lines; split it or move logic into a composable/util`,
            "info",
          );
      }
    }
    if (n.type === "ImportDeclaration") {
      const from = n.source.value;
      for (const s of n.specifiers) {
        imports.set(s.local.name, { from, line: L(n) });
      }
    }
    if (n.type === "CallExpression") {
      const name = calleeName(n);
      if (name && REACTIVE_APIS.includes(name))
        info.api[name] = (info.api[name] || 0) + 1;
      if (name && /^on[A-Z]/.test(name) && n.callee.type === "Identifier")
        info.api.lifecycle = (info.api.lifecycle || 0) + 1;
      if (name === "watch") {
        const opts = n.arguments[2];
        if (
          opts &&
          opts.type === "ObjectExpression" &&
          opts.properties.some(
            (p) => p.key && p.key.name === "deep" && p.value.value === true,
          )
        ) {
          add(
            file,
            L(n),
            "deep-watch",
            "deep: true watcher traverses the whole object on every change; watch a specific getter instead",
            "info",
          );
        }
      }
      if (name && /^use[A-Z]/.test(name) && n.callee.type === "Identifier") {
        const enclosing = fnStack[fnStack.length - 1];
        const atTop = fnStack.length === 0 && isSetup;
        if (!atTop && !setupLike(enclosing) && fnStack.length > 0) {
          add(
            file,
            L(n),
            "composable-outside-setup",
            // Severity depends on the composable: harmless-but-wasteful for a
            // module singleton, a real bug if it registers hooks or calls inject().
            // The scanner can't tell, so it reports "warn" and the reviewer reads it.
            `\`${name}()\` is called inside \`${enclosing || "anonymous function"}\` instead of setup, so it re-runs on every call (often once per row per render). Read the composable: if it uses lifecycle hooks, inject() or creates state, this is a bug; otherwise it is avoidable overhead. Call it once in setup and reuse the result`,
            "warn",
          );
        }
      }
      if (
        name === "defineComponent" ||
        name === "defineProps" ||
        name === "defineEmits"
      ) {
        if (name === "defineProps") info.propsDeclared = true;
      }
    }
    // Options API: components: { A, B } and props: [...]/{...}
    if (
      n.type === "ObjectProperty" &&
      n.key &&
      n.key.name === "components" &&
      n.value.type === "ObjectExpression"
    ) {
      for (const p of n.value.properties)
        if (p.key) registered.add(p.key.name || p.key.value);
    }
    if (n.type === "ObjectProperty" && n.key && n.key.name === "props")
      info.propsDeclared = true;
    if (n.type === "ObjectProperty" && n.key && n.key.name === "emits")
      info.emitsDeclared = true;
    if (n.type === "CallExpression" && calleeName(n) === "defineEmits")
      info.emitsDeclared = true;

    for (const k of Object.keys(n)) {
      if (
        k === "loc" ||
        k === "start" ||
        k === "end" ||
        k === "leadingComments" ||
        k === "trailingComments"
      )
        continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, n, fnStack));
      else if (v && typeof v.type === "string") walk(v, n, fnStack);
    }
  }
  walk(ast.program, null, []);

  // $emit usage without an emits declaration hides the component's API.
  if (/\$?emit\(\s*['"]/.test(src) && !info.emitsDeclared) {
    add(
      file,
      lineOffset + 1,
      "undeclared-emits",
      "Component emits events but declares no `emits` / defineEmits; declare them so the API is explicit and listeners are not treated as fallthrough attrs",
      "info",
    );
  }
}

// ---------- style analysis ----------
function analyzeStyles(file, styles) {
  for (const st of styles) {
    // Simple flat-rule extraction; nested at-rules contribute their inner rules.
    const css = st.content.replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}@]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const selector = m[1].trim().replace(/\s+/g, " ");
      const decls = m[2]
        .split(";")
        .map((d) => d.trim().replace(/\s+/g, " "))
        .filter(Boolean)
        .sort();
      if (decls.length < 3 || !selector) continue;
      const line =
        st.loc.start.line + css.slice(0, m.index).split("\n").length - 1;
      cssRules.push({
        file: rel(file),
        selector,
        body: decls.join(";"),
        line,
        scoped: !!st.scoped,
      });
    }
  }
}

// ---------- per-file ----------
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const { descriptor, errors } = sfc.parse(source, { filename: file });
  const info = {
    file: rel(file),
    lines: source.split("\n").length,
    templateLines: 0,
    scriptLines: 0,
    styleLines: 0,
    style: descriptor.scriptSetup
      ? "script-setup"
      : descriptor.script
        ? "options/setup()"
        : "none",
    lang: (descriptor.scriptSetup || descriptor.script || {}).lang || "js",
    elements: 0,
    templateDepth: 0,
    vfor: 0,
    api: {},
    scopedStyles: descriptor.styles.length
      ? descriptor.styles.every((s) => s.scoped)
      : null,
  };
  for (const e of errors)
    add(
      file,
      e.loc ? e.loc.start.line : 1,
      "parse-error",
      String(e.message || e),
      "error",
    );

  const imports = new Map();
  const registered = new Set();
  for (const block of [descriptor.script, descriptor.scriptSetup].filter(
    Boolean,
  )) {
    info.scriptLines += block.content.split("\n").length;
    analyzeScript(
      file,
      block,
      block.loc.start.line - 1,
      block === descriptor.scriptSetup,
      info,
      imports,
      registered,
    );
  }

  let used = new Map();
  if (descriptor.template && descriptor.template.ast) {
    info.templateLines = descriptor.template.content.split("\n").length;
    used = analyzeTemplate(file, descriptor.template.ast, info);
  }
  info.styleLines = descriptor.styles.reduce(
    (a, s) => a + s.content.split("\n").length,
    0,
  );
  analyzeStyles(file, descriptor.styles);

  // Component resolution. With <script setup> every import is in scope; with
  // the options API only names listed in `components` are.
  const importedVue = [...imports.entries()].filter(([, v]) =>
    v.from.endsWith(".vue"),
  );
  const available = new Set(
    descriptor.scriptSetup ? [...imports.keys()] : [...registered],
  );
  const availKebab = new Set([...available].map(toKebab));
  for (const [tag, line] of used) {
    const k = toKebab(tag);
    if (GLOBAL_COMPONENTS.has(k)) continue;
    if (!available.has(tag) && !availKebab.has(k)) {
      const hint = imports.has(tag)
        ? " (imported but not listed in `components`)"
        : "";
      add(
        file,
        line,
        "unresolved-component",
        `<${tag}> is used in the template but never imported/registered${hint}; it renders as an unknown element`,
        "error",
      );
    }
  }
  const usedKebab = new Set([...used.keys()].map(toKebab));
  for (const [name, v] of importedVue) {
    if (!usedKebab.has(toKebab(name)))
      add(
        file,
        v.line,
        "unused-component-import",
        `${name} is imported from ${v.from} but not used in the template`,
        "info",
      );
  }
  // Static import of a component that only shows inside v-if is a lazy-load candidate.
  info.childComponents = importedVue.length;

  if (info.lines > 500)
    add(
      file,
      1,
      "large-component",
      `${info.lines} lines (template ${info.templateLines}, script ${info.scriptLines}, style ${info.styleLines}); split into child components/composables`,
      info.lines > 900 ? "warn" : "info",
    );
  components.push(info);
}

// ---------- cross-file: duplicated markup ----------
const dupGroups = [];
const covered = new Set();
const groups = [...templateSubtrees.values()]
  .filter((g) => g.length >= 2)
  .sort((a, b) => b[0].size - a[0].size);
for (const g of groups) {
  // Report only the outermost duplicate: skip a group whose every occurrence
  // sits inside an already-reported duplicate.
  if (g.every((o) => o.ancestors.some((a) => covered.has(a)))) continue;
  g.forEach((o) => covered.add(o.id));
  const fileSet = new Set(g.map((o) => o.file));
  dupGroups.push({
    size: g[0].size,
    tag: g[0].tag,
    occurrences: g.map(({ file, line }) => ({ file, line })),
    crossFile: fileSet.size > 1,
  });
}

// ---------- cross-file: duplicated functions ----------
const byName = new Map();
for (const f of functionDefs) {
  if (!byName.has(f.name)) byName.set(f.name, []);
  byName.get(f.name).push(f);
}
const dupFunctions = [];
for (const [name, defs] of byName) {
  const fileSet = new Set(defs.map((d) => d.file));
  if (fileSet.size < 2) continue;
  const variants = new Set(defs.map((d) => d.bodyHash)).size;
  dupFunctions.push({
    name,
    identical: variants === 1,
    variants,
    occurrences: defs.map(({ file, line, lines }) => ({ file, line, lines })),
  });
}
const byBody = new Map();
for (const f of functionDefs) {
  if (!byBody.has(f.bodyHash)) byBody.set(f.bodyHash, []);
  byBody.get(f.bodyHash).push(f);
}
for (const defs of byBody.values()) {
  const names = new Set(defs.map((d) => d.name));
  if (defs.length >= 2 && names.size > 1) {
    dupFunctions.push({
      name: [...names].join(" / "),
      identical: true,
      variants: 1,
      renamed: true,
      occurrences: defs.map(({ file, line, lines, name }) => ({
        file,
        line,
        lines,
        name,
      })),
    });
  }
}
dupFunctions.sort((a, b) => b.occurrences.length - a.occurrences.length);

// ---------- cross-file: duplicated CSS ----------
const cssByBody = new Map();
for (const r of cssRules) {
  if (!cssByBody.has(r.body)) cssByBody.set(r.body, []);
  cssByBody.get(r.body).push(r);
}
const dupCss = [...cssByBody.values()]
  .filter((rs) => new Set(rs.map((r) => r.file)).size >= 2)
  .map((rs) => ({
    declarations: rs[0].body.split(";").length,
    occurrences: rs.map(({ file, selector, line }) => ({
      file,
      selector,
      line,
    })),
  }))
  .sort(
    (a, b) =>
      b.occurrences.length * b.declarations -
      a.occurrences.length * a.declarations,
  );

// ---------- output ----------
const result = {
  vueVersion,
  scanned: files.length,
  minDup,
  components,
  findings,
  duplicates: { markup: dupGroups, functions: dupFunctions, css: dupCss },
};
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2));

const out = [];
out.push(
  `# Vue component scan`,
  "",
  `Vue ${vueVersion} · ${files.length} components · ${findings.length} findings`,
  "",
);
out.push("## Components (largest first)", "");
out.push(
  "| File | Lines | Tpl/Script/Style | Script style | Elements | Depth | v-for | ref | computed | watch |",
);
out.push("|---|---:|---|---|---:|---:|---:|---:|---:|---:|");
for (const c of [...components].sort((a, b) => b.lines - a.lines)) {
  out.push(
    `| ${c.file} | ${c.lines} | ${c.templateLines}/${c.scriptLines}/${c.styleLines} | ${c.style} | ${c.elements} | ${c.templateDepth} | ${c.vfor} | ${c.api.ref || 0} | ${c.api.computed || 0} | ${(c.api.watch || 0) + (c.api.watchEffect || 0)} |`,
  );
}
const sevOrder = { error: 0, warn: 1, info: 2 };
const byRule = new Map();
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, []);
  byRule.get(f.rule).push(f);
}
out.push("", "## Findings by rule", "");
for (const [rule, fs_] of [...byRule.entries()].sort(
  (a, b) =>
    sevOrder[a[1][0].severity] - sevOrder[b[1][0].severity] ||
    b[1].length - a[1].length,
)) {
  out.push(`### ${rule} (${fs_[0].severity}, ${fs_.length})`);
  for (const f of fs_.slice(0, 25))
    out.push(`- ${f.file}:${f.line} — ${f.message}`);
  if (fs_.length > 25) out.push(`- … ${fs_.length - 25} more (see --json)`);
  out.push("");
}
out.push("## Duplicated helper functions", "");
if (!dupFunctions.length) out.push("None found.");
for (const d of dupFunctions.slice(0, 20)) {
  const label = d.renamed
    ? `identical body under names ${d.name}`
    : d.identical
      ? "identical"
      : `${d.variants} different versions`;
  out.push(
    `- \`${d.name.split(" / ")[0]}\` ×${d.occurrences.length} (${label}): ${d.occurrences.map((o) => `${o.file}:${o.line}`).join(", ")}`,
  );
}
out.push(
  "",
  `## Duplicated markup (structurally identical subtrees of ${minDup}+ elements)`,
  "",
);
if (!dupGroups.length) out.push("None found.");
for (const g of dupGroups.slice(0, 15)) {
  out.push(
    `- <${g.tag}> ${g.size} elements ×${g.occurrences.length}${g.crossFile ? " across files" : " in one file"}: ${g.occurrences.map((o) => `${o.file}:${o.line}`).join(", ")}`,
  );
}
out.push("", "## Duplicated CSS rule bodies (3+ declarations, 2+ files)", "");
if (!dupCss.length) out.push("None found.");
for (const d of dupCss.slice(0, 15)) {
  out.push(
    `- ${d.declarations} declarations ×${d.occurrences.length}: ${d.occurrences.map((o) => `${o.file}:${o.line} \`${o.selector}\``).join(", ")}`,
  );
}
console.log(out.join("\n"));
