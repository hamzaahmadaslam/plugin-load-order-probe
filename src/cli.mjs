// Command line: plugin-load-order-probe <wp-content | plugins folder | one plugin>.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pluginName } from "./php.mjs";
import { probePlugin } from "./probe.mjs";
import { KNOWN_PROVIDERS, loadProject } from "./project.mjs";
import { explain, verdictOf } from "./verdict.mjs";

export const USAGE = `plugin-load-order-probe: find plugin code that uses another plugin's classes or functions while plugins load.

  plugin-load-order-probe <wp-content>          checks plugins/ and mu-plugins/
  plugin-load-order-probe <plugins-folder>      every plugin in the folder
  plugin-load-order-probe <one-plugin-folder>   one plugin; WooCommerce is recognised by name without its source

Options
  --mu <folder>        a mu-plugins folder, when the first argument is a plugins folder
  --only <a,b>         report only these plugin folders (the others are still read, as providers)
  --strict             exit 1 on uses that only work because of alphabetical order, as well as on failures
  --show-guarded       list uses behind class_exists() or function_exists() too
  --json               print the results as JSON
  --help
`;

const hasMain = (dir) =>
  readdirSync(dir).some((name) => /\.php$/i.test(name) && statSync(path.join(dir, name)).isFile() && pluginName(readFileSync(path.join(dir, name), "utf8")));

/** Works out what the argument is: a wp-content folder, a plugins folder, or a single plugin. */
export function locate(target, mu) {
  const full = path.resolve(target);
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`Not a folder: ${target}`);
  if (existsSync(path.join(full, "plugins")) && statSync(path.join(full, "plugins")).isDirectory()) {
    return { pluginsDir: path.join(full, "plugins"), muDir: mu ?? path.join(full, "mu-plugins"), only: null };
  }
  if (hasMain(full)) {
    return { pluginsDir: path.dirname(full), muDir: mu ?? null, only: [path.basename(full)], single: true };
  }
  return { pluginsDir: full, muDir: mu ?? null, only: null };
}

export function run(target, options = {}) {
  const where = locate(target, options.mu);
  const project = loadProject({
    pluginsDir: where.pluginsDir,
    muDir: where.muDir,
    only: options.only ?? where.only,
    ...(where.single ? { singleSlug: where.only[0] } : {}),
  });
  const results = [];
  for (const plugin of project.plugins) {
    for (const use of probePlugin(project, plugin, { providers: KNOWN_PROVIDERS })) {
      const verdict = verdictOf(plugin, use);
      if (verdict === "ok") continue;
      results.push({
        plugin: plugin.file,
        mu: plugin.mu,
        verdict,
        symbol: use.symbol,
        kind: use.kind,
        how: use.how,
        provider: use.provider.name,
        providerFile: use.provider.file,
        at: `${use.file}:${use.line}`,
        via: use.via,
        ...explain(plugin, use, verdict),
      });
    }
  }
  const order = { fails: 0, skipped: 1, fragile: 2, guarded: 3 };
  results.sort((a, b) => order[a.verdict] - order[b.verdict] || a.plugin.localeCompare(b.plugin) || a.at.localeCompare(b.at));
  return { checked: project.plugins.map((p) => p.file), results };
}

function text({ checked, results }, showGuarded) {
  const shown = results.filter((r) => showGuarded || r.verdict !== "guarded");
  const count = (v) => results.filter((r) => r.verdict === v).length;
  const out = [
    `plugin-load-order-probe: ${checked.length} plugin${checked.length === 1 ? "" : "s"} checked.`,
    `${count("fails")} fail${count("fails") === 1 ? "s" : ""} now, ${count("skipped")} never run${count("skipped") === 1 ? "s" : ""}, ${count("fragile")} work${count("fragile") === 1 ? "s" : ""} only because of load order, ${count("guarded")} guarded.`,
  ];
  const label = { fails: "Fails now", skipped: "Never runs", fragile: "Works by load order", guarded: "Guarded" };
  for (const verdict of ["fails", "skipped", "fragile", "guarded"]) {
    const group = shown.filter((r) => r.verdict === verdict);
    if (!group.length) continue;
    out.push("", `${label[verdict]} (${group.length})`);
    for (const r of group) {
      out.push(`  ${r.plugin}  ${r.at}  ${r.how} ${r.kind === "function" ? `${r.symbol}()` : r.symbol}`);
      out.push(`    ${r.why}`);
      if (r.via.length) out.push(`    reached through: ${r.via.join(" > ")}`);
      if (r.fix) out.push(`    Fix: ${r.fix}`);
    }
  }
  return out.join("\n") + "\n";
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        mu: { type: "string" },
        only: { type: "string" },
        strict: { type: "boolean" },
        "show-guarded": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    stderr.write(USAGE);
    return 2;
  }
  let report;
  try {
    report = run(positionals[0], {
      mu: values.mu,
      only: values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
  stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : text(report, values["show-guarded"]));
  const failing = report.results.some((r) => ["fails", "skipped"].includes(r.verdict) || (values.strict && r.verdict === "fragile"));
  return failing ? 1 : 0;
}
