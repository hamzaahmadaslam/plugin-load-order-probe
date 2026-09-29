import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WP_CONTENT = path.join(here, "fixtures", "wp-content");

async function cli(...argv) {
  let out = "";
  let err = "";
  const code = await main(argv, { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } });
  return { code, out, err };
}

test("exit 1 when something fails, with a summary line and the path to each use", async () => {
  const { code, out } = await cli(WP_CONTENT);
  assert.equal(code, 1);
  assert.match(out, /8 plugins checked\./);
  assert.match(out, /4 fail now, 1 never runs, 1 works only because of load order, 0 guarded\./);
  assert.match(out, /reached through: included-addon\.php:9 includes includes\/boot\.php/);
  assert.match(out, /call WC\(\)/);
});

test("exit 0 when only load-order luck is found, and 1 with --strict", async () => {
  const zeta = ["--only", "zeta-addon", WP_CONTENT];
  assert.equal((await cli(...zeta)).code, 0);
  assert.equal((await cli("--strict", ...zeta)).code, 1);
});

test("--json prints the report", async () => {
  const { out } = await cli("--json", WP_CONTENT);
  const report = JSON.parse(out);
  assert.equal(report.results.length, 6);
  assert.ok(report.results.every((r) => r.why && r.at && r.providerFile));
});

test("guarded uses are hidden unless asked for", async () => {
  const { out } = await cli("--show-guarded", "--only", "good-addon", WP_CONTENT);
  assert.match(out, /0 fail now/);
  assert.doesNotMatch(out, /Guarded \(/);
});

test("usage errors exit 2", async () => {
  assert.equal((await cli()).code, 2);
  assert.equal((await cli("--nope", WP_CONTENT)).code, 2);
  const missing = await cli(path.join(here, "does-not-exist"));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /Not a folder/);
  assert.equal((await cli("--help")).code, 0);
});
