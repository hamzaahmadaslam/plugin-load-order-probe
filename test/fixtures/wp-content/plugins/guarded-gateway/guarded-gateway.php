<?php
/**
 * Plugin Name: Guarded Gateway
 * Description: Synthetic test plugin. Checks that WooCommerce's class exists before declaring its gateway. It
 * sorts before "woocommerce", so the check always fails at load time and the gateway is never declared.
 */

if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
	return;
}

class Guarded_Gateway extends WC_Payment_Gateway {}
