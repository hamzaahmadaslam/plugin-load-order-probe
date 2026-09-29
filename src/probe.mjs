// What a plugin runs while WordPress is still loading plugins, and which other plugins' code that touches.
import path from "node:path";
import { NameScope, statementsOf } from "./php.mjs";
import { fileAst, KNOWN_PROVIDERS, ownerOfFile, providerOf } from "./project.mjs";

const EXISTS = new Set(["class_exists", "interface_exists", "trait_exists", "enum_exists", "function_exists"]);
const FUNCTION_LIKE = new Set(["closure", "arrowfunc", "function", "method"]);
const MAX_DEPTH = 12;

/** A path expression WordPress plugins use for includes, evaluated statically; null when it depends on run time. */
function evalPath(expr, env) {
  if (!expr) return null;
  switch (expr.kind) {
    case "string":
      return expr.value;
    case "magic":
      if (expr.value === "__FILE__") return env.file;
      if (expr.value === "__DIR__") return path.dirname(env.file);
      return null;
    case "bin": {
      if (expr.type !== ".") return null;
      const left = evalPath(expr.left, env);
      const right = evalPath(expr.right, env);
      return left === null || right === null ? null : left + right;
    }
    case "name":
      return env.consts.get(String(expr.name).replace(/^\\/, "")) ?? null;
    case "encapsed": {
      let out = "";
      for (const part of expr.value) {
        const value = evalPath(part.expression, env);
        if (value === null) return null;
        out += value;
      }
      return out;
    }
    case "call": {
      const fn = expr.what?.kind === "name" ? String(expr.what.name).replace(/^\\/, "").toLowerCase() : "";
      const arg = evalPath(expr.arguments[0], env);
      if (arg === null) return null;
      if (fn === "dirname") {
        const levels = expr.arguments[1]?.kind === "number" ? Number(expr.arguments[1].value) : 1;
        let out = arg;
        for (let i = 0; i < levels; i++) out = path.dirname(out);
        return out;
      }
      if (fn === "plugin_dir_path" || fn === "trailingslashit") return fn === "plugin_dir_path" ? `${path.dirname(arg)}/` : `${arg.replace(/[/\\]+$/, "")}/`;
      if (fn === "untrailingslashit") return arg.replace(/[/\\]+$/, "");
      if (fn === "realpath") return arg;
      return null;
    }
    default:
      return null;
  }
}

/** Names a condition checks for with class_exists() and friends, and constants it checks with defined(). */
function checkedNames(test, scope) {
  const names = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.kind === "call" && node.what?.kind === "name") {
      const fn = String(node.what.name).replace(/^\\/, "").toLowerCase();
      const arg = node.arguments[0];
      if ((EXISTS.has(fn) || fn === "defined") && arg?.kind === "string") {
        names.push({ kind: fn === "function_exists" ? "function" : fn === "defined" ? "constant" : "class", name: arg.value.replace(/^\\/, "") });
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== "loc" && value && typeof value === "object") visit(value);
  };
  visit(test);
  return names;
}

/** True when a branch only leaves: `return;`, `exit;`, `die;` (the early-return guard at the top of a file). */
const onlyLeaves = (body) => {
  const list = statementsOf(body);
  return list.length > 0 && list.every((s) => s.kind === "return" || (s.kind === "expressionstatement" && s.expression?.kind === "exit"));
};
const negated = (test) => test?.kind === "unary" && test.type === "!";

/**
 * Walks everything plugin `plugin` runs while plugins load, starting from its main file, and returns the uses of
 * other plugins' classes and functions found on the way: { symbol, kind, how, provider, file, line, via, guarded }.
 */
export function probePlugin(project, plugin, { providers = KNOWN_PROVIDERS } = {}) {
  const uses = [];
  const seenFiles = new Set();
  const seenBodies = new Set();
  const consts = new Map();
  const rel = (file) => (plugin.root ? path.relative(plugin.root, file).split(path.sep).join("/") : path.basename(file));
  const lineOf = (node) => node?.loc?.start?.line ?? 0;

  const guardOf = (env, provider, symbol) =>
    env.guards.some((g) => g.symbol === symbol.toLowerCase() || (provider && g.provider === provider.slug));

  function record(env, kind, symbol, how, node) {
    if (!symbol) return;
    const provider = providerOf(project, kind, symbol, providers);
    if (!provider || provider.slug === plugin.slug) return;
    uses.push({
      symbol,
      kind,
      how,
      provider,
      file: rel(env.file),
      line: lineOf(node),
      via: env.via,
      guarded: guardOf(env, provider, symbol),
    });
  }

  function guardsFrom(test, env) {
    return checkedNames(test, env.scope).map(({ kind, name }) => {
      const qualified = kind === "class" ? name : name;
      const provider =
        kind === "constant"
          ? Object.entries(providers).find(([, p]) => (p.prefixes ?? []).some((pre) => name.toLowerCase().startsWith(pre.toLowerCase())))?.[0]
          : providerOf(project, kind, qualified, providers)?.slug;
      return { symbol: qualified.toLowerCase(), provider: provider ?? null };
    });
  }

  /** Runs the body of one of this plugin's own functions or methods, as a call at load time would. */
  function follow(decl, label, env, extra = {}) {
    if (!decl || env.depth >= MAX_DEPTH) return;
    const key = `${decl.file}#${label}`;
    if (seenBodies.has(key)) return;
    seenBodies.add(key);
    const scope = NameScope.at(decl.namespace, decl.uses);
    const next = { ...env, file: decl.file, scope, depth: env.depth + 1, via: [...env.via, `${rel(env.file)}:${env.line ?? 0} ${label}`], ...extra };
    walkStatements(statementsOf(decl.body ?? decl.node?.body), next);
  }

  function ownClass(fqn) {
    const decl = project.declarations.classes.get(fqn?.toLowerCase() ?? "");
    return decl && decl.plugin.slug === plugin.slug ? decl : null;
  }

  function method(decl, name) {
    let current = decl;
    for (let hops = 0; current && hops < 8; hops++) {
      const found = current.methods.get(name.toLowerCase());
      if (found) return { file: current.file, namespace: current.namespace, uses: current.uses, body: found.body, className: current.fqn };
      const parentName = current.node.extends ? resolveIn(current, current.node.extends) : null;
      current = parentName ? ownClass(parentName) : null;
    }
    return null;
  }

  const resolveIn = (decl, nameNode) => NameScope.at(decl.namespace, decl.uses).resolveClass(nameNode);

  /** The class a reference names: a name, or self, static or parent inside one of this plugin's classes. */
  function classRef(ref, env) {
    if (!ref) return null;
    if (ref.kind === "selfreference" || ref.kind === "staticreference") return env.className ?? null;
    if (ref.kind === "parentreference") {
      const own = ownClass(env.className);
      return own?.node.extends ? resolveIn(own, own.node.extends) : null;
    }
    if (ref.kind !== "name") return null;
    const raw = String(ref.name).toLowerCase();
    if (raw === "self" || raw === "static") return env.className ?? null;
    return env.scope.resolveClass(ref);
  }

  function includeFile(target, env, node) {
    const resolved = evalPath(target, env);
    if (!resolved) return;
    const file = path.resolve(path.isAbsolute(resolved) ? resolved : path.join(path.dirname(env.file), resolved));
    if (!project.files.has(file)) return;
    const owner = ownerOfFile(project, file);
    if (owner && owner.slug !== plugin.slug) return;
    walkFile(file, { ...env, line: lineOf(node) });
  }

  function walkExpr(node, env) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => walkExpr(n, env));
    if (FUNCTION_LIKE.has(node.kind)) return;
    const here = { ...env, line: lineOf(node) };
    switch (node.kind) {
      case "include":
        includeFile(node.target, env, node);
        return;
      case "new":
        if (node.what?.kind !== "class" && classRef(node.what, env)) {
          const cls = classRef(node.what, env);
          const own = ownClass(cls);
          if (own) {
            const ctor = method(own, "__construct");
            if (ctor) follow(ctor, `new ${own.fqn}()`, here, { className: own.fqn });
          } else record(env, "class", cls, "new", node);
        } else if (node.what?.kind === "class") {
          checkClassDeclaration(node.what, env);
        }
        walkExpr(node.arguments, env);
        return;
      case "call": {
        const what = node.what;
        if (what?.kind === "name") {
          const fn = String(what.name).replace(/^\\/, "").toLowerCase();
          if (fn === "define" && node.arguments[0]?.kind === "string") {
            const value = evalPath(node.arguments[1], env);
            if (value !== null) env.consts.set(node.arguments[0].value, value);
          }
          const candidates = env.scope.resolveFunction(what);
          const own = candidates.map((c) => project.declarations.functions.get(c.toLowerCase())).find((d) => d && d.plugin.slug === plugin.slug);
          if (own) follow({ file: own.file, namespace: own.namespace, uses: own.uses, body: own.node.body }, `${own.fqn}()`, here);
          else for (const candidate of candidates.slice(-1)) record(env, "function", candidate, "call", node);
        } else if (what?.kind === "staticlookup" && classRef(what.what, env)) {
          const cls = classRef(what.what, env);
          const own = ownClass(cls);
          const name = what.offset?.name;
          if (own && typeof name === "string") {
            const body = method(own, name);
            if (body) follow(body, `${own.fqn}::${name}()`, here, { className: own.fqn });
          } else if (!own) record(env, "class", cls, "static", node);
        } else if (what?.kind === "propertylookup" && what.what?.kind === "variable" && what.what.name === "this" && env.className) {
          const own = ownClass(env.className);
          const name = what.offset?.name;
          if (own && typeof name === "string") {
            const body = method(own, name);
            if (body) follow(body, `${own.fqn}->${name}()`, here, { className: own.fqn });
          }
        } else {
          walkExpr(what, env);
        }
        walkExpr(node.arguments, env);
        return;
      }
      case "staticlookup":
        // X::class is only the name; it does not need the class to exist.
        if (node.offset?.name !== "class" && classRef(node.what, env)) {
          const cls = classRef(node.what, env);
          if (!ownClass(cls)) record(env, "class", cls, "static", node);
        }
        return;
      default:
        for (const [key, value] of Object.entries(node)) {
          if (key !== "loc" && value && typeof value === "object") walkExpr(value, env);
        }
    }
  }

  function checkClassDeclaration(node, env) {
    if (node.extends) record(env, "class", env.scope.resolveClass(node.extends), "extends", node);
    for (const iface of node.implements ?? []) record(env, "class", env.scope.resolveClass(iface), "implements", node);
    if (node.kind === "interface") for (const parent of node.extends ?? []) record(env, "class", env.scope.resolveClass(parent), "extends", node);
  }

  function walkStatements(list, env) {
    let guards = env.guards;
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const here = { ...env, guards };
      switch (node.kind) {
        case "namespace":
          env.scope.enterNamespace(node.name);
          walkStatements(node.children ?? [], here);
          break;
        case "usegroup":
          env.scope.addUse(node);
          break;
        case "class":
        case "interface":
        case "trait":
        case "enum":
          checkClassDeclaration(node, here);
          break;
        case "function":
          break;
        case "constantstatement":
          for (const c of node.constants ?? []) {
            const value = evalPath(c.value, here);
            if (value !== null && c.name?.name) env.consts.set(c.name.name, value);
          }
          break;
        case "if": {
          walkExpr(node.test, here);
          const found = guardsFrom(node.test, here);
          if (negated(node.test) && onlyLeaves(node.body)) {
            // `if ( ! class_exists( 'X' ) ) return;`: everything after runs only when X is there.
            guards = [...guards, ...found];
            break;
          }
          walkStatements(statementsOf(node.body), { ...here, guards: negated(node.test) ? guards : [...guards, ...found] });
          if (node.alternate) walkStatements(statementsOf(node.alternate), { ...here, guards: negated(node.test) ? [...guards, ...found] : guards });
          break;
        }
        case "return":
          walkExpr(node.expr, here);
          return;
        case "block":
          walkStatements(node.children ?? [], here);
          break;
        case "for":
        case "foreach":
        case "while":
        case "do":
          walkExpr(node.kind === "foreach" ? node.source : node.test ?? node.init, here);
          walkStatements(statementsOf(node.body), here);
          break;
        case "switch":
          walkExpr(node.test, here);
          for (const c of statementsOf(node.body)) walkStatements(statementsOf(c.body), here);
          break;
        case "try":
          walkStatements(statementsOf(node.body), here);
          break;
        default:
          walkExpr(node, here);
      }
    }
  }

  function walkFile(file, env) {
    if (seenFiles.has(file) || env.depth > MAX_DEPTH) return;
    seenFiles.add(file);
    const ast = fileAst(project, file);
    if (!ast) return;
    const scope = new NameScope();
    const via = file === path.resolve(plugin.main) ? env.via : [...env.via, `${rel(env.file)}:${env.line ?? 0} includes ${rel(file)}`];
    walkStatements(ast.children ?? [], { ...env, file, scope, via, depth: env.depth + 1, className: null });
  }

  walkFile(path.resolve(plugin.main), { file: path.resolve(plugin.main), consts, guards: [], via: [], depth: 0, line: 0 });
  return uses;
}
