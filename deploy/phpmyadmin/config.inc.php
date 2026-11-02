<?php
// Loaded by Ubuntu's /etc/phpmyadmin/conf.d; only this FPM vhost opts in.
if (($_SERVER['NIFHOST_PMA'] ?? '') !== '1') return;
$cfg['Servers'] = [1 => [
    'host' => '127.0.0.1',
    'port' => '3306',
    'auth_type' => 'signon',
    'SignonSession' => 'NifPmaSignon',
    'SignonURL' => '/hosting',
    'LogoutURL' => '/hosting',
    'AllowRoot' => false,
    'AllowNoPassword' => false,
    'AllowDeny' => ['order' => 'explicit', 'rules' => ['allow % from all', 'deny root from all', 'deny nifhost_admin from all']],
]];
$cfg['AllowArbitraryServer'] = false;
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
$cfg['LoginCookieValidity'] = 1800;
$cfg['SendErrorReports'] = 'never';
$cfg['TempDir'] = '/var/lib/phpmyadmin/tmp';
$cfg['SessionSavePath'] = '/var/lib/phpmyadmin/nifhost-sessions';
