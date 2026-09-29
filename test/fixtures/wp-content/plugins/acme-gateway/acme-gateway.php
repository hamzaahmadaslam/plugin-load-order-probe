<?php
/**
 * Plugin Name: Acme Gateway
 * Description: Synthetic test plugin. Declares a gateway at the top of the file, before WooCommerce has loaded.
 */

class Acme_Gateway extends WC_Payment_Gateway {}

class Acme_Helper {}
