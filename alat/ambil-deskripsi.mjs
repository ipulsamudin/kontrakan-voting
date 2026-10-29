/**
 * Mengambil teks penjelasan kedua video dari Facebook dan TikTok, SEKALI,
 * lalu menuliskannya ke data/video.json untuk Anda koreksi.
 *
 *   node alat/ambil-deskripsi.mjs            headless
 *   node alat/ambil-deskripsi.mjs --tampak   browser terlihat, untuk login manual
 *
 * Kode scraper-nya TIDAK disalin ke repo ini. Yang dipakai adalah milik project
 * induk di ../Kontrakan/scraper, karena di situlah playwright-core dan profil
 * browser yang sudah login berada. Repo publik ini tidak perlu membawa mesin
 * scraping, dan `.browser-profile` induk setara kredensial -- ia tidak boleh
 * mendekat ke repo yang akan di-push.
 *
 * SENGAJA DIPISAH DARI JALUR KRITIS.
 *
 * Halaman voting sudah lengkap tanpa teks ini: fakta harga, jarak, dan waktu
 * tempuh datang dari data/matrix.json, dan kartu video menampilkan tombol ke
 * postingan aslinya. Kalau pengambilan gagal, `status_ambil` jadi "gagal" dan
 * halaman tetap benar. Facebook tidak boleh memblokir deploy.
 *
 * Dan pengambilan ini MEMANG rapuh, dengan cara yang diketahui:
 *
 *   - splitPostAndComments() di induk jatuh ke { post: seluruhTeks } kalau
 *     tidak ada penanda yang cocok, dan tooShort() hanya menolak di bawah 40
 *     karakter. Jadi dinding login sepanjang 200 karakter bisa lolos sebagai
 *     ok:true. Karena itu hasilnya SELALU perlu Anda baca sebelum dipercaya,
 *     dan skrip ini menyimpan teks mentahnya apa adanya.
 *
 *   - Untuk TikTok, komentar di scraper induk sendiri mencatat bahwa tanpa
 *     login balasannya cuma "TikTok - Make Your Day". Pakai --tampak dan login
 *     manual kalau og:description kosong.
 *
 * Tidak ada upaya menembus proteksi bot di sini, sejalan dengan non-goal yang
 * dinyatakan README project induk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AKAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDUK = path.resolve(AKAR, '..', 'Kontrakan', 'scraper');
const BERKAS_VIDEO = path.join(AKAR, 'data', 'video.json');

const TAMPAK = process.argv.includes('--tampak');

if (!fs.existsSync(INDUK)) {
  console.error(`GAGAL: tidak menemukan scraper induk di ${INDUK}`);
  console.error('Skrip ini perlu project Kontrakan sebagai folder sebelahnya.');
  process.exit(1);
}

const url = (p) => 'file:///' + path.resolve(INDUK, p).replace(/\\/g, '/');
const { launchBrowser, metaContent } = await import(url('sources/browser.js'));
const { readPermalink } = await import(url('sources/facebook.js'));

/**
 * Menyensor nomor telepon.
 *
 * Repo ini PUBLIK, dan deskripsi yang terambil memuat nomor kontak pemilik
 * kontrakan: orang ketiga yang tidak terlibat dalam keputusan ini. Nomornya
 * memang sudah tayang di Facebook dan TikTok, tapi menyalinnya ke repo GitHub
 * adalah penerbitan ulang -- tindakan yang berbeda, dan yang membuatnya
 * terindeks serta terunduh di tempat yang tidak mereka pilih.
 *
 * Halaman voting tidak membutuhkannya: pemilih memilih rumah, bukan menelepon
 * pemiliknya, dan tombol ke postingan asli tetap tersedia bagi yang perlu.
 *
 * Polanya menuntut minimal delapan digit setelah awalan 0 atau 62, jadi
 * "800 ribu" dan "850" di teks harga tidak ikut tersensor.
 */
function sensorNomor(teks) {
  return String(teks || '').replace(
    /(?:\+?62|0)[ .-]?8\d{1,2}[ .-]?\d{3,4}[ .-]?\d{3,5}/g,
    '[nomor ada di postingan aslinya]'
  );
}

/**
 * Membuang kepala halaman Facebook: nama grup, nama pemosting, dan penanda
 * waktu relatif. Itu chrome, bukan isi postingan -- dan nama pemosting adalah
 * data pribadi yang tidak perlu ikut diterbitkan ulang.
 *
 * Dipotong sampai baris pertama yang panjangnya wajar dan bukan penanda waktu,
 * bukan dengan jumlah baris tetap, karena tinggi kepalanya berubah-ubah.
 */
function buangKepalaFb(teks) {
  const baris = String(teks || '').split('\n');
  let i = 0;
  while (i < baris.length && i < 12) {
    const b = baris[i].trim();
    const penandaWaktu = /^\d+\s*(detik|menit|jam|hari|minggu|bulan|tahun)/i.test(b);
    const pemisah = b === '\u00b7' || b === '' || b === '-';
    const pendek = b.length < 25;
    if (penandaWaktu || pemisah || pendek) {
      i++;
      continue;
    }
    break;
  }
  return baris.slice(i).join('\n');
}

/** Membuang baris yang jelas-jelas chrome situs, bukan isi postingan. */
function rapikan(teks) {
  return String(teks || '')
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .filter((b) => !/^(Suka|Komentari|Bagikan|Like|Comment|Share|Balas|Reply)$/i.test(b))
    .join('\n')
    .trim();
}

/**
 * Tanda-tanda bahwa yang terambil bukan isi postingan melainkan dinding login
 * atau kerangka halaman. Ini pemeriksaan DI SINI, bukan di induk, karena
 * tooShort() induk terlalu longgar untuk keperluan ini.
 */
function mencurigakan(teks) {
  if (!teks || teks.length < 60) return 'terlalu pendek';
  if (/TikTok - Make Your Day/i.test(teks) && teks.length < 200) return 'hanya kerangka TikTok';
  if (/^(Masuk|Log in|Login|Daftar|Sign up)\b/i.test(teks)) return 'tampak dinding login';
  if (/Kamu harus masuk|You must log in|Buat akun untuk/i.test(teks)) return 'tampak dinding login';
  return null;
}

const data = JSON.parse(fs.readFileSync(BERKAS_VIDEO, 'utf8'));

console.log(`Browser: ${TAMPAK ? 'terlihat' : 'headless'}`);
console.log(`Memakai profil scraper induk di ${INDUK}\n`);

const ctx = await launchBrowser({ headless: !TAMPAK });
let berubah = 0;

try {
  for (const v of data.video) {
    console.log(`[${v.id}] ${v.sumber_jenis}: ${v.sumber_url}`);
    let teks = null;
    let alasanGagal = null;

    if (v.sumber_jenis === 'Facebook') {
      const r = await readPermalink(ctx, v.sumber_url);
      if (r.ok) teks = sensorNomor(rapikan(buangKepalaFb(r.post)));
      else alasanGagal = r.reason;
    } else if (v.sumber_jenis === 'TikTok') {
      const page = await ctx.newPage();
      try {
        await page.goto(v.sumber_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3500);

        teks = await metaContent(page, 'og:description');
        if (!teks) {
          /* Cadangan DOM, dipakai scraper induk juga. */
          teks = await page
            .locator('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]')
            .first()
            .innerText({ timeout: 5000 })
            .catch(() => null);
        }
        teks = sensorNomor(rapikan(teks));
      } catch (e) {
        alasanGagal = String(e.message).split('\n')[0].slice(0, 80);
      } finally {
        await page.close().catch(() => {});
      }
    } else {
      alasanGagal = `sumber_jenis tidak dikenal: ${v.sumber_jenis}`;
    }

    const curiga = teks ? mencurigakan(teks) : null;

    if (!teks || alasanGagal || curiga) {
      v.status_ambil = 'gagal';
      v.diambil = new Date().toISOString().slice(0, 10);
      console.log(`     GAGAL: ${alasanGagal || curiga}`);
      console.log('     Halaman tetap benar tanpa ini. Tempel teksnya manual ke');
      console.log(`     data/video.json field "deskripsi", lalu set "status_ambil": "manual".\n`);
      continue;
    }

    v.deskripsi = teks;
    v.status_ambil = 'berhasil';
    v.diambil = new Date().toISOString().slice(0, 10);
    berubah++;

    console.log(`     BERHASIL, ${teks.length} karakter:`);
    console.log(
      teks
        .split('\n')
        .slice(0, 6)
        .map((b) => '     | ' + b.slice(0, 90))
        .join('\n')
    );
    console.log('');
  }
} finally {
  await ctx.close().catch(() => {});
}

data.diperbarui = new Date().toISOString().slice(0, 10);
fs.writeFileSync(BERKAS_VIDEO, JSON.stringify(data, null, 2) + '\n', 'utf8');

console.log(`${berubah} dari ${data.video.length} deskripsi terisi. data/video.json diperbarui.`);
console.log('BACA HASILNYA sebelum di-commit: dinding login bisa lolos sebagai teks yang sah.');
