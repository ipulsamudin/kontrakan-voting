/**
 * Men-deploy Worker + D1 ke Cloudflare, satu perintah.
 *
 *   npm run deploy:cf
 *
 * Urutan manualnya ada enam langkah, dan salah satunya menempelkan
 * `database_id` dengan tangan ke worker/wrangler.toml -- persis jenis langkah
 * yang mudah salah dan sulit dilacak kalau salah. Skrip ini mengerjakan
 * semuanya, idempoten, dan aman dijalankan ulang.
 *
 * SYARAT: `npx wrangler login` sudah dijalankan. Itu OAuth lewat browser dan
 * tidak bisa diotomatiskan; skrip ini berhenti dengan pesan jelas kalau belum.
 *
 * Yang dikerjakan:
 *   1. periksa autentikasi
 *   2. pastikan basis data D1 `kontrakan-voting` ada
 *   3. tulis database_id ke worker/wrangler.toml
 *   4. terapkan migrasi ke D1 remote
 *   5. pasang rahasia IP_SALT (hanya kalau belum ada -- JANGAN diputar ulang)
 *   6. deploy Worker
 *   7. VERIFIKASI alamatnya sungguhan dengan memanggil /api/hasil
 *   8. tulis alamat itu ke data/api.json
 *   9. cetak langkah berikutnya
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AKAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KONFIG = 'worker/wrangler.toml';
const NAMA_DB = 'kontrakan-voting';
const BERKAS_TOML = path.join(AKAR, 'worker', 'wrangler.toml');
const BERKAS_API = path.join(AKAR, 'data', 'api.json');

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
function wrangler(args, { diam = false } = {}) {
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: AKAR,
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

judul(`Memastikan basis data D1 "${NAMA_DB}" ada`);

function cariDb() {
  /* d1 list dipakai, BUKAN keluaran d1 create: `d1 create` tidak punya --json,
     dan mem-parsing teks bebasnya rapuh. */
  const r = wrangler(['d1', 'list', '--json'], { diam: true });
  if (r.kode !== 0) return null;
  const daftar = petikJson(r.keluaran);
  if (!Array.isArray(daftar)) return null;
  return daftar.find((d) => d.name === NAMA_DB) || null;
}

let db = cariDb();
if (db) {
  info('sudah ada, dipakai ulang');
} else {
  info('belum ada, membuat baru');
  const r = wrangler(['d1', 'create', NAMA_DB], { diam: true });
  if (r.kode !== 0) {
    berhenti('gagal membuat basis data D1.\n\n' + r.keluaran);
  }
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
  const r = wrangler(['d1', 'migrations', 'apply', NAMA_DB, '--remote', '--config', KONFIG]);
  if (r.kode !== 0) berhenti('migrasi gagal diterapkan.');
}

/* ------------------------------------------------------------------- 5 --- */

judul('Memasang rahasia IP_SALT');
{
  const ada = wrangler(['secret', 'list', '--config', KONFIG], { diam: true });
  const sudahAda = /IP_SALT/.test(ada.keluaran);

  if (sudahAda) {
    /* JANGAN diputar ulang. Mengganti salt membuat setiap `sidik` yang sudah
       diterbitkan tidak lagi cocok dengan yang baru, sehingga riwayat jadi
       tidak bisa dibandingkan antar-periode. */
    info('sudah ada, sengaja TIDAK diputar ulang');
  } else {
    const salt = crypto.randomBytes(32).toString('hex');
    /* Ditulis ke direktori sementara DI LUAR repo, lalu dihapus.
       `secret bulk` dipilih karena menerima berkas; `secret put` tidak
       mendokumentasikan pembacaan stdin. */
    const sementara = path.join(os.tmpdir(), `cf-secret-${process.pid}.json`);
    try {
      fs.writeFileSync(sementara, JSON.stringify({ IP_SALT: salt }), 'utf8');
      const r = wrangler(['secret', 'bulk', sementara, '--config', KONFIG], { diam: true });
      if (r.kode !== 0) berhenti('gagal memasang IP_SALT.\n\n' + r.keluaran);
      info('dibuat dan dipasang (32 byte acak)');
    } finally {
      fs.rmSync(sementara, { force: true });
    }
  }
}

/* ------------------------------------------------------------------- 6 --- */

judul('Men-deploy Worker');
let alamat = null;
{
  const r = wrangler(['deploy', '--config', KONFIG]);
  if (r.kode !== 0) {
    const butuhSubdomain = /subdomain/i.test(r.keluaran);
    berhenti(
      'deploy gagal.',
      butuhSubdomain
        ? 'Sepertinya akun ini belum punya subdomain workers.dev.\n' +
            'Buka https://dash.cloudflare.com -> Workers & Pages -> Overview,\n' +
            'klaim subdomain sekali, lalu jalankan ulang perintah ini.'
        : 'Baca keluaran di atas untuk penyebabnya, lalu jalankan ulang.'
    );
  }
  const cocok = /https:\/\/[^\s"']+\.workers\.dev/.exec(r.keluaran);
  if (!cocok) berhenti('deploy berhasil tapi alamat workers.dev tidak ditemukan di keluarannya.');
  alamat = cocok[0].replace(/\/+$/, '');
  info('alamat: ' + alamat);
}

/* ------------------------------------------------------------------- 7 --- */

judul('Memverifikasi alamatnya sungguhan');
{
  /* Ini yang menjaga langkah 6. Kalau pengambilan alamat dari keluaran deploy
     meleset, pemeriksaan ini gagal berisik -- alih-alih menulis alamat yang
     salah ke data/api.json dan baru ketahuan saat ada orang mencoba memilih. */
  let akhir = null;
  for (let coba = 1; coba <= 6; coba++) {
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
    if (coba < 6) {
      info(`belum siap (percobaan ${coba}/6), menunggu 5 detik`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!akhir || akhir instanceof Error) {
    berhenti(
      'Worker ter-deploy tapi /api/hasil tidak membalas dengan benar.\n' +
        (akhir ? String(akhir.message) : ''),
      'Coba `npx wrangler tail --config ' + KONFIG + '` untuk melihat lognya.'
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
Worker hidup di   ${alamat}
Basis data D1     ${NAMA_DB} (${idDb})

Langkah berikutnya, supaya halaman publiknya ikut memakai alamat ini:

    git add data/api.json worker/wrangler.toml
    git commit -m "feat: hidupkan voting lewat Worker + D1"
    git push

Workflow "Terbitkan" akan men-deploy ulang GitHub Pages, dan voting hidup di
https://ipulsamudin.github.io/kontrakan-voting/ tanpa laptop ini menyala.
`);
