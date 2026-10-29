/**
 * Memotong matrix.json project induk menjadi irisan 3x3 (RUMAH + kandidat A + B)
 * untuk data/matrix.json di repo public ini.
 *
 *   node alat/potong-matrix.mjs
 *
 * Kenapa di-generate dan tidak diketik ulang: angka ini dipakai UI *dan* dihitung
 * ulang oleh test-ui.mjs dengan parser terpisah. Kalau saya mengetik ulang
 * potongannya, salah transkripsi akan diwarisi keduanya dan tes jadi membenarkan
 * kesalahan yang sama. Men-generate dari sumber asli menutup celah itu.
 *
 * Enam kandidat lain (C sampai H) sengaja TIDAK ikut: repo ini public, dan
 * halaman voting hanya butuh dua kandidat.
 */

import fs from 'node:fs';
import path from 'node:path';

const SUMBER = path.resolve('../Kontrakan/matrix.json');
const TUJUAN = path.resolve('data/matrix.json');

/* Indeks yang diambil dari matriks induk: 0 = RUMAH, 1 = kandidat A, 2 = kandidat B. */
const AMBIL = [0, 1, 2];

if (!fs.existsSync(SUMBER)) {
  console.error(`GAGAL: tidak menemukan ${SUMBER}`);
  console.error('Script ini harus dijalankan dari dalam folder kontrakan-voting,');
  console.error('dengan project induk Kontrakan sebagai folder sebelahnya.');
  process.exit(1);
}

const penuh = JSON.parse(fs.readFileSync(SUMBER, 'utf8'));

for (const kunci of ['names', 'dist', 'dur']) {
  if (!Array.isArray(penuh[kunci])) {
    console.error(`GAGAL: matrix.json induk tidak punya array "${kunci}"`);
    process.exit(1);
  }
}

/* Memotong matriks persegi: baris DAN kolom harus sama-sama disaring, kalau
   hanya barisnya maka kolomnya bergeser dan jaraknya jadi salah tanpa gejala. */
const potongPersegi = (m) => AMBIL.map((i) => AMBIL.map((j) => m[i][j]));

/* names[0] di matriks induk memuat alamat rumah lengkap. Halaman voting tidak
   pernah menampilkannya, ia hanya perlu label "dari rumah" sebagai titik acuan.
   Jadi alamatnya diredaksi di sini: repo ini public, dan angka jaraknya sama
   sekali tidak terpengaruh. Nama kandidat A dan B tetap verbatim karena memang
   ditampilkan di kartu. */
const REDAKSI_RUMAH = 'RUMAH';

const irisan = {
  catatan:
    'Irisan 3x3 dari matrix.json project induk: RUMAH + dua kandidat yang divoting. ' +
    'Angka dalam kurung di names adalah sewa bulanan dalam ribuan rupiah. ' +
    'dist dalam meter, dur dalam detik. Matriksnya ASIMETRIS: dist[0][1] (rumah ke A) ' +
    'tidak sama dengan dist[1][0] (A ke rumah). names[0] diredaksi, alamat rumah ' +
    'tidak ikut diterbitkan.',
  sumber: 'Google Distance Matrix, diambil 2026-10-28',
  names: AMBIL.map((i) => (i === 0 ? REDAKSI_RUMAH : penuh.names[i])),
  dist: potongPersegi(penuh.dist),
  dur: potongPersegi(penuh.dur),
};

/* Pemeriksaan kewarasan sebelum menulis. Lebih baik gagal di sini daripada
   menerbitkan angka yang salah ke halaman voting. */
const masalah = [];
if (!/^RUMAH/.test(irisan.names[0])) masalah.push(`names[0] bukan RUMAH: ${irisan.names[0]}`);
if (!/^A /.test(irisan.names[1])) masalah.push(`names[1] tidak berawalan "A ": ${irisan.names[1]}`);
if (!/^B /.test(irisan.names[2])) masalah.push(`names[2] tidak berawalan "B ": ${irisan.names[2]}`);
for (let i = 0; i < 3; i++) {
  if (irisan.dist[i][i] !== 0) masalah.push(`dist[${i}][${i}] bukan 0`);
  if (irisan.dur[i][i] !== 0) masalah.push(`dur[${i}][${i}] bukan 0`);
}
for (const i of [1, 2]) {
  if (!(irisan.dist[0][i] > 0)) masalah.push(`dist[0][${i}] tidak positif`);
  if (!(irisan.dur[0][i] > 0)) masalah.push(`dur[0][${i}] tidak positif`);
  if (!/\((\d+)\)\s*$/.test(irisan.names[i])) masalah.push(`names[${i}] tidak memuat harga dalam kurung`);
}
if (masalah.length) {
  console.error('GAGAL, irisan tidak lolos pemeriksaan:');
  for (const m of masalah) console.error('  - ' + m);
  process.exit(1);
}

fs.mkdirSync(path.dirname(TUJUAN), { recursive: true });
fs.writeFileSync(TUJUAN, JSON.stringify(irisan, null, 2) + '\n', 'utf8');

console.log(`Tertulis ${TUJUAN}`);
for (let i = 0; i < 3; i++) {
  const km = (irisan.dist[0][i] / 1000).toFixed(2);
  const mnt = (irisan.dur[0][i] / 60).toFixed(1);
  console.log(`  [${i}] ${irisan.names[i]}  ->  ${km} km, ${mnt} menit dari rumah`);
}
console.log(`\nTIDAK ikut ter-publish: ${penuh.names.length - AMBIL.length} lokasi lain dari shortlist induk.`);
