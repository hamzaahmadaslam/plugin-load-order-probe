// Whether a load-time use of another plugin's code fails, works by luck, or is guarded.

/**
 * WordPress loads must-use plugins first (wp-settings.php), then network-activated plugins on a multisite, then the
 * site's active plugins in the order of the active_plugins option, which activate_plugin() keeps sorted. So a plugin
 * whose stored path ("folder/main.php") sorts before its provider's runs first.
 */
export function verdictOf(plugin, use) {
  const provider = use.provider;
  const loadsFirst = (plugin.mu && !provider.mu) || (plugin.mu === provider.mu && plugin.file < provider.file);
  if (!plugin.mu && provider.mu) return "ok";
  // A check that the class exists avoids the fatal error, but when this plugin loads first the check always fails
  // at that moment, so the guarded code never runs at all.
  if (use.guarded) return loadsFirst ? "skipped" : "guarded";
  return loadsFirst ? "fails" : "fragile";
}

const WHAT = {
  extends: "extends",
  implements: "implements",
  new: "creates",
  static: "calls",
  call: "calls",
};

/** One sentence on why, and one on the fix, from fixed text: the tool writes nothing it did not find. */
export function explain(plugin, use, verdict) {
  const symbol = use.kind === "function" ? `${use.symbol}()` : use.symbol;
  const action = `${WHAT[use.how] ?? "uses"} ${symbol} from ${use.provider.name}`;
  const fix =
    "Run it from a callback on plugins_loaded (or the provider's own loaded action, such as woocommerce_loaded), or check class_exists() or function_exists() first.";
  if (verdict === "fails" && plugin.mu) {
    return {
      why: `${plugin.file} is a must-use plugin and ${action} while plugins load. Must-use plugins load before every regular plugin, so ${symbol} is not defined yet and the site stops with a fatal error.`,
      fix,
    };
  }
  if (verdict === "fails") {
    return {
      why: `This ${action} while plugins load. WordPress loads active plugins in the sorted order of their paths, and "${plugin.file}" comes before "${use.provider.file}", so ${symbol} is not defined yet and the site stops with a fatal error.`,
      fix,
    };
  }
  if (verdict === "fragile") {
    return {
      why: `This ${action} while plugins load. It works only because "${use.provider.file}" sorts before "${plugin.file}". It breaks if the provider's folder is renamed, if this plugin is network-activated while the provider is not (network plugins load first), or if the code moves into a must-use plugin.`,
      fix,
    };
  }
  if (verdict === "skipped") {
    return {
      why: `This ${action} while plugins load, behind a check that it exists. "${plugin.file}" loads before "${use.provider.file}", so the check always fails at that moment and the code behind it never runs: no error, and no feature.`,
      fix: "Move the check and the code into a callback on plugins_loaded (or the provider's own loaded action), where the provider is always there if it is active.",
    };
  }
  return { why: `This ${action} while plugins load, behind a check that it exists, and the provider loads first.`, fix: "" };
}
