# plugin-load-order-probe

Finds WordPress plugin code that uses another plugin's classes or functions while plugins are still loading, and
says whether it fails now, never runs, or works only because of alphabetical order.

WordPress loads plugins one file at a time. When an add-on declares `class My_Gateway extends WC_Payment_Gateway` at
the top of its main file, the class it extends has to exist at that moment, which depends on the order the files
load in. That order is not something either plugin chooses: must-use plugins come first, then network-activated
plugins on a multisite, then the site's active plugins in the order of the `active_plugins` option, which
`activate_plugin()` keeps sorted by path. So `acme-gateway/acme-gateway.php` loads before
`woocommerce/woocommerce.php`, and `zeta-addon/zeta-addon.php` loads after it.

The result is a family of bugs that pass every test on one site and break on another: a fatal error after a folder
is renamed, a feature that silently never loads because its `class_exists()` check runs too early, an add-on that
works until someone network-activates it. plugin-load-order-probe reads the PHP (it never runs it), follows what
each plugin executes while plugins load, and compares every use of another plugin's code with where the two sort.

## What it reports

| Verdict               | Exit | Meaning                                                                                              |
| --------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `fails`               | 1    | The provider loads later, so the class or function is not defined yet: a fatal error on every load   |
| `skipped` (never runs) | 1    | The use is behind `class_exists()` or similar, but the check runs before the provider loads, so it always fails and the code behind it never runs |
| `fragile`             | 0    | It works only because the provider sorts first. Exit 1 with `--strict`                               |
| `guarded`             | 0    | Behind a check, and the provider loads first. Hidden unless `--show-guarded`                         |

A must-use plugin that uses a regular plugin's code at load time always fails. A regular plugin using a must-use
plugin's code is fine and not reported.

"While plugins load" means code that runs when the file is included: the top level of the main file, files it
includes (`require_once __DIR__ . '/includes/x.php'`, `plugin_dir_path( __FILE__ )`, constants set with `define()`
or `const`), and the plugin's own functions, constructors and static methods called from there, including a
singleton's `instance()` and `new self()`. Code inside callbacks (`add_action( 'plugins_loaded', ... )`, closures,
methods hooked for later) runs after every plugin has loaded, so it is not followed.

WooCommerce is recognised without its source: a class starting with `WC_` or `Automattic\WooCommerce\`, the class
`WooCommerce`, and the functions `WC()` and `wc_*` are treated as coming from `woocommerce/woocommerce.php`. Every
other provider has to be in the folder being checked.

## Install

```sh
npm install -g github:hamzaahmadaslam/plugin-load-order-probe
```

Node 20 or later. One dependency, [php-parser](https://www.npmjs.com/package/php-parser), pinned.

## Usage

```sh
# A whole site: plugins/ and mu-plugins/
plugin-load-order-probe wp-content/

# Every plugin in a folder
plugin-load-order-probe wp-content/plugins/

# One plugin on its own (only WooCommerce is known as a provider then)
plugin-load-order-probe wp-content/plugins/my-addon/
```

| Option           | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `--mu <folder>`  | A mu-plugins folder, when the first argument is a plugins folder                         |
| `--only <a,b>`   | Report only these plugin folders; the others are still read as providers                 |
| `--strict`       | Exit 1 on `fragile` uses too                                                             |
| `--show-guarded` | List `guarded` uses as well                                                              |
| `--json`         | Print the results as JSON                                                                |

Exit codes: 0 when nothing fails, 1 when a use fails or never runs (or is fragile, with `--strict`), 2 on a usage
error.

In a GitHub workflow for a plugin that depends on WooCommerce:

```yaml
- uses: actions/setup-node@v7
  with:
    node-version: 22
- run: npx --yes github:hamzaahmadaslam/plugin-load-order-probe .
```

## Example

`test/fixtures/wp-content` is a small synthetic site (not code from any real one): a WooCommerce stub, six plugins
and a must-use plugin, each showing one pattern. This is part of what the probe prints for it:

```text
plugin-load-order-probe: 8 plugins checked.
4 fail now, 1 never runs, 1 works only because of load order, 0 guarded.

Fails now (4)
  acme-gateway/acme-gateway.php  acme-gateway.php:7  extends WC_Payment_Gateway
    This extends WC_Payment_Gateway from WooCommerce while plugins load. WordPress loads active plugins in the sorted order of their paths, and "acme-gateway/acme-gateway.php" comes before "woocommerce/woocommerce.php", so WC_Payment_Gateway is not defined yet and the site stops with a fatal error.
    Fix: Run it from a callback on plugins_loaded (or the provider's own loaded action, such as woocommerce_loaded), or check class_exists() or function_exists() first.
  namespaced-addon/namespaced-addon.php  src/class-order-view.php:6  extends WC_Order
    ...
    reached through: namespaced-addon.php:36 Namespaced\Addon\Plugin::instance() > namespaced-addon.php:16 new Namespaced\Addon\Plugin() > namespaced-addon.php:22 Namespaced\Addon\Plugin->includes() > namespaced-addon.php:27 includes src/class-order-view.php

Never runs (1)
  guarded-gateway/guarded-gateway.php  guarded-gateway.php:12  extends WC_Payment_Gateway
    This extends WC_Payment_Gateway from WooCommerce while plugins load, behind a check that it exists. "guarded-gateway/guarded-gateway.php" loads before "woocommerce/woocommerce.php", so the check always fails at that moment and the code behind it never runs: no error, and no feature.
```

The full output is in `examples/report.txt` and the JSON in `examples/report.json`.

## The fix

Move the load-time code into a callback that runs once every plugin is loaded:

```php
add_action( 'plugins_loaded', function () {
	if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
		return; // WooCommerce is not active.
	}
	require_once __DIR__ . '/includes/class-my-gateway.php';
} );
```

WooCommerce also fires `woocommerce_loaded` after its own files are in place, for code that only makes sense with
it.

## What leaves your machine

Nothing. The tool reads files locally, makes no network call and uses no model.

## Limits

- It reads code and does not run it. A class name held in a variable (`new $class()`), a file included through a
  path built at run time, or a call made through `call_user_func()` is not followed.
- It assumes the sorted order WordPress keeps. A plugin that rewrites the `active_plugins` option to load itself
  first changes the real order, and the tool does not know about it.
- Network activation is not read from a database: the tool treats every plugin as site-activated. The `fragile`
  explanation says what changes when one is network-activated.
- A use inside a method is followed only when the method is called at load time from code the tool can see:
  `$this->method()`, `self::`, `static::`, `parent::`, the plugin's own classes by name, and its own functions.
- Providers other than WooCommerce have to be in the folder being checked, so a plugin checked on its own can only
  be compared with WooCommerce.

## License

MIT. Made by [Hamza Ahmad Aslam](https://hamzaahmadaslam.com), WordPress and web performance engineer.
