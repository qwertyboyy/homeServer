<?php
declare(strict_types=1);
// Password travels only over server-side loopback HTTP, never in redirects/HTML.
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
function stop_signon(int $status, string $message): never {
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    exit($message);
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET') stop_signon(405, 'Method not allowed');
$app = $_GET['app'] ?? '';
if (!is_string($app) || !preg_match('/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/D', $app)) {
    header('Location: /hosting', true, 303);
    exit;
}
$session = $_COOKIE['nif_session'] ?? '';
if (!is_string($session) || !preg_match('/^[A-Za-z0-9_-]{43}$/D', $session)) stop_signon(401, 'Login dashboard terlebih dahulu.');
$key = trim((string) @file_get_contents('/etc/phpmyadmin/nifhost-bridge.key'));
if (!preg_match('/^[a-f0-9]{64}$/D', $key)) stop_signon(503, 'Bridge phpMyAdmin belum dikonfigurasi.');
$curl = curl_init('http://127.0.0.1:3001/api/v1/hosting/apps/' . rawurlencode($app) . '/database/phpmyadmin-credentials');
curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => '{}',
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Nif-Pma-Key: ' . $key, 'Cookie: nif_session=' . $session],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 2,
    CURLOPT_TIMEOUT => 5,
    CURLOPT_FOLLOWLOCATION => false,
]);
$body = curl_exec($curl);
$status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);
if ($status !== 200 || !is_string($body)) stop_signon(403, 'Akses database ditolak. Buka kembali dari tab Database dashboard.');
$data = json_decode($body, true)['data'] ?? null;
if (!is_array($data) || !preg_match('/^nifdb[a-f0-9]{24}$/D', $data['user'] ?? '') || ($data['host'] ?? '') !== '127.0.0.1' || ($data['port'] ?? 0) !== 3306) {
    stop_signon(502, 'Konfigurasi database tidak valid.');
}
$secure = ($_SERVER['HTTPS'] ?? '') === 'on';
ini_set('session.use_strict_mode', '1');
session_save_path('/var/lib/phpmyadmin/nifhost-sessions');
session_name('NifPmaSignon');
session_set_cookie_params(['lifetime' => 0, 'path' => '/phpmyadmin/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Strict']);
if (!session_start()) stop_signon(503, 'Sesi phpMyAdmin tidak tersedia.');
session_regenerate_id(true);
$_SESSION = [
    'PMA_single_signon_user' => $data['user'],
    'PMA_single_signon_password' => $data['password'],
    'PMA_single_signon_host' => '127.0.0.1',
    'PMA_single_signon_port' => '3306',
    'PMA_single_signon_HMAC_secret' => bin2hex(random_bytes(32)),
];
session_write_close();
// Start a fresh phpMyAdmin login when changing applications.
setcookie('phpMyAdmin', '', ['expires' => time() - 3600, 'path' => '/phpmyadmin/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Strict']);
header('Location: /phpmyadmin/index.php?server=1&db=' . rawurlencode($data['database']), true, 303);
