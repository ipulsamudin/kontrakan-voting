/**
 * Uji UI di browser sungguhan.
 *
 *   node test-ui.mjs                        halaman dilayani server bawaan tes,
 *                                           backend PHP ikut dijalankan
 *   node test-ui.mjs --tanpa-api            hanya jalur cuplikan (tanpa backend)
 *   node test-ui.mjs --situs https://...    uji situs yang sudah live
 *
 * Playwright diambil dari node_modules dan memakai Chrome yang sudah terinstal
 * (channel: 'chrome'), jadi tidak ada unduhan browser 150 MB.
 *
 * Tes ini membawa server statis `node:http` sendiri dan TIDAK bergantung pada
 * Apache/XAMPP, supaya bisa dijalankan di mesin mana pun tanpa menyalakan apa
 * pun lebih dulu.
 *
 * Prinsip yang diwarisi project induk: angka yang diharapkan DIHITUNG ULANG di
 * dalam tes ini dari data/matrix.json dengan parser terpisah -- bukan diambil
 * dari kode halaman -- supaya bug parser di UI tidak bisa membenarkan dirinya
 * sendiri.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* playwright-core itu modul CommonJS, jadi diimpor lewat default export. */
import playwright from './node_modules/playwright-core/index.js';
const { chromium } = playwright;

const AKAR = path.dirname(fileURLToPath(import.meta.url));
const DIR_SHOT = path.join(AKAR, 'screenshot');

const arg = process.argv.slice(2);
const TANPA_API = arg.includes('--tanpa-api');

/* --relatif menguji susunan SATU ORIGIN: halaman dan backend dilayani dari
   origin yang sama, dengan data/api.json berisi alamat relatif.
   Itulah satu-satunya susunan yang bekerja tanpa akun Cloudflare, karena
   Chrome memblokir permintaan dari origin publik HTTPS ke loopback lewat
   Private Network Access. Diuji, bukan cuma ditulis di README. */
const RELATIF = arg.includes('--relatif');
const iSitus = arg.indexOf('--situs');
const SITUS_LUAR = iSitus >= 0 ? arg[iSitus + 1] : null;

const PORT_WEB = 8795;
const PORT_API = 8796;
const DB_UJI = path.join(os.tmpdir(), `voting-ui-${process.pid}.sqlite`);

/* ----------------------------------------- ekspektasi dari matrix.json --- */

/**
 * Parser KEDUA untuk data/matrix.json, ditulis terpisah dari index.html.
 * Kalau regex harga atau pembagian jarak di halaman salah, nilai di sini tidak
 * ikut salah, dan assertion-nya gagal.
 */
const matrix = JSON.parse(fs.readFileSync(path.join(AKAR, 'data/matrix.json'), 'utf8'));
const video = JSON.parse(fs.readFileSync(path.join(AKAR, 'data/video.json'), 'utf8'));

const satuDesimal = (n) =>
  n.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const harap = video.video.map((v) => {
  const i = v.matrix_index;
  const nama = matrix.names[i];
  const cocok = /\((\d+)\)\s*$/.exec(nama);

  return {
    id: v.id,
    berkas: v.berkas,
    lebar: v.lebar,
    tinggi: v.tinggi,
    harga: cocok ? Number(cocok[1]) : null,
    /* Judul diturunkan dengan cara sendiri: buang prefiks huruf+spasi di depan
       dan kurung di belakang. */
    judul: nama.replace(/^[A-Z]\s+/, '').replace(/\s*\(\S*\)\s*$/, '').trim(),
    km: satuDesimal(matrix.dist[matrix.rumah_index ?? 0][i] / 1000),
    menit: satuDesimal(matrix.dur[matrix.rumah_index ?? 0][i] / 60),
  };
});

/* ------------------------------------------------------------- kerangka --- */

let lulus = 0;
let gagal = 0;

function cek(nama, aktual, diharap) {
  const ok = JSON.stringify(aktual) === JSON.stringify(diharap);
  const ekor = ok ? JSON.stringify(aktual) : `dapat ${JSON.stringify(aktual)}, harap ${JSON.stringify(diharap)}`;
  console.log(`${ok ? 'OK   ' : 'GAGAL'} ${nama.padEnd(52)} ${ekor}`);
  if (ok) lulus++;
  else gagal++;
}

function cekBenar(nama, kondisi, info = '') {
  console.log(`${kondisi ? 'OK   ' : 'GAGAL'} ${nama.padEnd(52)} ${kondisi ? '' : info}`);
  if (kondisi) lulus++;
  else gagal++;
}

/**
 * Menunggu KONDISI, bukan menunggu sekian milidetik.
 *
 * Tidur dengan angka tetap adalah sumber flaky yang paling licik di berkas
 * ini: angka yang cukup untuk server lokal terlalu pendek untuk jaringan
 * sungguhan, dan gejalanya bukan "timeout" melainkan assertion yang gagal
 * dengan nilai keadaan AWAL -- seolah fiturnya rusak, padahal halamannya cuma
 * belum selesai.
 *
 * Mengembalikan true/false alih-alih melempar, supaya kegagalannya dilaporkan
 * sebagai baris GAGAL yang bisa dibaca, bukan jejak tumpukan yang menghentikan
 * seluruh berkas.
 */
async function tunggu(halaman, fn, { batas = SITUS_LUAR ? 30000 : 10000 } = {}) {
  try {
    await halaman.waitForFunction(fn, null, { timeout: batas });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------- server statis --- */

const TIPE = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

const PREFIKS_API = '/lokal/api.php';

function layaniStatis(port) {
  const srv = http.createServer(async (req, res) => {
    const alamat = new URL(req.url, 'http://x');
    let jalur = decodeURIComponent(alamat.pathname);

    /* Mode --relatif: teruskan /lokal/api.php/* ke backend PHP, supaya
       halaman dan API benar-benar satu origin seperti di XAMPP. */
    if (RELATIF && jalur.startsWith(PREFIKS_API)) {
      const sisa = jalur.slice(PREFIKS_API.length) || '/';
      const tujuan = `http://127.0.0.1:${PORT_API}${sisa}${alamat.search}`;
      try {
        const badan = ['GET', 'HEAD'].includes(req.method)
          ? undefined
          : await new Promise((selesai) => {
              const potongan = [];
              req.on('data', (c) => potongan.push(c));
              req.on('end', () => selesai(Buffer.concat(potongan)));
            });

        const hulu = await fetch(tujuan, {
          method: req.method,
          headers: { 'Content-Type': req.headers['content-type'] || 'text/plain' },
          body: badan,
        });
        const teks = await hulu.text();
        res.writeHead(hulu.status, {
          'Content-Type': hulu.headers.get('content-type') || 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(teks);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, kode: 'proxy-gagal', pesan: String(e.message) }));
      }
      return;
    }

    /* data/api.json ditimpa supaya setiap mode benar-benar berarti apa yang
       namanya janjikan.

       Ini bukan kenyamanan: berkas yang ter-commit menunjuk backend PRODUKSI,
       karena memang itu yang dibutuhkan GitHub Pages. Tanpa penimpaan di
       sini, mode --tanpa-api tetap memanggil produksi, ditolak CORS karena
       origin server uji tidak ada di allowlist produksi, lalu melaporkan
       "tidak bisa dihubungi" -- padahal yang sedang diuji adalah keadaan
       "belum ada alamat sama sekali". Dan menambahkan port server uji ke
       allowlist PRODUKSI demi menyenangkan tes jelas bukan jawabannya. */
    if (jalur === '/data/api.json' && (RELATIF || TANPA_API)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ dasar: RELATIF ? 'lokal/api.php' : null }));
      return;
    }

    if (jalur === '/' || jalur === '') jalur = '/index.html';

    const berkas = path.join(AKAR, jalur);
    /* Jangan izinkan keluar dari folder project. */
    if (!berkas.startsWith(AKAR)) {
      res.writeHead(403).end('terlarang');
      return;
    }

    fs.readFile(berkas, (err, isi) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('tidak ada');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TIPE[path.extname(berkas).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      res.end(isi);
    });
  });
  return new Promise((selesai) => srv.listen(port, '127.0.0.1', () => selesai(srv)));
}

/* ---------------------------------------------------------------- proses --- */

const anak = [];
let srvWeb = null;

async function tungguApi(dasar, batasMs = 15000) {
  const mulai = Date.now();
  while (Date.now() - mulai < batasMs) {
    try {
      if ((await fetch(dasar + '/api/hasil')).ok) return true;
    } catch {
      /* belum siap */
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
  if (srvWeb) {
    try {
      srvWeb.close();
    } catch {
      /* sudah tutup */
    }
  }
  try {
    fs.rmSync(DB_UJI, { force: true });
  } catch {
    /* biarkan */
  }
}

process.on('exit', bersihkan);

/* ------------------------------------------------------------------ jalan --- */

fs.mkdirSync(DIR_SHOT, { recursive: true });

let URL_SITUS = SITUS_LUAR;
let dasarApi = null;

if (!SITUS_LUAR) {
  srvWeb = await layaniStatis(PORT_WEB);
  URL_SITUS = `http://127.0.0.1:${PORT_WEB}/`;

  if (!TANPA_API) {
    fs.rmSync(DB_UJI, { force: true });
    anak.push(
      spawn('php', ['-S', `127.0.0.1:${PORT_API}`, 'lokal/api.php'], {
        cwd: AKAR,
        env: {
          ...process.env,
          VOTING_DB: DB_UJI,
          IP_SALT: 'salt-uji-ui',
          /* Origin server statis tes ini HARUS didaftarkan, kalau tidak
             respons API datang tanpa header CORS, browser memblokirnya, dan
             halaman jatuh ke jalur cuplikan -- yang membuat seluruh blok uji
             pengiriman suara gagal dengan alasan yang menyesatkan. */
          ASAL_DIIZINKAN: `http://127.0.0.1:${PORT_WEB}`,
        },
        stdio: 'ignore',
      })
    );
    dasarApi = `http://127.0.0.1:${PORT_API}`;
    if (!(await tungguApi(dasarApi))) {
      console.error('GAGAL: backend php tidak siap');
      process.exit(1);
    }
  }
}

/**
 * Di mode --situs, situsnya sendiri yang menentukan punya backend atau tidak,
 * lewat data/api.json miliknya -- bukan backend milik tes ini.
 *
 * Tanpa pembedaan ini, seluruh blok "belum aktif" di bawah berubah merah tepat
 * ketika Worker berhasil di-deploy: tes melaporkan kegagalan padahal yang
 * terjadi justru keberhasilan, dan itu mode gagal yang paling membingungkan.
 */
let dasarSitus = null;
if (SITUS_LUAR) {
  try {
    const res = await fetch(new URL('data/api.json?_=' + Date.now(), URL_SITUS).href, {
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    dasarSitus = j && j.dasar ? String(j.dasar) : null;
  } catch (e) {
    console.error('Peringatan: data/api.json situs tidak terbaca:', e.message);
  }
}

/**
 * Apakah HALAMAN yang diuji akan punya alamat API, dari sumber mana pun.
 *
 * Dipakai untuk memilih kalimat mana yang diharapkan, bukan untuk memutuskan
 * assertion mana yang dilewati -- keduanya tetap dijalankan, yang berbeda
 * hanya yang dianggap benar.
 *
 * Urutannya mengikuti urutan di halaman: ?api= menang atas data/api.json.
 */
const halamanPunyaApi = RELATIF
  ? true
  : TANPA_API
    ? false
    : Boolean(dasarApi || dasarSitus);

/* ?api= dipakai untuk mengarahkan halaman ke backend uji, dan sekaligus
   menguji jalur override itu sendiri. 127.0.0.1 ada di allowlist halaman. */
const URL_UJI =
  dasarApi && !RELATIF ? `${URL_SITUS}?api=${encodeURIComponent(dasarApi)}` : URL_SITUS;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID' });
const page = await ctx.newPage();

const masalah = [];

/* Blok "backend mati" di bawah memblokir /api/** dengan sengaja, dan request
   yang di-abort memang memunculkan error console. Error itu konsekuensi
   tesnya sendiri, bukan cacat halaman, jadi pengumpulannya dijeda selama blok
   itu berjalan. Menyaring berdasarkan teks pesan akan lebih rapuh: ia juga
   akan menyembunyikan kegagalan jaringan sungguhan di bagian lain. */
let abaikanGalat = false;

page.on('console', (m) => {
  if (m.type() === 'error' && !abaikanGalat) masalah.push('console: ' + m.text());
});
page.on('pageerror', (e) => {
  if (!abaikanGalat) masalah.push('pageerror: ' + e.message);
});

const n = (s) => page.locator(s).count();

console.log(`Membuka ${URL_UJI}`);
if (SITUS_LUAR) {
  console.log(
    dasarSitus
      ? `Situs ini SUDAH punya backend: ${dasarSitus}`
      : 'Situs ini BELUM punya backend (data/api.json dasar = null)'
  );
}
console.log(`Ekspektasi dihitung dari data/matrix.json: ${JSON.stringify(harap)}\n`);

await page.goto(URL_UJI, { waitUntil: 'load', timeout: 30000 });
await page.waitForSelector('article.card', { timeout: 15000 });
await page.waitForTimeout(400);

/* --- 1. kartu video dan angka turunannya ------------------------------- */

cek('dua kartu kandidat dirender', await n('article.card[data-kandidat]'), 2);
cek('dua elemen video', await n('video.klip'), 2);

if (RELATIF) {
  /* Susunan satu origin: tidak ada ?api=, alamatnya relatif dari api.json,
     dan footer harus menyebut "halaman ini" bukan melempar karena
     new URL() pada alamat relatif. */
  const ringkasAwal = await page.locator('#ringkas').innerText();
  cekBenar('satu origin: API tersambung tanpa ?api=', ringkasAwal.includes('Hasil langsung'), ringkasAwal);
  cek('satu origin: tombol kirim aktif', await page.locator('#btn-kirim').isDisabled(), false);

  const catatan = await page.locator('#catatan-api').innerText();
  cekBenar('satu origin: footer menyebut halaman ini', catatan.includes('halaman ini'), catatan);
  cekBenar('satu origin: tidak disebut dari parameter ?api=', !catatan.includes('?api='), catatan);
}

if (SITUS_LUAR) {
  /* Tunggu sampai ringkasan benar-benar terisi. Di jaringan sungguhan,
     memeriksa terlalu cepat berarti membaca keadaan kosong dan menyalahkan
     halaman atas keterlambatan jaringan. */
  const terisi = await tunggu(page, () => {
    const r = document.getElementById('ringkas');
    return r && r.textContent.trim().length > 0;
  });
  cekBenar('situs live: ringkasan terisi dalam batas waktu', terisi);

  const ringkasAwal = await page.locator('#ringkas').innerText();
  const notaTampak = (await n('#alasan-mati.show')) === 1;
  const notaTeks = await page.locator('#alasan-mati').innerText();
  const kirimMati = await page.locator('#btn-kirim').isDisabled();

  if (dasarSitus) {
    cekBenar('situs live: tersambung ke backend', ringkasAwal.includes('Hasil langsung'), ringkasAwal);
    cek('situs live: tombol kirim aktif', kirimMati, false);
    /* Catatan alasan HARUS hilang saat tombolnya bisa dipakai. Diperiksa dua
       arah, supaya catatan yang tidak pernah hilang tidak lolos sebagai lulus. */
    cek('situs live: catatan alasan tidak tampil', notaTampak, false);
  } else {
    cekBenar('situs live: menampilkan cuplikan', ringkasAwal.includes('Cuplikan'), ringkasAwal);
    cek('situs live: tombol kirim disabled', kirimMati, true);
    cekBenar('situs live: catatan alasan tampil di sebelah tombol', notaTampak, notaTeks);
    cekBenar('situs live: catatan menyebut belum aktif', /belum aktif/i.test(notaTeks), notaTeks);
  }

  /* Memilih dari UI akan mencemari hasil yang sedang dipakai orang mengambil
     keputusan, jadi tes ini TIDAK pernah mengirim suara ke situs live.
     Satu-suara-per-nama di deployment nyata dibuktikan terpisah lewat urutan
     curl berprefiks uji- yang dibersihkan setelahnya. */
}

if (dasarApi && !RELATIF) {
  /* Diperiksa SEGERA dan secara eksplisit. Kalau CORS tidak terpasang,
     halaman diam-diam jatuh ke cuplikan statis dan tombol kirim jadi
     disabled -- lalu seluruh blok uji di bawah gagal karena timeout klik,
     yang sama sekali tidak menyebut CORS. Assertion ini membuat penyebabnya
     terbaca di baris pertama yang gagal. */
  const ringkasAwal = await page.locator('#ringkas').innerText();
  cekBenar(
    'API tersambung (CORS lolos, bukan jatuh ke cuplikan)',
    ringkasAwal.includes('Hasil langsung'),
    ringkasAwal
  );
  cek('tombol kirim aktif', await page.locator('#btn-kirim').isDisabled(), false);
  cek('catatan alasan tidak tampil saat tombol aktif', await n('#alasan-mati.show'), 0);
}

for (const h of harap) {
  const kartu = `article.card[data-kandidat="${h.id}"]`;
  const teks = await page.locator(kartu).innerText();

  cekBenar(`kartu ${h.id}: judul "${h.judul}"`, teks.includes(h.judul), teks.slice(0, 80));

  /* Harga: 850 -> "Rp 850rb". Dibandingkan dengan nilai yang diparse ulang
     di tes ini dari names matrix.json, bukan dari kode halaman. */
  const hargaTeks = 'Rp ' + h.harga.toLocaleString('id-ID') + 'rb';
  cekBenar(`kartu ${h.id}: harga ${hargaTeks}`, teks.includes(hargaTeks), teks.slice(0, 120));

  cekBenar(`kartu ${h.id}: jarak ${h.km} km`, teks.includes(h.km + ' km'), teks.slice(0, 160));

  /* Ini assertion yang menangkap pembulatan ke menit bulat. 423,9 dan 447,4
     detik sama-sama membulat ke 7, sehingga kedua kandidat tampak identik.
     Nilai yang benar adalah 7,1 dan 7,5. */
  cekBenar(`kartu ${h.id}: waktu tempuh ${h.menit} menit`, teks.includes(h.menit + ' menit'), teks.slice(0, 200));
}

/* --- 1b. deskripsi hasil scraping ------------------------------------- */

{
  /* Deskripsi datang dari postingan Facebook/TikTok lewat
     alat/ambil-deskripsi.mjs. Dua hal yang diperiksa di sini, dan keduanya
     penting karena repo ini PUBLIK:
       1. kalau status_ambil "berhasil", teksnya benar-benar sampai ke layar
       2. tidak ada nomor telepon orang ketiga yang ikut tayang
     Pemeriksaan kedua itu yang menahan regresi kalau suatu saat penyensoran
     di alat pengambil dilepas tanpa sengaja. */
  const POLA_NOMOR = /(?:\+?62|0)[ .-]?8\d{1,2}[ .-]?\d{3,4}[ .-]?\d{3,5}/;

  for (const v of video.video) {
    const kartu = `article.card[data-kandidat="${v.id}"]`;
    const teks = await page.locator(kartu).innerText();

    if (v.status_ambil === 'berhasil' || v.status_ambil === 'manual') {
      const cuplikan = v.deskripsi.split('\n')[0].slice(0, 40);
      cekBenar(`kartu ${v.id}: deskripsi tampil`, teks.includes(cuplikan), cuplikan);
    } else {
      cekBenar(
        `kartu ${v.id}: ada penjelasan pengganti saat deskripsi kosong`,
        teks.includes('postingan'),
        teks.slice(0, 120)
      );
    }

    cekBenar(
      `kartu ${v.id}: tidak ada nomor telepon di layar`,
      !POLA_NOMOR.test(teks),
      (teks.match(POLA_NOMOR) || [''])[0]
    );
  }

  /* Tombol ke postingan asli harus selalu ada: di situlah detail lengkap,
     termasuk nomor yang sengaja tidak diterbitkan ulang di sini. */
  cek('dua tautan ke postingan asli', await n('article.card .actions a.btn'), 2);
}

/* --- 1b2. kerapihan deskripsi ----------------------------------------- */

{
  /* Caption TikTok datang dari sumbernya sebagai SATU baris raksasa tanpa
     pemisah apa pun. alat/rapikan-deskripsi.mjs memecahnya; assertion di sini
     menahan supaya kerapihan itu tidak hilang diam-diam kalau alat itu diubah
     atau datanya di-scrape ulang dengan versi lama.

     Polanya ditulis ulang di sini, bukan diimpor dari alat itu, mengikuti
     prinsip yang sama dengan parser matrix.json: alat yang diuji tidak boleh
     jadi satu-satunya penentu benar-tidaknya hasilnya sendiri. */

  /* Emoji yang SAMA berulang tiga kali atau lebih: itu persis bentuk garis
     hias di postingan aslinya. Memakai backreference, bukan "dua emoji
     berdampingan", supaya emoji ZWJ yang sah seperti juru masak berkulit
     terang tidak ikut tertuduh. */
  const DERET_HIAS = /(\p{Extended_Pictographic})\1{2,}/u;
  const BARIS_TAGAR = /^#\S+(?:\s+#\S+)*$/;
  const PENANDA_SENSOR = /\[nomor[^\]]*\]/g;

  for (const v of video.video) {
    if (v.status_ambil !== 'berhasil' && v.status_ambil !== 'manual') continue;

    const baris = v.deskripsi.split('\n').map((b) => b.trim());

    cekBenar(`deskripsi ${v.id}: terpecah jadi beberapa baris`, baris.length >= 5, `${baris.length} baris`);

    cekBenar(
      `deskripsi ${v.id}: tidak ada deretan emoji hias`,
      !DERET_HIAS.test(v.deskripsi),
      (v.deskripsi.match(new RegExp(DERET_HIAS.source, 'gu')) || [])[0] || ''
    );

    cekBenar(
      `deskripsi ${v.id}: tidak ada baris tagar`,
      !baris.some((b) => BARIS_TAGAR.test(b)),
      baris.find((b) => BARIS_TAGAR.test(b)) || ''
    );

    /* Baris yang tinggal menyisakan label setelah nomornya disensor tidak
       memberi informasi apa pun, dan kartunya sudah punya tombol ke
       postingan aslinya. */
    const kontakKosong = baris.find(
      (b) =>
        PENANDA_SENSOR.test(b) &&
        b.replace(PENANDA_SENSOR, '').replace(/[^\p{L}\p{N}]/gu, '').length < 12
    );
    cekBenar(`deskripsi ${v.id}: tidak ada baris kontak kosong`, !kontakKosong, kontakKosong || '');

    cekBenar(
      `deskripsi ${v.id}: tidak ada baris yang isinya hanya emoji`,
      !baris.some((b) => b.length > 0 && !/[\p{L}\p{N}]/u.test(b)),
      baris.find((b) => b.length > 0 && !/[\p{L}\p{N}]/u.test(b)) || ''
    );

    /* Dan yang paling menentukan: teks rapi itu benar-benar sampai ke layar
       dengan baris-barisnya utuh, bukan runtuh jadi satu paragraf karena
       white-space CSS-nya salah. */
    const kartu = `article.card[data-kandidat="${v.id}"]`;
    const tampil = await page.locator(`${kartu} .deskripsi`).innerText();
    const barisTampil = tampil.split('\n').filter((b) => b.trim()).length;
    cekBenar(`deskripsi ${v.id}: baris terjaga saat dirender`, barisTampil >= 5, `${barisTampil} baris di layar`);
  }
}

/* --- 1c. catatan harga iklan ------------------------------------------ */

{
  /* Harga sebenarnya datang dari matrix.json; postingan aslinya kadang
     menyebut angka lain. Kalau berbeda, halaman HARUS menyebutkan keduanya:
     tanpa itu pemilih membaca "800 RIBU" di deskripsi tepat di bawah header
     "Rp 700rb" dan menyimpulkan halaman ini salah.
     Kalau sama, catatannya tidak boleh muncul -- kalau tidak, ia cuma derau. */
  for (let i = 0; i < harap.length; i++) {
    const v = video.video[i];
    const kartu = `article.card[data-kandidat="${v.id}"]`;
    const adaCatatan = (await page.locator(`${kartu} .harga-iklan`).count()) === 1;
    const berbeda = v.harga_iklan != null && v.harga_iklan !== harap[i].harga;

    cek(`kartu ${v.id}: catatan harga iklan muncul hanya bila berbeda`, adaCatatan, berbeda);

    if (berbeda) {
      const teksCatatan = await page.locator(`${kartu} .harga-iklan`).innerText();
      const hargaIklan = 'Rp ' + v.harga_iklan.toLocaleString('id-ID') + 'rb';
      cekBenar(
        `kartu ${v.id}: catatan menyebut ${hargaIklan}`,
        teksCatatan.includes(hargaIklan),
        teksCatatan
      );

      /* Harga sebenarnya tetap yang menonjol, bukan tertukar dengan iklan. */
      const hargaUtama = await page.locator(`${kartu} .price`).innerText();
      const hargaBenar = 'Rp ' + harap[i].harga.toLocaleString('id-ID') + 'rb';
      cekBenar(`kartu ${v.id}: header tetap harga sebenarnya`, hargaUtama.includes(hargaBenar), hargaUtama);
    }
  }
}

cekBenar(
  'kedua waktu tempuh BERBEDA di layar',
  harap[0].menit !== harap[1].menit,
  `${harap[0].menit} vs ${harap[1].menit} -- kalau sama, pembulatannya salah`
);

/* --- 2. atribut video -------------------------------------------------- */

{
  const atribut = await page.$$eval('video.klip', (daftar) =>
    daftar.map((v) => ({
      src: v.getAttribute('src'),
      playsinline: v.hasAttribute('playsinline'),
      controls: v.hasAttribute('controls'),
      preload: v.getAttribute('preload'),
      autoplay: v.hasAttribute('autoplay'),
      lebar: v.getAttribute('width'),
      tinggi: v.getAttribute('height'),
    }))
  );

  cekBenar('semua video playsinline', atribut.every((a) => a.playsinline), JSON.stringify(atribut));
  cekBenar('semua video controls', atribut.every((a) => a.controls));
  cekBenar('semua video preload=metadata', atribut.every((a) => a.preload === 'metadata'));
  cekBenar('tidak ada video autoplay', atribut.every((a) => !a.autoplay));

  for (let i = 0; i < harap.length; i++) {
    cek(`video ${harap[i].id}: src`, atribut[i].src, harap[i].berkas + '#t=0.8');
    cek(`video ${harap[i].id}: dimensi atribut`, [atribut[i].lebar, atribut[i].tinggi], [
      String(harap[i].lebar),
      String(harap[i].tinggi),
    ]);
  }

  /* Rasio kedua video memang berbeda (480x848 vs 480x864). Kalau nanti ada
     yang memaksa satu nilai aspect-ratio untuk keduanya, assertion ini yang
     memberi tahu bahwa itu memotong salah satunya. */
  const rasio = harap.map((h) => (h.lebar / h.tinggi).toFixed(4));
  cekBenar('rasio kedua video berbeda', rasio[0] !== rasio[1], rasio.join(' vs '));
}

{
  /* Video benar-benar bisa di-decode Chrome, bukan cuma ada di DOM.
     readyState >= 1 berarti metadata sudah terbaca.

     Batas waktunya jauh lebih longgar saat menguji situs live: di sana mp4
     7,9 MB diambil lewat jaringan sungguhan, dan batas 8 detik membuat
     assertion ini kadang gagal padahal halamannya benar. Tes yang kadang
     gagal itu cacat tersendiri -- ia mengikis kepercayaan pada assertion
     lain yang justru sedang menjaga hal penting. */
  const BATAS_METADATA = SITUS_LUAR ? 30000 : 8000;

  const siap = await page.$$eval(
    'video.klip',
    (daftar, batas) =>
      Promise.all(
        daftar.map(
          (v) =>
            new Promise((selesai) => {
              const lapor = () => selesai({ rs: v.readyState, w: v.videoWidth, d: v.duration });
              if (v.readyState >= 1) return lapor();
              v.addEventListener('loadedmetadata', lapor);
              setTimeout(lapor, batas);
            })
        )
      ),
    BATAS_METADATA
  );
  cekBenar('metadata kedua video terbaca', siap.every((s) => s.rs >= 1), JSON.stringify(siap));
  cekBenar(
    'videoWidth sesuai berkas aslinya',
    siap.every((s, i) => s.w === harap[i].lebar),
    JSON.stringify(siap.map((s) => s.w))
  );
}

/* --- 3. aturan nol-CDN ------------------------------------------------- */

{
  /* Ditegakkan mekanis: kalau nanti ada yang menambahkan Tailwind atau
     Google Fonts, tes ini gagal, bukan cuma reviewer yang mungkin lupa. */
  cek('tidak ada <script src>', await n('script[src]'), 0);
  cek('tidak ada stylesheet eksternal', await n('link[rel="stylesheet"]'), 0);
  cek('tidak ada link href http(s)', await n('link[href^="http"]'), 0);
  cek('tepat satu <style> inline', await n('style'), 1);
}

/* --- 4. tema ----------------------------------------------------------- */

{
  const awal = await page.getAttribute('html', 'data-theme');
  await page.click('#btn-theme');
  const satu = await page.getAttribute('html', 'data-theme');
  await page.click('#btn-theme');
  const dua = await page.getAttribute('html', 'data-theme');
  await page.click('#btn-theme');
  const tiga = await page.getAttribute('html', 'data-theme');

  cek('tema: siklus gelap -> terang -> ikut sistem', [awal, satu, dua, tiga], [null, 'dark', 'light', null]);

  await page.click('#btn-theme');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('article.card');
  cek('tema: bertahan setelah reload', await page.getAttribute('html', 'data-theme'), 'dark');

  await page.click('#btn-theme');
  await page.click('#btn-theme');
}

/* --- 5. validasi di klien --------------------------------------------- */

if (dasarApi) {
  /* Submit dengan nama kosong tidak boleh menyentuh jaringan sama sekali. */
  let kirimTerjadi = 0;
  const pemantau = (req) => {
    if (req.url().includes('/api/suara')) kirimTerjadi++;
  };
  page.on('request', pemantau);

  await page.fill('#f-nama', '');
  await page.click('#btn-kirim');
  await page.waitForTimeout(300);

  cekBenar('nama kosong: banner muncul', (await n('#banner.show')) === 1);
  cek('nama kosong: nol request ke /api/suara', kirimTerjadi, 0);

  /* Nama terisi tapi belum memilih kandidat: juga tidak boleh ke jaringan. */
  await page.fill('#f-nama', 'Penguji UI');
  await page.click('#btn-kirim');
  await page.waitForTimeout(300);
  cekBenar('belum memilih: banner muncul', (await n('#banner.show')) === 1);
  cek('belum memilih: nol request ke /api/suara', kirimTerjadi, 0);

  page.off('request', pemantau);
}

/* --- 6. kirim suara sungguhan ----------------------------------------- */

if (dasarApi) {
  await page.click('.chip[data-pilihan="A"]');
  cek('chip A: aria-pressed true', await page.getAttribute('.chip[data-pilihan="A"]', 'aria-pressed'), 'true');
  cek('chip B: aria-pressed false', await page.getAttribute('.chip[data-pilihan="B"]', 'aria-pressed'), 'false');

  await page.fill('#f-alasan', 'lebih dekat ke stasiun');
  await page.click('#btn-kirim');

  await page.waitForFunction(
    () => document.querySelectorAll('#hasil .suara').length > 0,
    null,
    { timeout: 10000 }
  );

  const hasil = await page.locator('#hasil').innerText();
  cekBenar('suara masuk daftar hasil', hasil.includes('Penguji UI'), hasil.slice(0, 120));
  cekBenar('alasan ikut tampil', hasil.includes('lebih dekat ke stasiun'));

  const ringkas = await page.locator('#ringkas').innerText();
  cekBenar('ringkasan: total 1', /Total suara\s*1/.test(ringkas), ringkas);
  cekBenar('ringkasan: badge hasil langsung', ringkas.includes('Hasil langsung'), ringkas);

  /* Label tombol berganti sebentar lalu pulih -- idiom umpan balik project
     induk, bukan toast. Keduanya diperiksa: konfirmasinya benar-benar muncul,
     DAN tombolnya benar-benar bisa dipakai lagi setelah itu. Memeriksa
     pemulihannya saja akan lolos walau konfirmasinya tidak pernah tampil. */
  cek('tombol kirim menampilkan konfirmasi', await page.locator('#btn-kirim').textContent(), 'Tersimpan');
  await page.waitForTimeout(1800);
  cek('tombol kirim pulih setelah 1600 ms', await page.locator('#btn-kirim').textContent(), 'Kirim suara');
  cek('tombol kirim bisa dipakai lagi', await page.locator('#btn-kirim').isDisabled(), false);

  /* Memilih kandidat lain dengan nama yang sama harus MENGUBAH, bukan
     menambah. Ini persyaratan inti yang diuji di lapisan UI. */
  await page.click('.chip[data-pilihan="B"]');
  await page.click('#btn-kirim');
  await page.waitForTimeout(1200);

  const ringkas2 = await page.locator('#ringkas').innerText();
  cekBenar('kirim ulang nama sama: total TETAP 1', /Total suara\s*1/.test(ringkas2), ringkas2);
  cekBenar('kirim ulang nama sama: B jadi 1', /\bB\s*1\b/.test(ringkas2), ringkas2);
  cek('hanya ada satu baris suara', await n('#hasil .suara'), 1);
}

/* --- 7. alasan tidak boleh jadi HTML ---------------------------------- */

if (dasarApi) {
  const XSS = '<img src=x onerror=alert(1)>';
  const imgAwal = await n('img');

  await page.fill('#f-nama', 'Penguji XSS');
  await page.click('.chip[data-pilihan="A"]');
  await page.fill('#f-alasan', XSS);
  await page.click('#btn-kirim');
  await page.waitForTimeout(1500);

  const hasil = await page.locator('#hasil').innerText();
  cekBenar('alasan berisi HTML tampil sebagai teks', hasil.includes(XSS), hasil.slice(0, 200));
  cek('tidak ada <img> baru di DOM', await n('img'), imgAwal);
}

/* --- 8. riwayat ------------------------------------------------------- */

if (dasarApi) {
  await page.click('#blok-riwayat summary');
  await page.waitForTimeout(500);
  cekBenar('riwayat terisi', (await n('#riwayat .riwayat-baris')) > 0);

  const riwayat = await page.locator('#riwayat').innerText();
  cekBenar('riwayat memuat aksi baru', riwayat.includes('baru'), riwayat.slice(0, 160));
  cekBenar('riwayat memuat aksi ubah', riwayat.includes('ubah'), riwayat.slice(0, 160));
  await page.click('#blok-riwayat summary');
}

/* --- 9. override ?api= ditolak kalau host tidak diizinkan ------------- */

{
  await page.goto(URL_SITUS + '?api=' + encodeURIComponent('https://jahat.example'), { waitUntil: 'load' });
  await page.waitForSelector('article.card');
  await page.waitForTimeout(800);

  /* Diperiksa di #banner-tolak, banner permanen, bukan di #banner yang
     operasional. Sebelumnya keduanya satu elemen, dan pesan "Voting belum
     aktif" menimpa peringatan ini -- yang berarti orang yang mengklik tautan
     berbahaya melihat peringatannya lenyap. */
  const banner = await page.locator('#banner-tolak').innerText();
  cekBenar('?api= host asing: ditolak dengan penjelasan', banner.includes('ditolak'), banner.slice(0, 160));
  cekBenar('?api= host asing: peringatan tetap terlihat', (await n('#banner-tolak.show')) === 1);

  const catatan = await page.locator('#catatan-api').innerText();
  cekBenar('?api= host asing: tidak dipakai sebagai alamat', !catatan.includes('jahat.example'), catatan);
}

/* --- 10. jalur backend mati ------------------------------------------- */

{
  /* Backend diblokir di level jaringan, bukan dimatikan prosesnya, supaya
     yang diuji adalah perilaku halaman dan bukan urutan matinya server. */
  abaikanGalat = true;
  await ctx.route('**/api/**', (r) => r.abort());

  await page.goto(URL_UJI, { waitUntil: 'load' });
  await page.waitForSelector('article.card');

  /* Tunggu halaman benar-benar JATUH ke jalur cuplikan, jangan tidur sekian
     milidetik lalu berharap. Tombol kirim awalnya memang belum disabled --
     ia baru dinonaktifkan setelah fallback ke data/hasil.json selesai, dan
     lewat internet itu bisa lebih lama dari tidur tetap mana pun. */
  const jatuh = await tunggu(page, () => {
    const b = document.getElementById('btn-kirim');
    const n = document.getElementById('alasan-mati');
    return b && b.disabled && n && n.classList.contains('show');
  });
  cekBenar('backend mati: halaman jatuh ke jalur cuplikan', jatuh);

  cekBenar('backend mati: banner muncul', (await n('#banner.show')) === 1);
  cek('backend mati: tombol kirim disabled', await page.locator('#btn-kirim').isDisabled(), true);

  const ringkas = await page.locator('#ringkas').innerText();
  cekBenar('backend mati: badge cuplikan tampil', ringkas.includes('Cuplikan'), ringkas);

  const banner = await page.locator('#banner').innerText();
  /* Dua keadaan yang memang berbeda, dan halaman memang mengatakan hal yang
     berbeda: belum ada alamat server sama sekali, versus ada tapi tidak
     terjangkau. Assertion-nya ikut membedakan, bukan dilonggarkan sampai
     keduanya lolos. */
  const polaBanner = halamanPunyaApi ? /tidak bisa dihubungi/i : /belum aktif/i;
  cekBenar(
    `backend mati: banner menjelaskan keadaannya (${halamanPunyaApi ? 'tak terjangkau' : 'belum ada alamat'})`,
    polaBanner.test(banner),
    banner.slice(0, 200)
  );

  /* Inti perbaikan ini: alasannya harus terbaca DI SEBELAH tombol, bukan cuma
     di banner puncak halaman yang sudah di luar layar begitu orang scroll ke
     formulir. Itulah yang dilihat orang: tombol pudar tanpa keterangan. */
  const nota = await page.locator('#alasan-mati').innerText();
  cek('backend mati: catatan alasan tampil di sebelah tombol', await n('#alasan-mati.show'), 1);
  cekBenar(
    'backend mati: catatan alasan menjelaskan keadaannya',
    polaBanner.test(nota),
    nota.slice(0, 200)
  );

  /* Kartu video tetap harus terender: halaman berguna sebelum jaringan. */
  cek('backend mati: kartu video tetap ada', await n('article.card[data-kandidat]'), 2);

  await ctx.unroute('**/api/**');
  abaikanGalat = false;
}

/* --- 11. tangkapan layar desktop ------------------------------------- */

await page.goto(URL_UJI, { waitUntil: 'load' });
await page.waitForSelector('article.card');
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(DIR_SHOT, 'desktop-terang.png'), fullPage: true });

await page.click('#btn-theme');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(DIR_SHOT, 'desktop-gelap.png'), fullPage: true });

/* --- 12. HP ---------------------------------------------------------- */

{
  /* Konteks BARU 390x844, bukan resize: sebagian keputusan tata letak diambil
     saat muat, jadi resize tidak menguji hal yang sama. */
  const ctxHp = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    locale: 'id-ID',
  });
  const hp = await ctxHp.newPage();
  hp.on('console', (m) => {
    if (m.type() === 'error') masalah.push('console(hp): ' + m.text());
  });
  hp.on('pageerror', (e) => masalah.push('pageerror(hp): ' + e.message));

  await hp.goto(URL_UJI, { waitUntil: 'load' });
  await hp.waitForSelector('article.card');
  await hp.waitForTimeout(900);

  const geser = await hp.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  cekBenar(
    'HP: tidak ada scroll horizontal',
    geser.scrollWidth - geser.clientWidth <= 1,
    JSON.stringify(geser)
  );

  const lebarVideo = await hp.$$eval('video.klip', (d) => d.map((v) => Math.round(v.getBoundingClientRect().width)));
  cekBenar('HP: video tidak melebihi lebar layar', lebarVideo.every((w) => w <= 390), JSON.stringify(lebarVideo));

  /* Kartu pertama harus sudah terlihat tanpa scroll: halaman ini dibuka orang
     dari tautan WhatsApp, dan yang pertama mereka cari adalah videonya. */
  const atasKartu = await hp.locator('article.card').first().evaluate((e) => e.getBoundingClientRect().top);
  cekBenar('HP: kartu pertama terlihat dalam satu layar', atasKartu < 844, String(Math.round(atasKartu)));

  /* Target sentuh chip minimal 44px, ukuran yang bisa dijangkau jempol. */
  const tinggiChip = await hp.$$eval('#chips .chip', (d) => d.map((c) => Math.round(c.getBoundingClientRect().height)));
  cekBenar('HP: tinggi chip minimal 40px', tinggiChip.every((t) => t >= 40), JSON.stringify(tinggiChip));

  await hp.screenshot({ path: path.join(DIR_SHOT, 'hp.png'), fullPage: true });
  await ctxHp.close();
}

/* --- 13. tidak ada error di konsol ---------------------------------- */

cek('tidak ada error console / pageerror', masalah, []);

/* ------------------------------------------------------------------ hasil --- */

await browser.close();
console.log(`\n${lulus} lulus, ${gagal} gagal`);
bersihkan();
process.exit(gagal ? 1 : 0);
