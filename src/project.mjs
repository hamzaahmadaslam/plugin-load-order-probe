// The plugins to check: their main files, every PHP file, and what each declares.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NameScope, parsePhp, pluginName, statementsOf } from "./php.mjs";

/**
 * Providers known without their source: plugins so often depended on that a check should not need a copy of them.
 * `classes` match class names exactly, `prefixes` their start, and `functions` function names (a trailing underscore
 * makes it a prefix), all case-insensitively. `file` is where WordPress keeps
 * the plugin in its active list, which decides where it sorts.
 */
export const KNOWN_PROVIDERS = {
  woocommerce: {
    name: "WooCommerce",
    file: "woocommerce/woocommerce.php",
    classes: ["WooCommerce"],
    prefixes: ["WC_", "Automattic\\WooCommerce\\"],
    functions: ["WC", "wc_"],
  },
};

const SKIP_DIRS = new Set(["node_modules", ".git", "tests", "test"]);

function phpFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(full);
      } else if (/\.php$/i.test(name)) out.push(full);
    }
  };
  visit(root);
  return out;
}

/** A plugin folder's main file: the PHP file at its top level with a Plugin Name header. */
function mainFileOf(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (/\.php$/i.test(name) && statSync(full).isFile() && pluginName(readFileSync(full, "utf8"))) return full;
  }
  return null;
}

/**
 * Loads plugins from a plugins folder (each subfolder with a main file, and single-file plugins at the top), and
 * must-use plugins from an optional mu-plugins folder (every PHP file at its top level, as WordPress loads them).
 * `slug` is the folder name; `file` is the "folder/main.php" path WordPress stores in active_plugins.
 */
export function loadProject({ pluginsDir, muDir = null, only = null, singleSlug = null }) {
  const plugins = [];
  if (pluginsDir && existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir).sort()) {
      // One plugin on its own: its neighbours in the folder are not read.
      if (singleSlug && name !== singleSlug) continue;
      const full = path.join(pluginsDir, name);
      if (statSync(full).isDirectory()) {
        const main = mainFileOf(full);
        if (main) plugins.push({ slug: name, file: `${name}/${path.basename(main)}`, main, root: full, mu: false });
      } else if (/\.php$/i.test(name) && pluginName(readFileSync(full, "utf8"))) {
        plugins.push({ slug: name.replace(/\.php$/i, ""), file: name, main: full, root: null, mu: false, single: true });
      }
    }
  }
  if (muDir && existsSync(muDir)) {
    for (const name of readdirSync(muDir).sort()) {
      const full = path.join(muDir, name);
      if (/\.php$/i.test(name) && statSync(full).isFile()) {
        plugins.push({ slug: `mu:${name.replace(/\.php$/i, "")}`, file: name, main: full, root: null, mu: true, single: true });
      }
    }
  }
  const files = new Map();
  for (const plugin of plugins) {
    const list = plugin.root ? phpFiles(plugin.root) : [plugin.main];
    for (const file of list) files.set(path.resolve(file), { plugin, code: null, ast: undefined });
  }
  const project = { plugins: only ? plugins.filter((p) => only.includes(p.slug)) : plugins, all: plugins, files };
  project.declarations = declarations(project);
  return project;
}

/** A file's parsed tree, read on first use and kept. */
export function fileAst(project, file) {
  const entry = project.files.get(path.resolve(file));
  if (!entry) return null;
  if (entry.ast === undefined) {
    entry.code = readFileSync(file, "utf8");
    entry.ast = parsePhp(entry.code, file);
  }
  return entry.ast;
}

export const ownerOfFile = (project, file) => project.files.get(path.resolve(file))?.plugin ?? null;

/** The `use` imports in force where something is declared, so its body resolves names as PHP does. */
const snapshot = (scope) => ({ classes: new Map(scope.classes), functions: new Map(scope.functions) });

/**
 * Every class, interface, trait, enum and function the loaded plugins declare, keyed by lower-cased fully qualified
 * name: { plugin, file, node, kind, methods } (methods for classes, by lower-cased name).
 */
function declarations(project) {
  const index = { classes: new Map(), functions: new Map() };
  for (const [file, { plugin }] of project.files) {
    const ast = fileAst(project, file);
    if (!ast) continue;
    const scope = new NameScope();
    const visit = (statements) => {
      for (const node of statements) {
        if (!node || typeof node !== "object") continue;
        if (node.kind === "namespace") {
          scope.enterNamespace(node.name);
          visit(node.children ?? []);
        } else if (node.kind === "usegroup") {
          scope.addUse(node);
        } else if (["class", "interface", "trait", "enum"].includes(node.kind) && node.name?.name) {
          const fqn = scope.qualify(node.name.name);
          const methods = new Map();
          for (const member of node.body ?? []) {
            if (member.kind === "method") methods.set(String(member.name?.name ?? member.name).toLowerCase(), member);
          }
          if (!index.classes.has(fqn.toLowerCase())) {
            index.classes.set(fqn.toLowerCase(), { plugin, file, node, kind: node.kind, fqn, methods, namespace: scope.namespace, uses: snapshot(scope) });
          }
        } else if (node.kind === "function" && node.name?.name) {
          const fqn = scope.qualify(node.name.name);
          if (!index.functions.has(fqn.toLowerCase())) {
            index.functions.set(fqn.toLowerCase(), { plugin, file, node, fqn, namespace: scope.namespace, uses: snapshot(scope) });
          }
        } else if (node.kind === "if") {
          // Classes declared inside `if ( ! class_exists( ... ) )` are still this plugin's.
          visit(statementsOf(node.body));
          if (node.alternate) visit(statementsOf(node.alternate));
        } else if (node.kind === "block") {
          visit(node.children ?? []);
        }
      }
    };
    visit(ast.children ?? []);
  }
  return index;
}

/** Which plugin provides a class or function: a loaded plugin that declares it, or a known provider by prefix. */
export function providerOf(project, kind, fqn, providers = KNOWN_PROVIDERS) {
  const table = kind === "class" ? project.declarations.classes : project.declarations.functions;
  const declared = table.get(fqn.toLowerCase());
  if (declared) return { slug: declared.plugin.slug, file: declared.plugin.file, mu: declared.plugin.mu, name: providers[declared.plugin.slug]?.name ?? declared.plugin.slug, declared };
  const plain = fqn.toLowerCase();
  for (const [slug, provider] of Object.entries(providers)) {
    const match =
      kind === "class"
        ? (provider.classes ?? []).some((c) => plain === c.toLowerCase()) ||
          (provider.prefixes ?? []).some((p) => plain.startsWith(p.toLowerCase()))
        : (provider.functions ?? []).some((p) => (p.endsWith("_") ? plain.startsWith(p.toLowerCase()) : plain === p.toLowerCase()));
    if (match) return { slug, file: provider.file, mu: false, name: provider.name, declared: null };
  }
  return null;
}
