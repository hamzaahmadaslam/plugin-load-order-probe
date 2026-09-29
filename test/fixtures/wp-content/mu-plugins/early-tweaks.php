<?php
/**
 * Synthetic test must-use plugin: must-use plugins load before every regular plugin.
 */

$early_helper = new Acme_Helper();

$early_name = Acme_Helper::class;
