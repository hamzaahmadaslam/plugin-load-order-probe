<?php
/**
 * Plugin Name: Namespaced Addon
 * Description: Synthetic test plugin. A singleton whose constructor includes a file that extends WooCommerce's order
 * class: the use is three steps away from the top of the file.
 */

namespace Namespaced\Addon;

use Automattic\WooCommerce\Utilities\OrderUtil;

final class Plugin {
	public static function instance() {
		static $instance = null;
		if ( null === $instance ) {
			$instance = new self();
		}
		return $instance;
	}

	private function __construct() {
		$this->includes();
		add_action( 'init', array( $this, 'later' ) );
	}

	private function includes() {
		require_once __DIR__ . '/src/class-order-view.php';
	}

	public function later() {
		// Runs on init, after every plugin has loaded: not a finding.
		return OrderUtil::custom_orders_table_usage_is_enabled();
	}
}

Plugin::instance();
