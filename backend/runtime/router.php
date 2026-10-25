<?php
// NIFSERVER router for PHP's built-in server (`php -S ... router.php`), used by
// the laravel and php runtimes. Refuses sensitive paths, lets the server handle
// existing files inside the document root, and falls back to index.php.

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$path = is_string($path) ? rawurldecode($path) : '/';

function nif_deny(): bool
{
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not found";
    return true;
}

if (str_contains($path, "\0") || str_contains($path, '\\')) {
    return nif_deny();
}
foreach (explode('/', $path) as $i => $seg) {
    if ($seg === '') continue;
    if ($seg === '..' || ($seg[0] === '.' && !($i === 1 && $seg === '.well-known'))) return nif_deny();
    if (in_array(strtolower($seg), ['vendor', 'node_modules'], true)) return nif_deny();
}
$base = basename($path);
if (preg_match('/^(composer\.(json|lock)|package(-lock)?\.json|artisan|phpunit\.xml)$/i', $base)
    || preg_match('/\.(env|ini|log|sql|sqlite3?|db|bak|old|swp|pem|key|lock|md|yml|yaml|sh)$/i', $base)) {
    return nif_deny();
}

$docroot = realpath($_SERVER['DOCUMENT_ROOT']);
$file = realpath($_SERVER['DOCUMENT_ROOT'] . $path);
if ($docroot !== false && $file !== false && is_file($file) && str_starts_with($file, $docroot . DIRECTORY_SEPARATOR)) {
    return false; // let the built-in server serve / execute it
}

$index = $docroot . DIRECTORY_SEPARATOR . 'index.php';
if ($docroot !== false && is_file($index)) {
    $_SERVER['SCRIPT_FILENAME'] = $index;
    $_SERVER['SCRIPT_NAME'] = '/index.php';
    $_SERVER['PHP_SELF'] = '/index.php';
    chdir($docroot);
    require $index;
    return true;
}
return nif_deny();
