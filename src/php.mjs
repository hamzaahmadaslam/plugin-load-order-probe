// Parsing PHP and resolving the names it uses. Nothing here runs the code.
import { Engine } from "php-parser";

const engine = new Engine({
  parser: { php8: true, suppressErrors: true },
  ast: { withPositions: true },
});

/** Parses one file; a file that cannot be parsed returns null. */
export function parsePhp(code, file) {
  try {
    return engine.parseCode(code, file);
  } catch {
    return null;
  }
}

/** The body statements of a node that holds a list: program, namespace, block, or a branch that is one statement. */
export function statementsOf(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  if (node.kind === "block" || node.kind === "program" || node.kind === "namespace") return node.children ?? [];
  return [node];
}

/**
 * The names a file refers to are relative to its namespace and its `use` statements. A scope object follows the
 * file statement by statement; `resolveClass` and `resolveFunction` give fully qualified names without a leading
 * backslash.
 */
export class NameScope {
  constructor() {
    this.namespace = "";
    this.classes = new Map();
    this.functions = new Map();
  }
  /** A scope as it was where a class or function was declared: its namespace and its imports. */
  static at(namespace, uses) {
    const scope = new NameScope();
    scope.enterNamespace(namespace ?? "");
    if (uses) {
      scope.classes = new Map(uses.classes);
      scope.functions = new Map(uses.functions);
    }
    return scope;
  }
  enterNamespace(name) {
    this.namespace = name ? String(name).replace(/^\\/, "") : "";
    this.classes = new Map();
    this.functions = new Map();
  }
  addUse(group) {
    const prefix = group.name ? `${String(group.name).replace(/^\\/, "")}\\` : "";
    for (const item of group.items ?? []) {
      const full = `${prefix}${String(item.name).replace(/^\\/, "")}`;
      const alias = item.alias?.name ?? full.split("\\").pop();
      const type = item.type ?? group.type;
      (type === "function" ? this.functions : this.classes).set(alias.toLowerCase(), full);
    }
  }
  qualify(raw) {
    return this.namespace ? `${this.namespace}\\${raw}` : raw;
  }
  resolveClass(nameNode) {
    if (!nameNode || nameNode.kind !== "name") return null;
    const raw = String(nameNode.name);
    if (["self", "static", "parent"].includes(raw.toLowerCase())) return null;
    if (nameNode.resolution === "fqn" || raw.startsWith("\\")) return raw.replace(/^\\/, "");
    const [first, ...rest] = raw.split("\\");
    const used = this.classes.get(first.toLowerCase());
    if (used) return rest.length ? `${used}\\${rest.join("\\")}` : used;
    return this.qualify(raw);
  }
  /** Functions fall back to the global name at run time; both candidates are returned, namespaced first. */
  resolveFunction(nameNode) {
    if (!nameNode || nameNode.kind !== "name") return [];
    const raw = String(nameNode.name);
    if (nameNode.resolution === "fqn" || raw.startsWith("\\")) return [raw.replace(/^\\/, "")];
    const used = this.functions.get(raw.toLowerCase());
    if (used) return [used];
    return this.namespace && !raw.includes("\\") ? [this.qualify(raw), raw] : [this.qualify(raw)];
  }
}

/** A plugin header ("Plugin Name: …") in the first 8 KB of a file, as WordPress reads it. */
export function pluginName(code) {
  const match = /^[ \t/*#@]*Plugin Name:(.*)$/im.exec(code.slice(0, 8192));
  return match ? match[1].trim() : null;
}
