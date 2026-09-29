import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WP_CONTENT = path.join(here, "fixtures", "wp-content");

const byPlugin = (report) => Object.fromEntries(report.results.map((r) => [r.plugin, r]));

test("the fixture site: each plugin gets the verdict its code earns", () => {
  const report = run(WP_CONTENT);
  const found = byPlugin(report);
  assert.equal(report.checked.length, 8);
  assert.equal(found["acme-gateway/acme-gateway.php"].verdict, "fails");
  assert.equal(found["acme-gateway/acme-gateway.php"].how, "extends");
  assert.equal(found["included-addon/included-addon.php"].verdict, "fails");
  assert.equal(found["included-addon/included-addon.php"].symbol, "WC");
  assert.equal(found["namespaced-addon/namespaced-addon.php"].verdict, "fails");
  assert.equal(found["namespaced-addon/namespaced-addon.php"].symbol, "WC_Order");
  assert.equal(found["early-tweaks.php"].verdict, "fails");
  assert.equal(found["early-tweaks.php"].mu, true);
  assert.equal(found["guarded-gateway/guarded-gateway.php"].verdict, "skipped");
  assert.equal(found["zeta-addon/zeta-addon.php"].verdict, "fragile");
  assert.equal(found["good-addon/good-addon.php"], undefined, "a plugins_loaded callback is not load time");
  assert.equal(found["woocommerce/woocommerce.php"], undefined);
  assert.equal(report.results.length, 6);
});

test("results come in order of severity", () => {
  const verdicts = run(WP_CONTENT).results.map((r) => r.verdict);
  assert.deepEqual(verdicts, ["fails", "fails", "fails", "fails", "skipped", "fragile"]);
});

test("a use reached through includes and methods carries the path to it", () => {
  const found = byPlugin(run(WP_CONTENT));
  assert.deepEqual(found["included-addon/included-addon.php"].via, ["included-addon.php:9 includes includes/boot.php"]);
  const via = found["namespaced-addon/namespaced-addon.php"].via;
  assert.equal(via.length, 4);
  assert.match(via[0], /Plugin::instance\(\)$/);
  assert.match(via[1], /new Namespaced\\Addon\\Plugin\(\)$/);
  assert.match(via[2], /Plugin->includes\(\)$/);
  assert.match(via[3], /includes src\/class-order-view\.php$/);
  // later() is hooked to init, so the OrderUtil call inside it is not reported.
  assert.ok(!run(WP_CONTENT).results.some((r) => r.symbol.includes("OrderUtil")));
});

test("the provider's name comes from the known list when its source is present", () => {
  const found = byPlugin(run(WP_CONTENT));
  assert.equal(found["acme-gateway/acme-gateway.php"].provider, "WooCommerce");
  assert.equal(found["zeta-addon/zeta-addon.php"].provider, "acme-gateway");
});

test("one plugin on its own: WooCommerce is recognised without its source", () => {
  const report = run(path.join(WP_CONTENT, "plugins", "namespaced-addon"));
  assert.deepEqual(report.checked, ["namespaced-addon/namespaced-addon.php"]);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].providerFile, "woocommerce/woocommerce.php");
  assert.equal(report.results[0].verdict, "fails");
});

test("--only reports some plugins but still reads the rest as providers", () => {
  const report = run(WP_CONTENT, { only: ["zeta-addon"] });
  assert.deepEqual(report.checked, ["zeta-addon/zeta-addon.php"]);
  assert.equal(report.results[0].provider, "acme-gateway");
});

/** A throwaway plugins folder: { "slug/main.php": code }. */
function site(files) {
  const root = mkdtempSync(path.join(tmpdir(), "plop-"));
  mkdirSync(path.join(root, "plugins"));
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, "plugins", file)), { recursive: true });
    writeFileSync(path.join(root, "plugins", file), code);
  }
  return root;
}
const header = (name) => `<?php\n/**\n * Plugin Name: ${name}\n */\n`;

test("guards: a check the provider passes is guarded, and wrapping the use in the check counts", (t) => {
  const root = site({
    "aaa-base/aaa-base.php": `${header("Base")}class Base_Thing {}\nfunction base_thing() {}\n`,
    "mmm-wrapped/mmm-wrapped.php": `${header("Wrapped")}if ( class_exists( 'Base_Thing' ) ) {\n\tnew Base_Thing();\n}\nif ( function_exists( 'base_thing' ) ) { base_thing(); }\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = run(root);
  assert.deepEqual(
    report.results.map((r) => [r.symbol, r.verdict]),
    [
      ["Base_Thing", "guarded"],
      ["base_thing", "guarded"],
    ],
  );
});

test("a check in the else branch of a negated test guards the else branch only", (t) => {
  const root = site({
    "aaa-base/aaa-base.php": `${header("Base")}class Base_Thing {}\n`,
    "mmm-user/mmm-user.php": `${header("User")}if ( ! class_exists( 'Base_Thing' ) ) {\n\t$x = new Base_Thing();\n} else {\n\t$y = new Base_Thing();\n}\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(
    run(root).results.map((r) => r.verdict),
    ["fragile", "guarded"],
  );
});

test("names only, closures and functions that are never called are not load time", (t) => {
  const root = site({
    "aaa-base/aaa-base.php": `${header("Base")}class Base_Thing {}\nfunction base_thing() {}\n`,
    "mmm-user/mmm-user.php": `${header("User")}$name = Base_Thing::class;\n$later = function () { return new Base_Thing(); };\n$arrow = fn () => base_thing();\nfunction mmm_setup() { base_thing(); }\nclass Mmm_Plugin { public function run() { new Base_Thing(); } }\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(run(root).results, []);
});

test("a function of the plugin's own that runs at load time is followed", (t) => {
  const root = site({
    "zzz-base/zzz-base.php": `${header("Base")}function base_thing() {}\n`,
    "aaa-user/aaa-user.php": `${header("User")}function aaa_setup() { base_thing(); }\naaa_setup();\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [result] = run(root).results;
  assert.equal(result.verdict, "fails");
  assert.equal(result.symbol, "base_thing");
  assert.deepEqual(result.via, ["aaa-user.php:6 aaa_setup()"]);
});

test("parent:: in a constructor that runs at load time is followed to the parent class", (t) => {
  const root = site({
    "zzz-base/zzz-base.php": `${header("Base")}function base_thing() {}
`,
    "aaa-user/aaa-user.php": `${header("User")}class Aaa_Base { public function __construct() { base_thing(); } }\nclass Aaa_Thing extends Aaa_Base {\n\tpublic function __construct() { parent::__construct(); }\n}\nnew Aaa_Thing();\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [result] = run(root).results;
  assert.equal(result.symbol, "base_thing");
  assert.equal(result.verdict, "fails");
  assert.match(result.via.at(-1), /Aaa_Base::__construct\(\)$/);
});

test("an early return guard covers the rest of the file", (t) => {
  const root = site({
    "zzz-base/zzz-base.php": `${header("Base")}function base_thing() {}\n`,
    "aaa-user/aaa-user.php": `${header("User")}if ( ! function_exists( 'base_thing' ) ) {\n\treturn;\n}\nbase_thing();\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(
    run(root).results.map((r) => r.verdict),
    ["skipped"],
  );
});

test("a plugin's own classes and functions are never findings", (t) => {
  const root = site({
    "aaa-self/aaa-self.php": `${header("Self")}require __DIR__ . '/inc/b.php';\nnew Aaa_Thing();\naaa_thing();\n`,
    "aaa-self/inc/b.php": `<?php\nclass Aaa_Thing {}\nfunction aaa_thing() {}\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(run(root).results, []);
});

test("a must-use plugin using another must-use plugin sorts like regular plugins", (t) => {
  const root = site({});
  mkdirSync(path.join(root, "mu-plugins"));
  writeFileSync(path.join(root, "mu-plugins", "a-first.php"), "<?php\nnew Zed_Thing();\n");
  writeFileSync(path.join(root, "mu-plugins", "z-last.php"), "<?php\nclass Zed_Thing {}\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(
    run(root).results.map((r) => [r.plugin, r.verdict]),
    [["a-first.php", "fails"]],
  );
});

test("a regular plugin using a must-use plugin is fine", (t) => {
  const root = site({ "aaa-user/aaa-user.php": `${header("User")}new Mu_Thing();\n` });
  mkdirSync(path.join(root, "mu-plugins"));
  writeFileSync(path.join(root, "mu-plugins", "base.php"), "<?php\nclass Mu_Thing {}\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(run(root).results, []);
});

test("a file that does not parse is skipped, not fatal", (t) => {
  const root = site({
    "aaa-broken/aaa-broken.php": `${header("Broken")}new Thing(\n`,
    "bbb-fine/bbb-fine.php": `${header("Fine")}WC();\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(
    run(root).results.map((r) => [r.plugin, r.verdict]),
    [["bbb-fine/bbb-fine.php", "fails"]],
  );
});
