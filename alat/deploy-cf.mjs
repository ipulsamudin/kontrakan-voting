/**
 * Men-deploy backend voting ke Cloudflare, satu perintah.
 *
 *   npm run deploy:cf
 *
 * SYARAT: `npx wrangler login` sudah dijalankan. Itu OAuth lewat browser dan
 * tidak bisa diotomatiskan; skrip ini berhenti dengan pesan jelas kalau belum.
 *
 * DUA JALUR, SATU PERINTAH
 *
 *   [1] Worker biasa -> alamat *.workers.dev
 *   [2] kalau akun belum punya subdomain workers.dev, skrip PINDAH SENDIRI ke
 *       Cloudflare Pages -> alamat *.pages.dev
 *
 * Jalur 2 bukan tambal sulam. Setiap proyek Pages mendapat subdomain
 * `pages.dev` miliknya sendiri tanpa klaim tingkat akun, dan Pages Functions
 * "advanced mode" menerima persis bentuk modul yang sudah kita punya:
 * `export default { fetch(request, env) }`.
 *
 * Karena itu worker/src/index.js TIDAK diubah sama sekali -- berkas yang sama
 * disalin apa adanya jadi _worker.js. Tidak ada backend kedua yang harus
 * dirawat, dan test-api.mjs tetap satu-satunya penentu kontraknya.
 *
 * Idempoten: basis data yang ada dipakai ulang, proyek Pages yang ada tidak
 * dibuat ganda, dan rahasia tidak diputar ulang kecuali memang aman.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AKAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KONFIG = 'worker/wrangler.toml';
const NAMA = 'kontrakan-voting';

const BERKAS_TOML = path.join(AKAR, 'worker', 'wrangler.toml');
const BERKAS_API = path.join(AKAR, 'data', 'api.json');
const BERKAS_SALT = path.join(AKAR, '.cf-ip-salt');

/* Semua milik Pages dikurung di satu folder.
   `wrangler pages deploy` MENOLAK --config dengan path kustom ("Pages does not
   support custom paths for the Wrangler configuration file"), jadi konfignya
   wajib bernama wrangler.toml dan berada di direktori kerja perintahnya.
   Memberinya folder sendiri membuat root repo tidak punya wrangler.toml kedua
   yang bisa tertukar dengan milik Worker. */
const DIR_PAGES = path.join(AKAR, 'pages');
const DIR_PAGES_OUT = path.join(DIR_PAGES, 'keluaran');
const BERKAS_PAGES_TOML = path.join(DIR_PAGES, 'wrangler.toml');
const SUMBER_WORKER = path.join(AKAR, 'worker', 'src', 'index.js');

/* ---------------------------------------------------------------- utilitas --- */

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
const bersih = (s) => String(s || '').replace(ANSI, '');

let langkah = 0;
const judul = (teks) => console.log(`\n[${++langkah}/9] ${teks}`);
const info = (teks) => console.log('      ' + teks);

function berhenti(pesan, saran) {
  console.error('\nGAGAL: ' + pesan);
  if (saran) console.error('\n' + saran);
  process.exit(1);
}

/**
 * shell:true karena di Windows `npx` itu npx.cmd dan bukan executable yang
 * bisa di-spawn langsung.
 */
function wrangler(args, { diam = false, cwd = AKAR } = {}) {
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keluaran = bersih(r.stdout) + bersih(r.stderr);
  if (!diam && keluaran.trim()) {
    console.log(
      keluaran
        .trim()
        .split('\n')
        .map((b) => '      | ' + b)
        .join('\n')
    );
  }
  return { kode: r.status, keluaran };
}

/** Mengambil JSON dari keluaran yang mungkin didahului banner wrangler. */
function petikJson(teks) {
  const mulai = teks.search(/[[{]/);
  if (mulai < 0) return null;
  for (let akhir = teks.length; akhir > mulai; akhir--) {
    try {
      return JSON.parse(teks.slice(mulai, akhir));
    } catch {
      /* coba potongan yang lebih pendek */
    }
  }
  return null;
}

/**
 * Memasang rahasia lewat berkas sementara DI LUAR repo, lalu menghapusnya.
 *
 * `secret bulk` dipilih karena menerima berkas; `secret put` tidak
 * mendokumentasikan pembacaan stdin.
 *
 * `argsAkhir` wajib memuat penunjuk sasaran (--config untuk Worker,
 * --project-name untuk Pages). Tanpa itu wrangler tidak tahu Worker mana yang
 * dimaksud dan gagal dengan "Required Worker name missing".
 */
function pasangRahasia(argsAwal, nilai, argsAkhir, cwd = AKAR) {
  const sementara = path.join(os.tmpdir(), `cf-secret-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(sementara, JSON.stringify({ IP_SALT: nilai }), 'utf8');
    return wrangler([...argsAwal, 'bulk', sementara, ...argsAkhir], { diam: true, cwd });
  } finally {
    fs.rmSync(sementara, { force: true });
  }
}

/* ------------------------------------------------------------------- 1 --- */

judul('Memeriksa autentikasi Cloudflare');
{
  const r = wrangler(['whoami'], { diam: true });
  if (r.kode !== 0 || /not authenticated/i.test(r.keluaran)) {
    berhenti(
      'belum terautentikasi ke Cloudflare.',
      'Jalankan dulu:\n\n    npx wrangler login\n\n' +
        'Itu membuka browser untuk persetujuan, dan hanya perlu sekali.\n' +
        'Belum punya akun? Daftar gratis tanpa kartu kredit di\n' +
        'https://dash.cloudflare.com/sign-up'
    );
  }
  const akun = /([^\s|]+@[^\s|]+)/.exec(r.keluaran);
  info('terautentikasi' + (akun ? ' sebagai ' + akun[1] : ''));
}

/* ------------------------------------------------------------------- 2 --- */

judul(`Memastikan basis data D1 "${NAMA}" ada`);

function cariDb() {
  /* d1 list dipakai, BUKAN keluaran d1 create: `d1 create` tidak punya --json,
     dan mem-parsing teks bebasnya rapuh. */
  const r = wrangler(['d1', 'list', '--json'], { diam: true });
  if (r.kode !== 0) return null;
  const daftar = petikJson(r.keluaran);
  if (!Array.isArray(daftar)) return null;
  return daftar.find((d) => d.name === NAMA) || null;
}

let db = cariDb();
if (db) {
  info('sudah ada, dipakai ulang');
} else {
  info('belum ada, membuat baru');
  const r = wrangler(['d1', 'create', NAMA], { diam: true });
  if (r.kode !== 0) berhenti('gagal membuat basis data D1.\n\n' + r.keluaran);
  db = cariDb();
  if (!db) berhenti('basis data dibuat tapi tidak muncul di d1 list.');
}

const idDb = db.uuid || db.database_id || db.id;
if (!idDb) berhenti('tidak menemukan database_id di keluaran d1 list.');
info('database_id: ' + idDb);

/* ------------------------------------------------------------------- 3 --- */

judul('Menulis database_id ke ' + KONFIG);
{
  const asli = fs.readFileSync(BERKAS_TOML, 'utf8');
  const baru = asli.replace(/^database_id\s*=\s*".*"$/m, `database_id = "${idDb}"`);
  if (baru === asli && !asli.includes(idDb)) {
    berhenti('tidak menemukan baris database_id untuk ditimpa di ' + KONFIG);
  }
  if (baru !== asli) {
    fs.writeFileSync(BERKAS_TOML, baru, 'utf8');
    info('diperbarui');
  } else {
    info('sudah benar, tidak diubah');
  }
}

/* ------------------------------------------------------------------- 4 --- */

judul('Menerapkan migrasi ke D1 remote');
{
  const r = wrangler(['d1', 'migrations', 'apply', NAMA, '--remote', '--config', KONFIG]);
  if (r.kode !== 0) berhenti('migrasi gagal diterapkan.');
}

/* ------------------------------------------------------------------- 5 --- */

judul('Menyiapkan rahasia IP_SALT');

/** Jumlah baris di suara_log remote. Dipakai untuk memutuskan apakah memutar
 *  salt masih aman: salt yang berganti membuat setiap `sidik` yang sudah
 *  terbit tidak lagi bisa dibandingkan dengan yang baru. */
function hitungLog() {
  const r = wrangler(
    ['d1', 'execute', NAMA, '--remote', '--config', KONFIG, '--command', '"SELECT COUNT(*) AS n FROM suara_log"'],
    { diam: true }
  );
  const cocok = /"n":\s*(\d+)/.exec(r.keluaran);
  return cocok ? Number(cocok[1]) : null;
}

/* Salt disimpan lokal supaya NILAINYA DIKETAHUI. Rahasia di Cloudflare hanya
   bisa ditulis, tidak bisa dibaca balik -- tanpa salinan lokal, Worker dan
   Pages tidak mungkin dibuat memakai salt yang sama, dan nilai `sidik` di
   keduanya jadi tidak bisa dibandingkan. Berkasnya di-gitignore. */
let salt;
if (fs.existsSync(BERKAS_SALT)) {
  salt = fs.readFileSync(BERKAS_SALT, 'utf8').trim();
  info('memakai salt lokal yang sudah ada');
} else {
  salt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(BERKAS_SALT, salt + '\n', 'utf8');
  info('salt baru dibuat (32 byte acak) dan disimpan di .cf-ip-salt');
}

{
  const ada = wrangler(['secret', 'list', '--config', KONFIG], { diam: true });
  const sudahAda = /IP_SALT/.test(ada.keluaran);

  if (!sudahAda) {
    const r = pasangRahasia(['secret'], salt, ['--config', KONFIG]);
    if (r.kode !== 0) berhenti('gagal memasang IP_SALT di Worker.\n\n' + r.keluaran);
    info('dipasang di Worker');
  } else {
    const n = hitungLog();
    if (n === 0) {
      /* Belum ada satu pun suara, jadi belum ada `sidik` yang bisa menjadi
         tidak cocok. Menyelaraskannya sekarang gratis, dan menjamin Worker
         dan Pages memakai salt yang sama. */
      const r = pasangRahasia(['secret'], salt, ['--config', KONFIG]);
      if (r.kode !== 0) berhenti('gagal menyelaraskan IP_SALT di Worker.\n\n' + r.keluaran);
      info('diselaraskan dengan .cf-ip-salt (aman: suara_log masih kosong)');
    } else {
      info(`sudah ada, TIDAK diputar ulang (suara_log sudah berisi ${n} baris)`);
    }
  }
}

/* ------------------------------------------------------------------- 6 --- */

judul('Men-deploy backend');
let alamat = null;
let lewatPages = false;

/** Menyalin blok [vars] dari wrangler.toml apa adanya.
 *  Diambil dari sumbernya, BUKAN diketik ulang: dua daftar origin yang bisa
 *  menyimpang diam-diam adalah persis jenis bug yang membuat CORS gagal di
 *  produksi saja, tempat yang paling mahal untuk menemukannya. */
function blokVars() {
  const toml = fs.readFileSync(BERKAS_TOML, 'utf8');
  const i = toml.indexOf('[vars]');
  if (i < 0) berhenti('tidak menemukan blok [vars] di ' + KONFIG);
  const sisa = toml.slice(i + '[vars]'.length);
  const berikut = /^\[/m.exec(sisa);
  return (berikut ? sisa.slice(0, berikut.index) : sisa).trimEnd();
}

function deployKePages() {
  info('');
  info('Akun ini belum punya subdomain workers.dev, jadi Worker-nya tidak bisa');
  info('diberi alamat publik. Pindah ke Cloudflare Pages, yang memberi setiap');
  info('proyek subdomain pages.dev sendiri tanpa klaim tingkat akun.');
  info('');

  /* 1. Keluaran build: Worker yang SAMA, disalin apa adanya. */
  fs.rmSync(DIR_PAGES_OUT, { recursive: true, force: true });
  fs.mkdirSync(DIR_PAGES_OUT, { recursive: true });
  fs.copyFileSync(SUMBER_WORKER, path.join(DIR_PAGES_OUT, '_worker.js'));
  fs.writeFileSync(
    path.join(DIR_PAGES_OUT, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>API voting</title>\n' +
      '<p>Ini endpoint API, bukan halaman voting. Halamannya ada di ' +
      '<a href="https://ipulsamudin.github.io/kontrakan-voting/">GitHub Pages</a>.\n',
    'utf8'
  );
  info('pages/keluaran/_worker.js disalin dari worker/src/index.js');

  /* 2. Konfigurasi Pages. `pages deploy` tidak punya flag --d1, jadi
        pengikatan basis data memang harus lewat berkas seperti ini. */
  fs.writeFileSync(
    BERKAS_PAGES_TOML,
    `# Konfigurasi Cloudflare Pages untuk backend voting.
#
# DIBUAT OTOMATIS oleh alat/deploy-cf.mjs. Jangan disunting dengan tangan --
# jalankan ulang \`npm run deploy:cf\` kalau perlu berubah.
#
# Berkas ini ada di folder sendiri, dan namanya wajib wrangler.toml, karena
# \`wrangler pages deploy\` menolak --config dengan path kustom. Menaruhnya di
# sini mencegah root repo punya wrangler.toml kedua yang bisa tertukar dengan
# milik Worker di worker/wrangler.toml.
#
# Blok [vars] DISALIN dari worker/wrangler.toml oleh skrip, bukan diketik
# ulang: dua daftar origin CORS yang bisa menyimpang diam-diam adalah persis
# jenis bug yang hanya muncul di produksi.
name = "${NAMA}"
pages_build_output_dir = "keluaran"
compatibility_date = "2026-10-01"

[[d1_databases]]
binding = "DB"
database_name = "${NAMA}"
database_id = "${idDb}"

[vars]${blokVars()}
`,
    'utf8'
  );
  info('pages/wrangler.toml ditulis');

  /* 3. Proyek Pages, dibuat hanya kalau belum ada. */
  const daftar = wrangler(['pages', 'project', 'list'], { diam: true });
  if (new RegExp('\\b' + NAMA + '\\b').test(daftar.keluaran)) {
    info('proyek Pages sudah ada, dipakai ulang');
  } else {
    /* --force diperlukan HANYA saat pembuatan.
     *
     * wrangler 4.x mendelegasikan `pages project create` ke Cloudflare Workers
     * ("Pages is now part of Workers"), dan delegasi itu gagal di sini karena
     * yang kita mau justru proyek Pages dengan subdomain pages.dev sendiri --
     * bukan Worker yang balik lagi membutuhkan subdomain workers.dev yang
     * belum ada. --force melewati delegasi itu.
     *
     * wrangler sendiri yang menyatakan ini sekali pakai: begitu proyeknya ada,
     * `pages secret` dan `pages deploy` berjalan langsung ke Pages tanpa
     * delegasi, jadi keduanya TIDAK memakai --force. */
    const r = wrangler(
      ['pages', 'project', 'create', NAMA, '--production-branch', 'main', '--force'],
      { diam: true }
    );
    if (r.kode !== 0) berhenti('gagal membuat proyek Pages.\n\n' + r.keluaran);
    info('proyek Pages dibuat (--force, melewati delegasi ke Workers)');
  }

  /* 4. Salt yang SAMA dengan Worker. */
  {
    const r = pasangRahasia(['pages', 'secret'], salt, ['--project-name', NAMA]);
    if (r.kode !== 0) berhenti('gagal memasang IP_SALT di Pages.\n\n' + r.keluaran);
    info('IP_SALT dipasang di Pages (nilai sama dengan Worker)');
  }

  /* 5. Deploy, dijalankan DARI folder pages/ supaya wrangler menemukan
        wrangler.toml-nya di direktori kerja. */
  const r = wrangler(['pages', 'deploy', '--branch', 'main', '--commit-dirty', 'true'], {
    cwd: DIR_PAGES,
  });
  if (r.kode !== 0) berhenti('deploy ke Pages gagal.');

  /* Alamat produksi yang stabil, bukan URL per-deployment yang berawalan hash.
     Kalau ternyata keliru, langkah 7 yang akan menangkapnya. */
  const dariKeluaran = /https:\/\/[^\s"']+\.pages\.dev/.exec(r.keluaran);
  if (dariKeluaran) info('deployment: ' + dariKeluaran[0]);
  return `https://${NAMA}.pages.dev`;
}

{
  const r = wrangler(['deploy', '--config', KONFIG]);
  if (r.kode === 0) {
    const cocok = /https:\/\/[^\s"']+\.workers\.dev/.exec(r.keluaran);
    if (!cocok) berhenti('deploy berhasil tapi alamat workers.dev tidak ditemukan di keluarannya.');
    alamat = cocok[0].replace(/\/+$/, '');
    info('alamat: ' + alamat);
  } else if (/subdomain/i.test(r.keluaran)) {
    lewatPages = true;
    alamat = deployKePages();
    info('alamat: ' + alamat);
  } else {
    berhenti('deploy gagal.', 'Baca keluaran di atas untuk penyebabnya, lalu jalankan ulang.');
  }
}

/* ------------------------------------------------------------------- 7 --- */

judul('Memverifikasi alamatnya sungguhan');
{
  /* Ini yang menjaga langkah 6. Kalau pengambilan alamat meleset, pemeriksaan
     ini gagal berisik -- alih-alih menulis alamat yang salah ke data/api.json
     dan baru ketahuan saat ada orang mencoba memilih. */
  let akhir = null;
  for (let coba = 1; coba <= 8; coba++) {
    try {
      const res = await fetch(alamat + '/api/hasil', { signal: AbortSignal.timeout(10000) });
      const j = await res.json();
      if (res.ok && j && j.ok === true && j.hitung && typeof j.hitung.A === 'number') {
        info(`balasan sah: total ${j.total}, hitung A=${j.hitung.A} B=${j.hitung.B}`);
        akhir = j;
        break;
      }
      akhir = new Error('balasan tidak sesuai kontrak: ' + JSON.stringify(j).slice(0, 200));
    } catch (e) {
      akhir = e;
    }
    if (coba < 8) {
      info(`belum siap (percobaan ${coba}/8), menunggu 5 detik`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!akhir || akhir instanceof Error) {
    berhenti(
      'backend ter-deploy tapi /api/hasil tidak membalas dengan benar.\n' +
        (akhir ? String(akhir.message) : ''),
      lewatPages
        ? 'Coba `npx wrangler pages deployment tail --project-name ' + NAMA + '`.'
        : 'Coba `npx wrangler tail --config ' + KONFIG + '`.'
    );
  }
}

/* ------------------------------------------------------------------- 8 --- */

judul('Menulis alamat ke data/api.json');
{
  const d = JSON.parse(fs.readFileSync(BERKAS_API, 'utf8'));
  if (d.dasar === alamat) {
    info('sudah benar, tidak diubah');
  } else {
    d.dasar = alamat;
    fs.writeFileSync(BERKAS_API, JSON.stringify(d, null, 2) + '\n', 'utf8');
    info('diperbarui');
  }
}

/* ------------------------------------------------------------------- 9 --- */

judul('Selesai');
console.log(`
Backend hidup di  ${alamat}
Jalur             ${lewatPages ? 'Cloudflare Pages (tanpa subdomain workers.dev)' : 'Cloudflare Workers'}
Basis data D1     ${NAMA} (${idDb})

Langkah berikutnya, supaya halaman publiknya ikut memakai alamat ini:

    git add data/api.json worker/wrangler.toml${lewatPages ? ' pages/wrangler.toml' : ''}
    git commit -m "feat: hidupkan voting"
    git push

Workflow "Terbitkan" akan men-deploy ulang GitHub Pages, dan voting hidup di
https://ipulsamudin.github.io/kontrakan-voting/ tanpa laptop ini menyala.
${
  lewatPages
    ? `
Kalau suatu saat Anda mengklaim subdomain workers.dev, jalankan ulang perintah
ini dan jalur Workers akan dipakai lagi. Proyek Pages boleh dihapus lewat
dashboard. IP_SALT dipasang sama di kedua tempat, jadi nilai sidik tetap
konsisten dan riwayat tetap bisa dibandingkan.
`
    : ''
}`);
