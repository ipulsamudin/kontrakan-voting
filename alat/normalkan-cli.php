<?php
/**
 * Membuka normalkan() milik lokal/api.php ke command line, supaya
 * test-api.mjs bisa membandingkannya dengan normalizer mandirinya sendiri.
 *
 *   echo '["  Ipul  ","ipul\tsamudin"]' | php alat/normalkan-cli.php
 *   -> [{"tampil":"Ipul","kunci":"ipul"},{"tampil":"ipul samudin","kunci":"ipul samudin"}]
 *
 * Input dan output lewat JSON di stdin/stdout, bukan argv, supaya karakter
 * kontrol dan zero-width lolos utuh tanpa diurus shell.
 */

declare(strict_types=1);

define('VOTING_SEBAGAI_LIBRARY', true);
require __DIR__ . '/../lokal/api.php';

$mentah = stream_get_contents(STDIN);
$daftar = json_decode($mentah, true);

if (!is_array($daftar)) {
    fwrite(STDERR, "Input harus berupa array JSON berisi string.\n");
    exit(1);
}

$keluar = array_map(static fn($s) => normalkan($s), $daftar);

echo json_encode($keluar, JSON_UNESCAPED_UNICODE);
