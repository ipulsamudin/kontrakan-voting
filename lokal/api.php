<?php
/**
 * Adapter lokal: implementasi kontrak API voting di atas PHP + PDO sqlite.
 *
 * Dua cara menjalankannya:
 *
 *   1. Server bawaan PHP (dipakai test-api.mjs):
 *        php -S 127.0.0.1:8787 lokal/api.php
 *      dasar = http://127.0.0.1:8787
 *
 *   2. XAMPP:
 *        http://localhost/kontrakan-voting/lokal/api.php
 *      dasar = http://localhost/kontrakan-voting/lokal/api.php
 *
 * Keduanya melayani rute yang sama (/api/hasil, /api/suara, ...), karena
 * routing-nya membaca PATH_INFO lebih dulu lalu jatuh ke path REQUEST_URI.
 *
 * File ini dan worker/src/index.js adalah DUA implementasi dari SATU kontrak.
 * Keduanya memakai db/migrations/0001_awal.sql apa adanya. Kalau Anda mengubah
 * aturan validasi atau normalisasi di satu sisi, ubah juga di sisi lain --
 * test-api.mjs dijalankan terhadap keduanya justru untuk menangkap kelalaian itu.
 */

declare(strict_types=1);

const BERKAS_MIGRASI = __DIR__ . '/../db/migrations/0001_awal.sql';
const BERKAS_SALT    = __DIR__ . '/../.ip-salt';

/**
 * Lokasi basis data. Bisa dialihkan lewat env VOTING_DB supaya test-api.mjs
 * memakai berkas sekali pakai dan tidak pernah menyentuh suara sungguhan.
 */
function berkasDb(): string
{
    $dari_env = getenv('VOTING_DB');
    if (is_string($dari_env) && '' !== $dari_env) {
        return $dari_env;
    }
    return __DIR__ . '/../voting.sqlite';
}

const BATAS_BADAN   = 4096;   // byte
const BATAS_NAMA    = 60;     // code point
const BATAS_ALASAN  = 500;    // code point
const BATAS_RIWAYAT = 500;    // baris
const BATAS_SUARA   = 500;    // baris

/* Dipakai sebagai fungsi, bukan const: ekspresi const di PHP 8.0 tidak boleh
   memanggil fungsi seperti getenv(). */

/** Voting ditutup lewat env: VOTING_TUTUP=1 php -S ... */
function tutup(): bool
{
    return '1' === (getenv('VOTING_TUTUP') ?: '0');
}

/**
 * Mode ketat: token yang tidak cocok DITOLAK, bukan hanya ditandai.
 * Default mati; lihat README bagian penyalahgunaan untuk alasannya.
 */
function ketat(): bool
{
    return '1' === (getenv('KETAT') ?: '0');
}

/* Origin yang boleh menerima header Access-Control-Allow-Origin.
   `http://localhost` TANPA port wajib ada: itu yang dikirim XAMPP di port 80,
   dan paling mudah terlupa di seluruh berkas ini. */
const ASAL_BAWAAN = [
    'https://ipulsamudin.github.io',
    'http://localhost',
    'http://localhost:80',
    'http://localhost:8080',
    'http://localhost:8787',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8787',
];

/**
 * Allowlist bisa diganti lewat env ASAL_DIIZINKAN (dipisah koma).
 *
 * Bentuknya disengaja sama dengan [vars] ASAL_DIIZINKAN di wrangler.toml,
 * supaya kedua backend dikonfigurasi dengan cara yang sama. Ini juga yang
 * dipakai test-ui.mjs untuk mendaftarkan port server statisnya sendiri --
 * tanpa itu, port uji harus ditanam di daftar bawaan, dan konfigurasi
 * produksi jadi memuat hal yang hanya relevan untuk tes.
 */
function asalDiizinkan(): array
{
    $dari_env = getenv('ASAL_DIIZINKAN');
    if (is_string($dari_env) && '' !== trim($dari_env)) {
        return array_values(array_filter(array_map('trim', explode(',', $dari_env))));
    }
    return ASAL_BAWAAN;
}

/* ---------------------------------------------------------------- jawaban --- */

/**
 * Satu-satunya jalan keluar dari skrip ini.
 *
 * Header CORS ditempelkan di SINI, bukan di masing-masing handler, supaya ia
 * ikut terpasang di respons error juga. Tanpa itu, exception yang tidak
 * tertangkap mengembalikan 500 tanpa header, browser melaporkan "blocked by
 * CORS policy", dan error yang sebenarnya jadi tidak terlihat sama sekali.
 */
function balas(int $status, array $isi, array $header = []): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');

    /* Vary: Origin wajib. Tanpanya, respons ter-cache bisa dilayani ke origin
       lain dengan header ACAO milik origin pertama. */
    header('Vary: Origin');

    $asal = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ('' !== $asal && in_array($asal, asalDiizinkan(), true)) {
        header('Access-Control-Allow-Origin: ' . $asal);
    }

    foreach ($header as $k => $v) {
        header($k . ': ' . $v);
    }

    echo json_encode($isi, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function gagal(int $status, string $kode, string $pesan, array $tambahan = [], array $header = []): void
{
    balas($status, ['ok' => false, 'kode' => $kode, 'pesan' => $pesan] + $tambahan, $header);
}

/* ------------------------------------------------------------ normalisasi --- */

/**
 * Karakter yang dianggap spasi dan DIUBAH menjadi satu spasi biasa.
 *
 * Kelasnya ditulis eksplisit, bukan memakai \s, karena \s punya cakupan yang
 * berbeda-beda antar engine regex (PCRE dengan/tanpa UCP, dan JS) -- dan
 * normalisasi ini harus identik di PHP, di Worker, dan di test-api.mjs.
 * Mengandalkan \s berarti mengandalkan dua engine sepakat tanpa pernah diuji.
 *
 * TAB, LF, VT, FF, CR ADA di sini dan karena itu TIDAK ada di POLA_BUANG.
 * Kalau mereka ikut dibuang, "ipul<TAB>samudin" menjadi "ipulsamudin" --
 * kunci yang berbeda dari "ipul samudin", padahal di layar orang menulis nama
 * yang sama. Itu justru memecah kunci satu-suara-per-nama, yaitu hal yang
 * seharusnya dicegah fungsi ini.
 */
const POLA_SPASI = '/[\x{0009}-\x{000D}\x{0020}\x{0085}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]+/u';

/**
 * Karakter yang DIBUANG dari nama sebelum dijadikan kunci.
 *
 * - U+0000-0008, U+000E-001F, U+007F : kontrol yang bukan spasi
 * - U+00AD                           : soft hyphen
 * - U+200B-200F                      : zero-width space/joiner/non-joiner + tanda arah
 * - U+202A-202E                      : override bidi, bisa membalik tampilan tabel hasil
 * - U+2066-2069                      : isolate bidi, alasan sama
 * - U+FEFF                           : BOM / zero-width no-break space
 *
 * Tanpa pembuangan ini, "ipul" dan "ipul" + U+200B jadi DUA pemilih berbeda
 * yang tampak identik di layar -- cara termurah memecah kunci.
 *
 * Perhatikan U+0009-000D, U+0085, dan U+00A0 TIDAK ada di sini: mereka sudah
 * jadi spasi di langkah sebelumnya.
 */
const POLA_BUANG = '/[\x{0000}-\x{0008}\x{000E}-\x{001F}\x{007F}\x{00AD}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]/u';

/**
 * Harus identik dengan normalkan() di worker/src/index.js dan di test-api.mjs.
 *
 * Urutannya menentukan: buang -> rapatkan -> trim -> lowercase.
 *
 * CATATAN PENTING: NFKC tidak dipakai. PHP di mesin ini tidak punya ekstensi
 * intl, jadi Normalizer::normalize() tidak tersedia, dan meng-NFKC hanya di
 * sisi Worker akan membuat nama yang sama menghasilkan kunci berbeda tergantung
 * backend mana yang melayani -- yaitu bug yang lebih buruk daripada yang
 * diperbaikinya. Konsekuensi yang diterima: "A" + combining acute tetap
 * berbeda kunci dari "A-akut" precomposed.
 *
 * mb_strtolower(..., 'UTF-8') di sini dan .toLowerCase() di JS sudah diuji
 * sepakat pada 16 kasus (termasuk I-bertitik Turki, eszett, sigma final
 * Yunani, Cyrillic, dan emoji astral).
 */
function normalkan(mixed $mentah): array
{
    $s = is_string($mentah) ? $mentah : '';

    /* URUTANNYA MENENTUKAN.
       1. semua jenis spasi -> satu spasi biasa (TAB jadi spasi, bukan hilang)
       2. buang sisa kontrol + zero-width + bidi
       3. rapatkan spasi yang mungkin berdampingan setelah langkah 2
       4. potong ujung
       Menukar 1 dan 2 adalah bug: lihat komentar di POLA_SPASI. */
    $s = preg_replace(POLA_SPASI, ' ', $s) ?? '';
    $s = preg_replace(POLA_BUANG, '', $s) ?? '';
    $s = preg_replace('/ {2,}/', ' ', $s) ?? '';
    $s = trim($s, ' ');

    return ['tampil' => $s, 'kunci' => mb_strtolower($s, 'UTF-8')];
}

/** Panjang dalam code point, bukan byte dan bukan UTF-16 code unit. */
function panjangCp(string $s): int
{
    return mb_strlen($s, 'UTF-8');
}

/**
 * ISO-8601 UTC dengan milidetik sungguhan.
 *
 * gmdate('...v...') selalu mengeluarkan .000 karena date() tidak punya
 * informasi sub-detik, jadi dipakai DateTimeImmutable yang punya. Formatnya
 * harus cocok dengan new Date().toISOString() di sisi Worker, dan JANGAN
 * datetime('now') milik SQLite yang menghasilkan '2026-10-29 06:12:00'
 * (spasi, tanpa Z) -- bukan ISO-8601, dan historis gagal di Safari.
 */
function sekarangIso(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}

/**
 * Menolak JSON array dan menerima JSON object.
 *
 * json_decode(..., true) mengubah {} dan [] sama-sama menjadi array kosong,
 * jadi array kosong dibiarkan lolos ke validasi field yang akan menolaknya
 * dengan pesan yang jauh lebih berguna daripada "badan-rusak".
 *
 * array_is_list() baru ada di PHP 8.1; di sini PHP 8.0.
 */
function berupaDaftar(array $a): bool
{
    if ([] === $a) {
        return false;
    }
    return array_keys($a) === range(0, count($a) - 1);
}

/* -------------------------------------------------------------- basis data --- */

function db(): PDO
{
    static $pdo = null;
    if (null !== $pdo) {
        return $pdo;
    }

    $baru = !file_exists(berkasDb());

    $pdo = new PDO('sqlite:' . berkasDb());
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    /* Inisialisasi idempoten: migrasinya memakai IF NOT EXISTS di semua
       statement, jadi menjalankannya berulang aman. Dijalankan juga saat
       berkasnya sudah ada, supaya skema yang tertinggal versi ikut terkejar. */
    $sql = file_get_contents(BERKAS_MIGRASI);
    if (false === $sql) {
        gagal(500, 'migrasi-hilang', 'Tidak bisa membaca ' . basename(BERKAS_MIGRASI) . '.');
    }
    $pdo->exec($sql);

    if ($baru) {
        error_log('voting: basis data baru dibuat di ' . berkasDb());
    }

    return $pdo;
}

/**
 * Salt untuk hash IP. Dibuat sekali lalu disimpan di berkas yang di-gitignore.
 *
 * Tanpa salt, `sidik` 16-hex yang kita terbitkan ke publik bisa dibalik dengan
 * mudah: ruang IPv4 cuma 2^32, tinggal di-brute force. Jadi ini satu-satunya
 * rahasia yang benar-benar menanggung beban di sistem ini.
 */
function ipSalt(): string
{
    $dari_env = getenv('IP_SALT');
    if (is_string($dari_env) && '' !== $dari_env) {
        return $dari_env;
    }
    if (file_exists(BERKAS_SALT)) {
        $isi = trim((string) file_get_contents(BERKAS_SALT));
        if ('' !== $isi) {
            return $isi;
        }
    }
    $baru = bin2hex(random_bytes(32));
    file_put_contents(BERKAS_SALT, $baru . "\n");
    return $baru;
}

/**
 * CF-Connecting-IP dipercaya HANYA karena trafik wajib melewati Cloudflare
 * (quick tunnel) untuk sampai ke sini dengan header itu terpasang.
 * X-Forwarded-For sengaja TIDAK dibaca: siapa pun bisa mengarangnya.
 */
function sidikPerangkat(): string
{
    $ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? '';
    if ('' === $ip) {
        return '';
    }
    return substr(hash('sha256', $ip . ipSalt()), 0, 16);
}

function uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/* ------------------------------------------------------------------ query --- */

/* Kolom disebut satu per satu, JANGAN SELECT *: tabel suara memuat token_hash
   dan sidik, dan endpoint ini publik. test-api.mjs punya assertion bahwa
   respons /api/hasil tidak memuat key token_hash, supaya refactor ke SELECT *
   di masa depan gagal berisik alih-alih bocor senyap. */
const KOLOM_PUBLIK = 'id, nama, pilihan, alasan, dibuat, diubah, revisi, asing';

function ambilHitung(PDO $pdo): array
{
    /* GROUP BY tidak mengembalikan baris untuk sisi yang nol suara, jadi
       di-seed dulu. Tanpa ini, {"A":4} dikirim tanpa key "B" sama sekali dan
       halaman merender "undefined". */
    $hitung = ['A' => 0, 'B' => 0];
    foreach ($pdo->query('SELECT pilihan, COUNT(*) AS n FROM suara GROUP BY pilihan') as $r) {
        $hitung[$r['pilihan']] = (int) $r['n'];
    }
    return $hitung;
}

function ambilSuara(PDO $pdo): array
{
    $st = $pdo->prepare('SELECT ' . KOLOM_PUBLIK . ' FROM suara ORDER BY diubah DESC LIMIT ' . BATAS_SUARA);
    $st->execute();
    return array_map('bentukSuara', $st->fetchAll());
}

function bentukSuara(array $r): array
{
    return [
        'id'      => (int) $r['id'],
        'nama'    => $r['nama'],
        'pilihan' => $r['pilihan'],
        'alasan'  => $r['alasan'],
        'dibuat'  => $r['dibuat'],
        'diubah'  => $r['diubah'],
        'revisi'  => (int) $r['revisi'],
        'asing'   => 1 === (int) $r['asing'],
    ];
}

function hasilLengkap(PDO $pdo): array
{
    $hitung = ambilHitung($pdo);
    return [
        'ok'     => true,
        'sumber' => 'langsung',
        'dibuat' => sekarangIso(),
        'tutup'  => tutup(),
        'total'  => $hitung['A'] + $hitung['B'],
        'hitung' => $hitung,
        'suara'  => ambilSuara($pdo),
    ];
}

/* --------------------------------------------------------------- handler --- */

function rutaHasil(PDO $pdo): void
{
    /* no-store, BUKAN max-age.
     *
     * Dengan `public, max-age=10` yang sempat dipakai di sini, urutan
     * "kirim suara lalu muat hasil" membuat browser melayani /api/hasil dari
     * cache-nya sendiri, karena jaraknya kurang dari 10 detik. Akibatnya
     * pemilih mengirim suara, melihat angka tidak berubah, dan menyimpulkan
     * suaranya hilang. Halaman juga sudah cache-bust, tapi header ini
     * mencegah jebakan yang sama untuk konsumen lain seperti curl di CI.
     *
     * Penghematan row-read dari cache 10 detik tidak relevan di skala polling
     * ini, dan tidak sebanding dengan angka yang salah di depan mata orang. */
    balas(200, hasilLengkap($pdo), ['Cache-Control' => 'no-store']);
}

function rutaRiwayat(PDO $pdo): void
{
    /* batas di-CLAMP, bukan ditolak dengan 400. Nilai di luar jangkauan itu
       kesalahan tak berbahaya; menolaknya cuma menyusahkan pemakai curl. */
    $batas = (int) ($_GET['batas'] ?? 200);
    $batas = max(1, min(BATAS_RIWAYAT, $batas));

    $st = $pdo->prepare(
        'SELECT ke, nama, pilihan, alasan, aksi, asing, sidik, waktu
           FROM suara_log ORDER BY ke DESC LIMIT ' . $batas
    );
    $st->execute();

    $riwayat = array_map(static fn(array $r): array => [
        'ke'      => (int) $r['ke'],
        'nama'    => $r['nama'],
        'pilihan' => $r['pilihan'],
        'alasan'  => $r['alasan'],
        'aksi'    => $r['aksi'],
        'asing'   => 1 === (int) $r['asing'],
        'sidik'   => $r['sidik'],
        'waktu'   => $r['waktu'],
    ], $st->fetchAll());

    $total = (int) $pdo->query('SELECT COUNT(*) AS n FROM suara_log')->fetch()['n'];

    balas(200, ['ok' => true, 'total' => $total, 'riwayat' => $riwayat]);
}

function rutaEkspor(PDO $pdo): void
{
    $suara = $pdo->query('SELECT ' . KOLOM_PUBLIK . ' FROM suara ORDER BY id')->fetchAll();
    $log   = $pdo->query(
        'SELECT ke, nama, pilihan, alasan, aksi, asing, sidik, waktu FROM suara_log ORDER BY ke'
    )->fetchAll();

    balas(200, [
        'ok'        => true,
        'dibuat'    => sekarangIso(),
        'suara'     => array_map('bentukSuara', $suara),
        'suara_log' => $log,
    ], ['Cache-Control' => 'no-store']);
}

function rutaSuara(PDO $pdo): void
{
    if (tutup()) {
        /* 423 Locked, bukan 403, supaya halaman bisa membedakan "voting sudah
           ditutup" dari "permintaanmu ditolak". */
        gagal(423, 'voting-tutup', 'Voting sudah ditutup. Hasilnya tetap bisa dilihat.');
    }

    $mentah = file_get_contents('php://input');
    if (false === $mentah) {
        $mentah = '';
    }
    if (strlen($mentah) > BATAS_BADAN) {
        gagal(400, 'badan-rusak', 'Data yang dikirim terlalu besar.');
    }

    $badan = json_decode($mentah, true, 8);
    if (!is_array($badan) || berupaDaftar($badan)) {
        gagal(400, 'badan-rusak', 'Data yang dikirim tidak bisa dibaca.');
    }

    /* --- nama --- */
    $n = normalkan($badan['nama'] ?? null);
    if ('' === $n['kunci']) {
        gagal(400, 'nama-kosong', 'Nama belum diisi.');
    }
    if (panjangCp($n['tampil']) > BATAS_NAMA) {
        gagal(400, 'nama-panjang', 'Nama maksimal ' . BATAS_NAMA . ' karakter.');
    }
    if (!preg_match('/\p{L}/u', $n['tampil'])) {
        gagal(400, 'nama-tanpa-huruf', 'Nama harus memuat setidaknya satu huruf.');
    }

    /* --- pilihan: cocok persis, tanpa coercion dan tanpa lipat huruf --- */
    $pilihan = $badan['pilihan'] ?? null;
    if ('A' !== $pilihan && 'B' !== $pilihan) {
        gagal(400, 'pilihan-tidak-sah', 'Pilih salah satu video dulu.');
    }

    /* --- alasan --- */
    $alasanMentah = $badan['alasan'] ?? '';
    if (null === $alasanMentah) {
        $alasanMentah = '';
    }
    if (!is_string($alasanMentah)) {
        gagal(400, 'badan-rusak', 'Alasan harus berupa teks.');
    }
    $alasan = trim(preg_replace(POLA_BUANG, '', $alasanMentah) ?? '');
    if (panjangCp($alasan) > BATAS_ALASAN) {
        gagal(400, 'alasan-panjang', 'Alasan maksimal ' . BATAS_ALASAN . ' karakter.');
    }

    /* --- token --- */
    $token = $badan['token'] ?? null;
    if (null !== $token && (!is_string($token) || 1 !== preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $token))) {
        gagal(400, 'token-tidak-sah', 'Token perangkat tidak dikenali.');
    }

    $tokenBaru  = $token ?? uuid();
    $tokenHash  = hash('sha256', $tokenBaru);
    $sekarang   = sekarangIso();
    $sidik      = sidikPerangkat();

    /* Upsert yang SAMA dengan Worker, tapi tanpa RETURNING.
     *
     * SQLite yang dibundel PHP 8.0.30 di mesin ini versi 3.33.0, dan RETURNING
     * baru ada di 3.35. Jadi di sini dipakai transaksi BEGIN IMMEDIATE yang
     * membungkus baca-tulis-baca.
     *
     * Itu bukan penurunan kualitas: BEGIN IMMEDIATE mengambil kunci tulis
     * sebelum statement pertama, sehingga dua POST serentak untuk nama yang
     * sama TIDAK bisa sama-sama membaca "belum ada" lalu sama-sama mengira
     * dirinya 'baru'. Race yang di sisi Worker ditutup oleh atomisitas satu
     * statement, di sini ditutup oleh kunci tulis. Log-nya tetap dijamin
     * trigger di kedua jalur.
     */
    $sqlUpsert = 'INSERT INTO suara
              (nama_norm, nama, pilihan, alasan, dibuat, diubah, revisi, token_hash, sidik, asing)
            VALUES (:kunci, :nama, :pilihan, :alasan, :waktu, :waktu, 0, :token, :sidik, 0)
            ON CONFLICT(nama_norm) DO UPDATE SET
              nama       = excluded.nama,
              pilihan    = excluded.pilihan,
              alasan     = excluded.alasan,
              diubah     = excluded.diubah,
              revisi     = suara.revisi + 1,
              sidik      = excluded.sidik,
              token_hash = COALESCE(suara.token_hash, excluded.token_hash),
              asing      = CASE
                             WHEN suara.token_hash IS NULL THEN 0
                             WHEN excluded.token_hash IS NOT NULL
                                  AND suara.token_hash = excluded.token_hash THEN 0
                             ELSE 1
                           END';

    /* Menunggu, bukan langsung gagal, kalau ada penulis lain yang sedang
       memegang kunci. 5 detik jauh lebih dari cukup untuk satu INSERT. */
    $pdo->exec('PRAGMA busy_timeout = 5000');

    $baris = null;
    try {
        $pdo->exec('BEGIN IMMEDIATE');

        if (ketat()) {
            $st = $pdo->prepare('SELECT token_hash FROM suara WHERE nama_norm = ?');
            $st->execute([$n['kunci']]);
            $ada = $st->fetch();
            if ($ada && null !== $ada['token_hash'] && $ada['token_hash'] !== $tokenHash) {
                $pdo->exec('ROLLBACK');
                gagal(403, 'bukan-pemilik', 'Nama ini sudah dipakai dari perangkat lain.');
            }
        }

        $st = $pdo->prepare($sqlUpsert);
        $st->execute([
            ':kunci'   => $n['kunci'],
            ':nama'    => $n['tampil'],
            ':pilihan' => $pilihan,
            ':alasan'  => $alasan,
            ':waktu'   => $sekarang,
            ':token'   => $tokenHash,
            ':sidik'   => $sidik,
        ]);

        $st = $pdo->prepare('SELECT ' . KOLOM_PUBLIK . ' FROM suara WHERE nama_norm = ?');
        $st->execute([$n['kunci']]);
        $baris = $st->fetch();

        $pdo->exec('COMMIT');
    } catch (PDOException $e) {
        /* @ karena ROLLBACK pada transaksi yang sudah tidak aktif akan
           melempar exception kedua dan menutupi yang asli. */
        @$pdo->exec('ROLLBACK');

        /* CHECK constraint yang jebol di sini berarti ada aturan validasi di
           atas yang bocor. Dilaporkan sebagai 400, bukan 500, supaya
           halamannya memberi pesan yang berguna. */
        if (str_contains($e->getMessage(), 'CHECK constraint')) {
            gagal(400, 'data-tidak-sah', 'Data yang dikirim tidak memenuhi aturan.');
        }
        throw $e;
    }

    if (!$baris) {
        gagal(500, 'simpan-gagal', 'Suara tidak tersimpan. Coba lagi.');
    }

    $suara  = bentukSuara($baris);
    $aksi   = 0 === $suara['revisi'] ? 'baru' : 'ubah';
    $hitung = ambilHitung($pdo);

    $isi = [
        'ok'     => true,
        'aksi'   => $aksi,
        'suara'  => $suara,
        'hitung' => $hitung,
        'total'  => $hitung['A'] + $hitung['B'],
    ];

    /* Token hanya dikembalikan saat nama ini pertama kali diklaim. Sesudah itu
       ia tidak pernah dikirim lagi, jadi tidak bisa dipanen dari respons. */
    if ('baru' === $aksi) {
        $isi['token'] = $tokenBaru;
    }

    /* Respons membawa tally terbaru supaya halaman tidak perlu GET susulan. */
    balas(200, $isi);
}

/* -------------------------------------------------------------------- jalan --- */

/**
 * Berkas ini bisa di-require sebagai library untuk memakai fungsinya tanpa
 * menjalankan dispatch:
 *
 *   define('VOTING_SEBAGAI_LIBRARY', true);
 *   require 'lokal/api.php';
 *   print_r(normalkan("  Ipul  "));
 *
 * Dipakai test-api.mjs untuk membandingkan normalkan() di sini dengan
 * normalizer mandiri milik tes. Itu assertion terkuat yang ada: ia menguji
 * kontraknya langsung, bukan lewat efeknya di basis data.
 */
if (defined('VOTING_SEBAGAI_LIBRARY')) {
    return;
}

/**
 * Seluruh dispatch dibungkus satu try/catch supaya tidak ada jalan keluar yang
 * melewatkan header CORS -- lihat komentar di balas().
 */
try {
    /* PATH_INFO terisi saat dilayani Apache sebagai .../api.php/api/hasil.
       Dengan `php -S host:port lokal/api.php`, PATH_INFO kosong dan path-nya
       ada di REQUEST_URI. Dua-duanya didukung supaya satu berkas ini melayani
       XAMPP dan server bawaan tanpa perubahan. */
    $rute = $_SERVER['PATH_INFO'] ?? '';
    if ('' === $rute) {
        $rute = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

        /* Buang prefiks skrip bila ada, mis. /kontrakan-voting/lokal/api.php.
         *
         * Syarat ".php" itu WAJIB, bukan kehati-hatian berlebihan: dengan
         * `php -S host:port lokal/api.php`, PHP mengisi SCRIPT_NAME dengan
         * path request itu sendiri ('/api/hasil'), bukan dengan nama berkas
         * router. Memotongnya tanpa syarat menyisakan string kosong, dan
         * SEMUA rute jadi 404. Di Apache, SCRIPT_NAME memang berujung .php,
         * jadi syarat ini tepat memisahkan kedua kasus.
         */
        $skrip = $_SERVER['SCRIPT_NAME'] ?? '';
        if ('' !== $skrip && str_ends_with($skrip, '.php') && str_starts_with($rute, $skrip)) {
            $rute = substr($rute, strlen($skrip));
        }
    }
    $rute   = '/' . trim($rute, '/');
    $metode = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ('OPTIONS' === $metode) {
        balas(204, [], [
            'Access-Control-Allow-Methods' => 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers' => 'content-type',
            'Access-Control-Max-Age'       => '86400',
        ]);
    }

    $tabel = [
        '/api/hasil'   => ['GET',  'rutaHasil'],
        '/api/riwayat' => ['GET',  'rutaRiwayat'],
        '/api/ekspor'  => ['GET',  'rutaEkspor'],
        '/api/suara'   => ['POST', 'rutaSuara'],
    ];

    if (!isset($tabel[$rute])) {
        gagal(404, 'rute-tidak-ada', 'Alamat ini tidak ada.');
    }

    [$metodeWajib, $handler] = $tabel[$rute];
    if ($metode !== $metodeWajib) {
        gagal(405, 'metode-salah', 'Metode ' . $metode . ' tidak dilayani di sini.', [], ['Allow' => $metodeWajib]);
    }

    $handler(db());
} catch (Throwable $e) {
    error_log('voting: ' . $e->getMessage());
    gagal(500, 'galat-server', 'Ada yang salah di server. Coba lagi sebentar.');
}
