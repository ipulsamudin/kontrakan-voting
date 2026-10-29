/**
 * Uji kontrak API voting.
 *
 *   node test-api.mjs                      jalankan sendiri `php -S` + DB sekali pakai
 *   node test-api.mjs --dasar http://...   uji backend yang sudah hidup (mis. wrangler dev)
 *
 * Tes ini dijalankan terhadap DUA implementasi, lokal/api.php dan
 * worker/src/index.js, justru supaya perbedaan perilaku di antara keduanya
 * ketahuan. Kalau Anda mengubah aturan validasi di satu sisi saja, salah satu
 * jalur akan gagal di sini.
 *
 * Prinsip yang diwarisi dari project induk: nilai yang diharapkan DIHITUNG
 * ULANG di dalam tes dengan implementasi terpisah, bukan diambil dari kode yang
 * diuji. Dua assertion yang benar-benar menegakkan itu:
 *   - "normalizer PHP cocok dengan normalizer tes" -- menguji kontraknya langsung
 *   - "hitung ulang mandiri cocok dengan server"   -- satu-satunya yang bisa
 *     menangkap bug agregasi; sisanya mempercayai aritmetika server
 *
 * CATATAN GAYA: berkas ini sengaja 100% ASCII. Karakter khusus dibangun dari
 * code point lewat cp(), dan kelas regex dibangun dari tabel angka. Menulis
 * \uXXXX langsung di sini pernah rusak saat berkasnya lewat perkakas yang
 * memproses escape JSON -- dan regex yang rusak senyap adalah mode gagal
 * terburuk untuk kunci satu-suara-per-nama.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------- argumen --- */

const arg = process.argv.slice(2);
const iDasar = arg.indexOf('--dasar');
const DASAR_LUAR = iDasar >= 0 ? arg[iDasar + 1] : null;

/* --worker menjalankan `wrangler dev --local` dan menguji Worker + D1 dengan
   kontrak yang SAMA PERSIS. Itulah gunanya berkas tes ini punya dua mode:
   perbedaan perilaku antara lokal/api.php dan worker/src/index.js hanya
   ketahuan kalau keduanya diuji dengan assertion yang sama. */
const PAKAI_WORKER = arg.includes('--worker');

/* Sebagian assertion hanya masuk akal untuk backend PHP lokal: membuka berkas
   SQLite langsung, membandingkan normalkan() PHP, dan menjalankan instance
   kedua dengan VOTING_TUTUP=1. */
const BACKEND_PHP_LOKAL = !DASAR_LUAR && !PAKAI_WORKER;

const PORT = 8791;
const PORT_TUTUP = 8792;
const DB_UJI = path.join(os.tmpdir(), `voting-uji-${process.pid}.sqlite`);
const DB_TUTUP = path.join(os.tmpdir(), `voting-tutup-${process.pid}.sqlite`);

const ASAL_SAH = 'https://ipulsamudin.github.io';
const ASAL_ASING = 'https://jahat.example';

/* --------------------------------------------------- karakter uji khusus --- */

const cp = (k) => String.fromCodePoint(k);

const TAB = cp(0x09);
const LF = cp(0x0a);
const CR = cp(0x0d);
const NBSP = cp(0xa0); /* no-break space */
const SHY = cp(0xad); /* soft hyphen */
const ZWSP = cp(0x200b); /* zero-width space */
const ENSP = cp(0x2002); /* en space */
const RLO = cp(0x202e); /* right-to-left override */
const IDEO = cp(0x3000); /* ideographic space */
const EMOJI = cp(0x1f600); /* di luar BMP: 1 code point, 2 UTF-16 unit */

/* -------------------------------------------------- normalizer mandiri --- */

/**
 * Implementasi normalisasi KEDUA, ditulis terpisah dari lokal/api.php dan
 * worker/src/index.js.
 *
 * Sengaja TIDAK meng-NFKC, mengikuti kontrak: PHP di mesin ini tanpa ekstensi
 * intl, jadi NFKC tidak bisa dijamin identik di kedua backend, dan menerapkannya
 * hanya di satu sisi adalah bug yang lebih buruk daripada tidak punya NFKC.
 */

/* Code point yang dianggap spasi dan DIUBAH menjadi satu spasi biasa.
   TAB sampai CR ada di sini, karena itu TIDAK ada di KODE_BUANG: kalau ikut
   dibuang, "ipul<TAB>samudin" jadi "ipulsamudin" -- kunci berbeda dari
   "ipul samudin" yang ditulis orang lain dengan spasi biasa. */
const KODE_SPASI = [
  [0x09, 0x0d], 0x20, 0x85, 0xa0, 0x1680, [0x2000, 0x200a],
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

/* Code point yang DIBUANG: kontrol bukan-spasi, soft hyphen, zero-width,
   dan penanda arah bidi (yang bisa membalik tampilan tabel hasil). */
const KODE_BUANG = [
  [0x00, 0x08], [0x0e, 0x1f], 0x7f, 0xad, [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2066, 0x2069], 0xfeff,
];

const escRegex = (k) => '\\u' + k.toString(16).padStart(4, '0');
const kelas = (tabel) =>
  tabel.map((e) => (Array.isArray(e) ? escRegex(e[0]) + '-' + escRegex(e[1]) : escRegex(e))).join('');

/* Kelas eksplisit, bukan \s: cakupan \s berbeda antar engine regex (PCRE
   dengan/tanpa UCP, dan JS), dan kontraknya harus identik di tiga tempat.
   Mengandalkan \s berarti mengandalkan dua engine sepakat tanpa pernah diuji. */
const POLA_SPASI = new RegExp('[' + kelas(KODE_SPASI) + ']+', 'g');
const POLA_BUANG = new RegExp('[' + kelas(KODE_BUANG) + ']', 'g');

function normalkanUji(mentah) {
  const bersih = String(mentah ?? '')
    .replace(POLA_SPASI, ' ')
    .replace(POLA_BUANG, '')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/g, '');
  return { tampil: bersih, kunci: bersih.toLowerCase() };
}

/* ------------------------------------------------------------- kerangka --- */

let lulus = 0;
let gagal = 0;

function cek(nama, aktual, diharap) {
  const ok = JSON.stringify(aktual) === JSON.stringify(diharap);
  const ekor = ok ? JSON.stringify(aktual) : `dapat ${JSON.stringify(aktual)}, harap ${JSON.stringify(diharap)}`;
  console.log(`${ok ? 'OK   ' : 'GAGAL'} ${nama.padEnd(54)} ${ekor}`);
  if (ok) lulus++;
  else gagal++;
}

function cekBenar(nama, kondisi, info = '') {
  console.log(`${kondisi ? 'OK   ' : 'GAGAL'} ${nama.padEnd(54)} ${kondisi ? '' : info}`);
  if (kondisi) lulus++;
  else gagal++;
}

/* ----------------------------------------------------------------- http --- */

let DASAR = DASAR_LUAR;

async function minta(metode, jalur, opsi = {}) {
  const { badan, origin, tipe = 'text/plain;charset=UTF-8' } = opsi;
  const header = {};
  if (origin) header.Origin = origin;
  if (badan !== undefined) header['Content-Type'] = tipe;

  const res = await fetch(DASAR + jalur, {
    method: metode,
    headers: header,
    body: badan === undefined ? undefined : typeof badan === 'string' ? badan : JSON.stringify(badan),
  });

  const teks = await res.text();
  let json = null;
  try {
    json = teks ? JSON.parse(teks) : null;
  } catch {
    /* dibiarkan null; ada assertion yang memang menguji badan non-JSON */
  }
  return { status: res.status, headers: res.headers, teks, json };
}

const ambil = (jalur, opsi) => minta('GET', jalur, opsi);
const kirim = (badan, opsi = {}) => minta('POST', '/api/suara', { badan, ...opsi });

/* ---------------------------------------------------------------- proses --- */

const anak = [];

function jalankanServer(port, dbPath, env = {}) {
  const p = spawn('php', ['-S', `127.0.0.1:${port}`, 'lokal/api.php'], {
    env: { ...process.env, VOTING_DB: dbPath, IP_SALT: 'salt-uji-tetap', ...env },
    stdio: 'ignore',
  });
  anak.push(p);
  return p;
}

async function tungguSiap(dasar, batasMs = 15000) {
  const mulai = Date.now();
  while (Date.now() - mulai < batasMs) {
    try {
      const res = await fetch(dasar + '/api/hasil');
      if (res.ok) return true;
    } catch {
      /* server belum mendengarkan */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Mematikan proses beserta seluruh anaknya.
 *
 * p.kill() saja TIDAK cukup di Windows: `npx wrangler dev` memunculkan
 * workerd.exe sebagai cucu, dan membunuh induknya meninggalkan workerd tetap
 * hidup serta tetap memegang portnya. Akibatnya tes berikutnya gagal dengan
 * alasan yang membingungkan, dan mesin pemakai ditinggali proses nyasar.
 */
function matikanPohon(p) {
  if (!p || !p.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      p.kill();
    }
  } catch {
    /* sudah mati, atau tidak pernah hidup */
  }
}

function bersihkan() {
  for (const p of anak) matikanPohon(p);
  for (const f of [DB_UJI, DB_TUTUP]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* biarkan */
    }
  }
}

process.on('exit', bersihkan);

/**
 * Query langsung ke berkas SQLite, memakai php sebagai klien.
 *
 * Dipakai untuk satu assertion yang TIDAK boleh lewat API: membuktikan tidak
 * ada baris dengan pilihan IS NULL. Lewat API, bug seperti itu justru tidak
 * terlihat -- itulah intinya.
 */
function tanyaDb(dbPath, sql) {
  const kode = '$p = new PDO("sqlite:" . $argv[1]); echo json_encode($p->query($argv[2])->fetchAll(PDO::FETCH_ASSOC));';
  return JSON.parse(execFileSync('php', ['-r', kode, dbPath, sql], { encoding: 'utf8' }));
}

/** Memanggil normalkan() milik lokal/api.php lewat CLI. */
function normalkanPhp(daftar) {
  const keluar = execFileSync('php', ['alat/normalkan-cli.php'], {
    input: JSON.stringify(daftar),
    encoding: 'utf8',
  });
  return JSON.parse(keluar);
}

/* ------------------------------------------------------------------ jalan --- */

if (PAKAI_WORKER) {
  /* D1 lokal PERSISTEN di worker/.wrangler/state, tidak seperti berkas sekali
     pakai yang dipakai mode PHP. Tanpa reset, run kedua mewarisi suara run
     pertama dan hampir semua assertion hitungan gagal dengan angka yang
     membingungkan -- bukan karena kodenya salah, tapi karena keadaan awalnya
     tidak bersih. */
  fs.rmSync(path.join('worker', '.wrangler', 'state'), { recursive: true, force: true });
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'migrations', 'apply', 'kontrakan-voting', '--local', '--config', 'worker/wrangler.toml'],
    { stdio: 'ignore', shell: true }
  );

  /* shell:true karena di Windows npx itu npx.cmd dan bukan executable yang
     bisa di-spawn langsung. */
  const p = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(PORT), '--config', 'worker/wrangler.toml'],
    { stdio: 'ignore', shell: true }
  );
  anak.push(p);
  DASAR = `http://127.0.0.1:${PORT}`;
  /* wrangler butuh jauh lebih lama untuk siap daripada `php -S`. */
  if (!(await tungguSiap(DASAR, 90000))) {
    console.error(`GAGAL: wrangler dev tidak siap di ${DASAR}`);
    process.exit(1);
  }
} else if (BACKEND_PHP_LOKAL) {
  fs.rmSync(DB_UJI, { force: true });
  jalankanServer(PORT, DB_UJI);
  DASAR = `http://127.0.0.1:${PORT}`;
  if (!(await tungguSiap(DASAR))) {
    console.error(`GAGAL: server php tidak siap di ${DASAR}`);
    process.exit(1);
  }
}

console.log(`Menguji ${DASAR}`);
console.log(DASAR_LUAR ? '(backend luar, DB tidak dibersihkan)\n' : `(DB sekali pakai: ${DB_UJI})\n`);

/* --- 0. kesepakatan normalizer ----------------------------------------- */

if (BACKEND_PHP_LOKAL) {
  /* Assertion terkuat di berkas ini: membandingkan normalkan() PHP dengan
     normalkanUji() di atas, pada input yang sama, tanpa lewat HTTP atau DB.
     Kalau keduanya pernah menyimpang, kunci satu-suara-per-nama akan berbeda
     tergantung backend mana yang melayani -- dan itu bug yang tak terlihat
     sampai suara sudah tercampur. */
  const contoh = [
    'Ipul',
    '  IPUL  ',
    'ipul' + ZWSP,
    'i' + RLO + 'pul',
    'ipul' + TAB + 'samudin',
    'ipul' + LF + 'samudin',
    'ipul' + CR + LF + 'samudin',
    'ipul' + NBSP + 'samudin',
    'ipul' + IDEO + 'samudin',
    'ipul' + ENSP + 'samudin',
    'ipul  samudin',
    'ipul ' + TAB + ' samudin',
    'ip' + SHY + 'ul',
    EMOJI + 'ipul',
    '   ',
    '',
    'Agus Setiawan',
    'MARIA MAGDALENA',
  ];

  const dariPhp = normalkanPhp(contoh);
  let beda = 0;
  contoh.forEach((s, i) => {
    const uji = normalkanUji(s);
    if (uji.tampil !== dariPhp[i].tampil || uji.kunci !== dariPhp[i].kunci) {
      beda++;
      console.log(
        `     beda pada ${JSON.stringify(s)}: php=${JSON.stringify(dariPhp[i])} uji=${JSON.stringify(uji)}`
      );
    }
  });
  cek(`normalizer PHP cocok dengan normalizer tes (${contoh.length} kasus)`, beda, 0);

  /* Beberapa kesepakatan yang nilainya dipatok eksplisit, supaya perubahan
     kontrak tidak lolos hanya karena kedua implementasi berubah bersamaan. */
  cek('kontrak: TAB jadi spasi', normalkanUji('a' + TAB + 'b').kunci, 'a b');
  cek('kontrak: zero-width dibuang', normalkanUji('a' + ZWSP + 'b').kunci, 'ab');
  cek('kontrak: NBSP jadi spasi', normalkanUji('a' + NBSP + 'b').kunci, 'a b');
  cek('kontrak: spasi ganda dirapatkan', normalkanUji('a  b').kunci, 'a b');
  cek('kontrak: ujung dipotong', normalkanUji('  ab  ').kunci, 'ab');
}

/* --- 1. keadaan awal ---------------------------------------------------- */

{
  const r = await ambil('/api/hasil');
  cek('hasil: status pada DB kosong', r.status, 200);
  cek('hasil: total awal', r.json?.total, 0);
  /* GROUP BY tidak mengembalikan baris untuk sisi nol suara, jadi ini
     membuktikan hitung di-seed dan bukan dikosongkan. */
  cek('hasil: hitung di-seed A dan B', r.json?.hitung, { A: 0, B: 0 });
  cek('hasil: sumber', r.json?.sumber, 'langsung');
  cek('hasil: tutup', r.json?.tutup, false);
  cekBenar('hasil: suara berupa array kosong', Array.isArray(r.json?.suara) && r.json.suara.length === 0);
}

/* --- 2. CORS ------------------------------------------------------------ */

{
  const r = await minta('OPTIONS', '/api/suara', { origin: ASAL_SAH });
  cek('OPTIONS: status', r.status, 204);
  cek('OPTIONS: ACAO meng-echo origin tepat', r.headers.get('access-control-allow-origin'), ASAL_SAH);
  cekBenar('OPTIONS: Vary Origin ada', (r.headers.get('vary') || '').toLowerCase().includes('origin'));
  cekBenar(
    'OPTIONS: Allow-Methods memuat POST',
    (r.headers.get('access-control-allow-methods') || '').includes('POST')
  );
}

{
  const r = await minta('OPTIONS', '/api/suara', { origin: ASAL_ASING });
  cek('OPTIONS: origin asing TIDAK dapat ACAO', r.headers.get('access-control-allow-origin'), null);
  cekBenar('OPTIONS: origin asing tetap dapat Vary', (r.headers.get('vary') || '').toLowerCase().includes('origin'));
}

/* --- 3. satu suara per nama (persyaratan inti) -------------------------- */

let tokenIpul = null;

{
  const r = await kirim({ nama: 'Ipul', pilihan: 'A', alasan: 'lebih dekat' }, { origin: ASAL_SAH });
  cek('suara baru: status', r.status, 200);
  cek('suara baru: aksi', r.json?.aksi, 'baru');
  cek('suara baru: revisi', r.json?.suara?.revisi, 0);
  cek('suara baru: asing', r.json?.suara?.asing, false);
  cek('suara baru: hitung ikut dikirim', r.json?.hitung, { A: 1, B: 0 });
  cekBenar(
    'suara baru: token dikembalikan',
    typeof r.json?.token === 'string' && r.json.token.length === 36,
    String(r.json?.token)
  );
  cek('suara baru: ACAO terpasang', r.headers.get('access-control-allow-origin'), ASAL_SAH);
  tokenIpul = r.json?.token ?? null;
}

const dibuatAwal = (await ambil('/api/hasil')).json?.suara?.[0]?.dibuat ?? null;

{
  /* Beda kapital DAN spasi di kedua ujung. Ini inti persyaratannya. */
  const r = await kirim({ nama: '  IPUL  ', pilihan: 'B', alasan: 'berubah pikiran', token: tokenIpul });
  cek('nama sama beda kapital: aksi', r.json?.aksi, 'ubah');
  cek('nama sama beda kapital: revisi', r.json?.suara?.revisi, 1);
  cek('token benar: tidak ditandai asing', r.json?.suara?.asing, false);
  cek('nama sama beda kapital: total TETAP 1', r.json?.total, 1);
  cek('nama sama beda kapital: pilihan pindah ke B', r.json?.hitung, { A: 0, B: 1 });
}

{
  const r = await ambil('/api/hasil');
  cek('update: dibuat dipertahankan', r.json?.suara?.[0]?.dibuat, dibuatAwal);
  cekBenar(
    'update: diubah lebih baru dari dibuat',
    new Date(r.json?.suara?.[0]?.diubah) > new Date(r.json?.suara?.[0]?.dibuat)
  );
}

{
  /* Zero-width space di ujung nama: cara termurah memecah kunci kalau tidak
     dibuang. Harus tetap mengenali pemilih yang sama. */
  const r = await kirim({ nama: 'ipul' + ZWSP, pilihan: 'A', alasan: 'uji zero-width', token: tokenIpul });
  cek('nama + zero-width: tetap ubah', r.json?.aksi, 'ubah');
  cek('nama + zero-width: total tetap 1', r.json?.total, 1);
}

{
  const r = await kirim({ nama: 'i' + RLO + 'pul', pilihan: 'A', alasan: 'uji bidi', token: tokenIpul });
  cek('nama + override bidi: tetap ubah', r.json?.aksi, 'ubah');
  cek('nama + override bidi: total tetap 1', r.json?.total, 1);
}

{
  /* TAB harus jadi SPASI, bukan hilang. Kalau ia dibuang bersama control
     character lain, nama ini jadi "ipulsamudin" -- kunci berbeda dari
     "ipul samudin" yang ditulis orang lain dengan spasi biasa, dan satu orang
     bisa berakhir punya dua suara tanpa niat. */
  const r = await kirim({ nama: 'ipul' + TAB + 'samudin', pilihan: 'A' });
  cek('TAB di tengah nama jadi satu spasi', r.json?.suara?.nama, 'ipul samudin');
  cek('nama berbeda: jadi pemilih baru', r.json?.aksi, 'baru');
  cek('nama berbeda: total jadi 2', r.json?.total, 2);
}

{
  /* Semua varian spasi harus runtuh ke kunci yang sama dengan "ipul samudin". */
  const varian = [
    ['newline', 'ipul' + LF + 'samudin'],
    ['CR LF', 'ipul' + CR + LF + 'samudin'],
    ['NBSP', 'ipul' + NBSP + 'samudin'],
    ['spasi ideografis', 'ipul' + IDEO + 'samudin'],
    ['en space', 'ipul' + ENSP + 'samudin'],
    ['spasi ganda', 'ipul  samudin'],
    ['spasi + TAB campur', 'ipul ' + TAB + ' samudin'],
  ];
  for (const [label, nama] of varian) {
    const r = await kirim({ nama, pilihan: 'A' });
    cek(`varian spasi (${label}): kunci sama`, [r.json?.aksi, r.json?.total], ['ubah', 2]);
  }
}

/* --- 4. token lunak ---------------------------------------------------- */

{
  const r = await kirim({
    nama: 'Ipul',
    pilihan: 'B',
    alasan: 'dari perangkat lain',
    token: '11111111-2222-4333-8444-555555555555',
  });
  cek('token tidak cocok: write TETAP berhasil', r.status, 200);
  cek('token tidak cocok: ditandai asing', r.json?.suara?.asing, true);
}

{
  const r = await kirim({ nama: 'Ipul', pilihan: 'B', token: tokenIpul });
  cek('token asli kembali: tidak lagi asing', r.json?.suara?.asing, false);
}

{
  const r = await kirim({ nama: 'Ipul', pilihan: 'B', token: 'bukan-uuid' });
  cek('token bukan uuid: status', r.status, 400);
  cek('token bukan uuid: kode', r.json?.kode, 'token-tidak-sah');
}

/* --- 5. validasi nama -------------------------------------------------- */

{
  const r = await kirim({ nama: '   ', pilihan: 'A' });
  cek('nama hanya spasi: status', r.status, 400);
  cek('nama hanya spasi: kode', r.json?.kode, 'nama-kosong');
}

{
  const r = await kirim({ nama: '12345', pilihan: 'A' });
  cek('nama tanpa huruf: kode', r.json?.kode, 'nama-tanpa-huruf');
}

{
  const r = await kirim({ nama: 'x'.repeat(61), pilihan: 'A' });
  cek('nama 61 karakter: kode', r.json?.kode, 'nama-panjang');
}

{
  const r = await kirim({ nama: 'x'.repeat(60), pilihan: 'A' });
  cek('nama 60 karakter: diterima', r.status, 200);
}

/* --- 6. validasi pilihan ---------------------------------------------- */

{
  const r = await kirim({ nama: 'Penguji C', pilihan: 'C' });
  cek('pilihan C: kode', r.json?.kode, 'pilihan-tidak-sah');
}

{
  const r = await kirim({ nama: 'Penguji kecil', pilihan: 'a' });
  cek('pilihan huruf kecil: ditolak, tanpa lipat huruf', r.json?.kode, 'pilihan-tidak-sah');
}

{
  const r = await kirim({ nama: 'Penguji null', pilihan: null });
  cek('pilihan null: status', r.status, 400);
  cek('pilihan null: kode', r.json?.kode, 'pilihan-tidak-sah');
}

if (BACKEND_PHP_LOKAL) {
  /* Dibuktikan LANGSUNG di basis data, bukan lewat API.
     CHECK(pilihan IN ('A','B')) tanpa NOT NULL akan meloloskan NULL, karena
     `NULL IN (...)` bernilai NULL dan SQLite menganggap CHECK yang bukan FALSE
     sebagai lulus. Lewat API bug ini justru tidak terlihat. */
  const baris = tanyaDb(DB_UJI, 'SELECT COUNT(*) AS n FROM suara WHERE pilihan IS NULL');
  cek('DB: tidak ada baris dengan pilihan NULL', Number(baris[0].n), 0);
}

/* --- 7. validasi alasan ----------------------------------------------- */

{
  /* 499 huruf + 1 emoji = 500 code point. Emoji di batas membuktikan yang
     dihitung code point, bukan UTF-16 code unit (emoji = 2 unit). */
  const alasan500 = 'y'.repeat(499) + EMOJI;
  const r = await kirim({ nama: 'Penguji alasan', pilihan: 'A', alasan: alasan500 });
  cek('alasan 500 code point (emoji di batas): diterima', r.status, 200);

  const r2 = await kirim({ nama: 'Penguji alasan', pilihan: 'A', alasan: alasan500 + 'z' });
  cek('alasan 501 code point: kode', r2.json?.kode, 'alasan-panjang');
}

const XSS = '<img src=x onerror=alert(1)>';
{
  const r = await kirim({ nama: 'Penguji xss', pilihan: 'B', alasan: XSS });
  cek('alasan berisi HTML: tersimpan verbatim', r.json?.suara?.alasan, XSS);
}

{
  /* Alasan itu teks bebas: baris baru harus BERTAHAN, tidak seperti di nama. */
  const r = await kirim({ nama: 'Penguji baris', pilihan: 'A', alasan: 'baris satu' + LF + 'baris dua' });
  cek('alasan: baris baru dipertahankan', r.json?.suara?.alasan, 'baris satu' + LF + 'baris dua');
}

/* --- 8. badan permintaan ---------------------------------------------- */

{
  const r = await minta('POST', '/api/suara', { badan: 'bukan json {{{', origin: ASAL_SAH });
  cek('badan rusak: status', r.status, 400);
  cek('badan rusak: kode', r.json?.kode, 'badan-rusak');
  /* Ini assertion yang mencegah error menjelma kegagalan CORS palsu: throw
     tanpa header mengembalikan 500 polos, browser melaporkan "blocked by CORS
     policy", dan penyebab sebenarnya jadi tak terlihat. */
  cek('badan rusak: ACAO TETAP terpasang', r.headers.get('access-control-allow-origin'), ASAL_SAH);
}

{
  const r = await minta('POST', '/api/suara', { badan: '[1,2,3]' });
  cek('badan berupa array JSON: kode', r.json?.kode, 'badan-rusak');
}

{
  const r = await minta('POST', '/api/suara', { badan: 'x'.repeat(5000) });
  cek('badan 5000 byte: kode', r.json?.kode, 'badan-rusak');
}

{
  const r = await kirim({ nama: 'Penguji json', pilihan: 'A' }, { tipe: 'application/json' });
  cek('Content-Type application/json juga dilayani', r.status, 200);
}

/* --- 9. rute dan metode ---------------------------------------------- */

{
  const r = await ambil('/api/tidak-ada');
  cek('rute tak dikenal: status', r.status, 404);
  cek('rute tak dikenal: kode', r.json?.kode, 'rute-tidak-ada');
}

{
  const r = await minta('POST', '/api/hasil', { badan: '{}' });
  cek('POST ke rute GET: status', r.status, 405);
  cek('POST ke rute GET: header Allow', r.headers.get('allow'), 'GET');
}

{
  const r = await ambil('/api/suara');
  cek('GET ke rute POST: status', r.status, 405);
}

/* --- 10. kebocoran kolom -------------------------------------------- */

{
  const r = await ambil('/api/hasil');
  const mentah = JSON.stringify(r.json);
  cekBenar('hasil: tidak memuat token_hash', !mentah.includes('token_hash'));
  cekBenar('hasil: tidak memuat sidik', !mentah.includes('sidik'));
  cekBenar('hasil: tidak memuat nama_norm', !mentah.includes('nama_norm'));
}

/* --- 11. riwayat append-only ---------------------------------------- */

{
  const h = await ambil('/api/hasil');
  const w = await ambil('/api/riwayat?batas=500');
  cekBenar(
    'riwayat: lebih panjang dari jumlah suara',
    w.json.riwayat.length > h.json.suara.length,
    `riwayat=${w.json.riwayat.length} suara=${h.json.suara.length}`
  );

  const ke = w.json.riwayat.map((r) => r.ke);
  const menurun = ke.every((v, i) => i === 0 || ke[i - 1] > v);
  cekBenar('riwayat: ke menurun ketat', menurun, JSON.stringify(ke.slice(0, 8)));

  cekBenar('riwayat: aksi selalu salah satu dari tiga', w.json.riwayat.every((r) => ['baru', 'ubah', 'hapus'].includes(r.aksi)));
  cekBenar('riwayat: sidik berupa 16 hex', w.json.riwayat.every((r) => /^[0-9a-f]{16}$/.test(r.sidik)));
}

{
  const r = await ambil('/api/riwayat?batas=99999');
  cek('riwayat: batas berlebih di-clamp, bukan 400', r.status, 200);
  cekBenar('riwayat: hasil clamp maksimal 500', r.json.riwayat.length <= 500);

  const r2 = await ambil('/api/riwayat?batas=0');
  cek('riwayat: batas 0 di-clamp, bukan 400', r2.status, 200);
}

/* --- 12. ekspor ----------------------------------------------------- */

{
  const r = await ambil('/api/ekspor');
  cek('ekspor: status', r.status, 200);
  cekBenar('ekspor: memuat suara dan suara_log', Array.isArray(r.json?.suara) && Array.isArray(r.json?.suara_log));
  cek('ekspor: no-store', r.headers.get('cache-control'), 'no-store');
}

/* --- 13. hitung ulang independen ------------------------------------ */

{
  /* Satu-satunya assertion di berkas ini yang bisa menangkap bug agregasi.
     Semua yang lain mempercayai aritmetika server; yang ini menghitung sendiri
     dari log mentah dengan normalizer yang ditulis terpisah di atas. */
  const w = await ambil('/api/riwayat?batas=500');
  const h = await ambil('/api/hasil');

  /* Log diurut ke DESC, jadi kemunculan PERTAMA sebuah nama adalah yang
     terbaru. Itulah suara yang berlaku (last write wins). */
  const terakhir = new Map();
  for (const baris of w.json.riwayat) {
    const kunci = normalkanUji(baris.nama).kunci;
    if (!terakhir.has(kunci)) terakhir.set(kunci, baris);
  }

  const hitungUji = { A: 0, B: 0 };
  for (const baris of terakhir.values()) {
    if (baris.aksi === 'hapus') continue;
    if (baris.pilihan === 'A' || baris.pilihan === 'B') hitungUji[baris.pilihan]++;
  }

  cek('hitung ulang mandiri cocok dengan server', hitungUji, h.json.hitung);
  cek('total mandiri cocok dengan server', hitungUji.A + hitungUji.B, h.json.total);
}

/* --- 14. urutan suara ----------------------------------------------- */

{
  const r = await ambil('/api/hasil');
  const waktu = r.json.suara.map((s) => new Date(s.diubah).getTime());
  cekBenar('hasil: suara urut diubah DESC', waktu.every((v, i) => i === 0 || waktu[i - 1] >= v));
}

/* --- 15. voting ditutup --------------------------------------------- */

if (BACKEND_PHP_LOKAL) {
  fs.rmSync(DB_TUTUP, { force: true });
  jalankanServer(PORT_TUTUP, DB_TUTUP, { VOTING_TUTUP: '1' });
  const dasarTutup = `http://127.0.0.1:${PORT_TUTUP}`;

  if (await tungguSiap(dasarTutup)) {
    const simpan = DASAR;
    DASAR = dasarTutup;

    const r = await kirim({ nama: 'Penguji tutup', pilihan: 'A' });
    /* 423 Locked, bukan 403: halaman harus bisa membedakan "voting ditutup"
       dari "permintaanmu ditolak". */
    cek('voting tutup: POST status 423', r.status, 423);
    cek('voting tutup: kode', r.json?.kode, 'voting-tutup');

    const g = await ambil('/api/hasil');
    cek('voting tutup: GET hasil tetap 200', g.status, 200);
    cek('voting tutup: field tutup true', g.json?.tutup, true);

    DASAR = simpan;
  } else {
    cekBenar('voting tutup: server kedua siap', false, 'tidak siap');
  }
}

/* ------------------------------------------------------------------ hasil --- */

console.log(`\n${lulus} lulus, ${gagal} gagal`);
bersihkan();
process.exit(gagal ? 1 : 0);
