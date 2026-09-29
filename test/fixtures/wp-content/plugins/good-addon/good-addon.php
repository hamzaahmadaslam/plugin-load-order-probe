<?php
/**
 * Plugin Name: Good Addon
 * Description: Synthetic test plugin. Waits for plugins_loaded, so load order does not matter.
 */

add_action(
	'plugins_loaded',
	function () {
		new Acme_Helper();
		class_exists( 'WC_Payment_Gateway' ) && WC();
	}
);
