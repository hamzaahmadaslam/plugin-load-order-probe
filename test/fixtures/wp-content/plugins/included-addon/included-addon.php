<?php
/**
 * Plugin Name: Included Addon
 * Description: Synthetic test plugin. The load-time use is in a file it includes.
 */

define( 'INCLUDED_ADDON_DIR', plugin_dir_path( __FILE__ ) );

require_once INCLUDED_ADDON_DIR . 'includes/boot.php';
