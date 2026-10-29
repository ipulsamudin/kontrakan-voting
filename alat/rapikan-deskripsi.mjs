/**
 * Merapikan teks deskripsi yang diambil dari Facebook dan TikTok.
 *
 *   import { rapikanDeskripsi, sensorNomor } from './rapikan-deskripsi.mjs';
 *
 *   node alat/rapikan-deskripsi.mjs          terapkan ulang ke data/video.json
 *   node alat/rapikan-deskripsi.mjs --uji    jalankan uji mandiri
 *
 * Dipisah dari alat/ambil-deskripsi.mjs karena dua alasan:
 *
 *   1. Bisa diterapkan ulang ke data yang SUDAH tersimpan tanpa men-scrape
 *      lagi. Scrape bergantung pada Facebook dan TikTok mau melayani; merapikan
 *      teks tidak, dan tidak seharusnya ikut bergantung.
 *   2. Bisa diuji sebagai fungsi murni, yang jauh lebih berguna daripada
 *      memeriksa hasilnya dengan mata setiap kali scrape dijalankan.
 *
 * Caption TikTok datang sebagai SATU baris raksasa tanpa pemisah apa pun:
 * emoji dipakai sebagai penanda butir, deretan emoji dipakai sebagai garis
 * pemisah, dan kata saling menempel di batasnya ("dllCATATAN:"). Dibiarkan apa
 * adanya, ia jadi dinding teks yang tidak terbaca di HP -- padahal justru di
 * HP halaman ini dibuka.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------ pola emoji --- */

/* Disusun lewat konstruktor RegExp dari potongan ASCII, bukan ditulis sebagai
   literal berisi karakter emoji. Sumbernya jadi tetap ASCII dan tidak bisa
   rusak oleh perkakas yang memproses escape -- pelajaran yang sama dengan
   KODE_SPASI di test-api.mjs. */
const SATU_EMOJI =
  '\\p{Extended_Pictographic}' + // dasar
  '[\\u{1F3FB}-\\u{1F3FF}]?' + // pengubah warna kulit
  '\\uFE0F?' + // penanda tampilan emoji
  '(?:\\u200D\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?)*'; // rangkaian ZWJ

/* Dua emoji atau lebih berturut-turut: itu garis hias, bukan informasi. */
const DERET_EMOJI = new RegExp(`(?:${SATU_EMOJI})(?:[ \\t]*(?:${SATU_EMOJI}))+`, 'gu');

/* Satu emoji yang diikuti teks: itu penanda butir. */
const EMOJI_BUTIR = new RegExp(`[ \\t]*(${SATU_EMOJI})[ \\t]*(?=\\S)`, 'gu');

/* Emoji yang menempel di antara kata dan kurung buka: hiasan penutup. */
const EMOJI_PENUTUP = new RegExp(`([\\p{L}\\p{N}])(?:${SATU_EMOJI})+(?=\\()`, 'gu');

/* Baris yang isinya hanya tagar. */
const BARIS_TAGAR = /^#[\wÀ-ɏ]+(?:\s+#[\wÀ-ɏ]+)*$/;

const PENGGANTI_NOMOR = '[nomor ada di postingan aslinya]';

/* --------------------------------------------------------------- sensor --- */

/**
 * Menyensor nomor telepon.
 *
 * Repo ini publik, dan deskripsi yang terambil memuat nomor kontak pemilik
 * kontrakan: orang ketiga yang tidak terlibat dalam keputusan ini. Nomornya
 * memang sudah tayang di Facebook dan TikTok, tapi menyalinnya ke repo GitHub
 * adalah penerbitan ulang -- tindakan berbeda, yang membuatnya terindeks dan
 * terunduh di tempat yang tidak mereka pilih.
 *
 * Polanya menuntut minimal delapan digit setelah awalan 0 atau 62, jadi
 * "800 ribu" dan "850" di teks harga tidak ikut tersensor.
 */
export function sensorNomor(teks) {
  return String(teks || '').replace(
    /(?:\+?62|0)[ .-]?8\d{1,2}[ .-]?\d{3,4}[ .-]?\d{3,5}/g,
    PENGGANTI_NOMOR
  );
}

/* -------------------------------------------------------------- perapih --- */

/**
 * Membuang kepala halaman Facebook: nama grup, nama pemosting, dan penanda
 * waktu relatif. Itu chrome, bukan isi postingan -- dan nama pemosting adalah
 * data pribadi yang tidak perlu ikut diterbitkan ulang.
 */
export function buangKepalaFb(teks) {
  const baris = String(teks || '').split('\n');
  let i = 0;
  while (i < baris.length && i < 12) {
    const b = baris[i].trim();
    const penandaWaktu = /^\d+\s*(detik|menit|jam|hari|minggu|bulan|tahun)/i.test(b);
    const pemisah = b === '·' || b === '' || b === '-';
    const pendek = b.length < 25;
    if (penandaWaktu || pemisah || pendek) {
      i++;
      continue;
    }
    break;
  }
  return baris.slice(i).join('\n');
}

/**
 * Merapikan satu deskripsi. Idempoten: menjalankannya pada teks yang sudah
 * rapi menghasilkan teks yang sama, sehingga aman dipanggil berulang.
 */
export function rapikanDeskripsi(teks) {
  let s = String(teks || '');

  /* 0. Emoji yang menempel tepat sebelum kurung buka itu hiasan PENUTUP,
        bukan penanda butir: "DI DEPOK<rumah>(Tapos, Depok)". Dibuang lebih
        dulu, kalau tidak langkah 2 memecahnya jadi baris sendiri dan judulnya
        terbelah dua. */
  s = s.replace(EMOJI_PENUTUP, '$1 ');

  /* 1. Deretan emoji hias jadi pemisah baris. Dilakukan SEBELUM langkah
        butir, kalau tidak setiap emoji dalam deretan itu akan dikira
        penanda butir dan menghasilkan sepuluh baris kosong. */
  s = s.replace(DERET_EMOJI, '\n');

  /* 2. Emoji tunggal yang diikuti teks jadi awal baris, emoji-nya
        dipertahankan sebagai penanda butir. */
  s = s.replace(EMOJI_BUTIR, '\n$1 ');

  /* 3. Kata yang menempel di batas huruf kecil ke HURUF BESAR, mis.
        "dllCATATAN:" -> "dll" + "CATATAN:". Minimal tiga huruf besar
        berturut-turut supaya nama diri seperti "Gg. Candikayu Kel." tidak
        ikut terpotong. */
  s = s.replace(/([a-z,.:])([A-Z]{3,})/g, '$1\n$2');

  /* 4. Butir yang dipisah tanda hubung tanpa spasi, mis.
        "Fasilitas:-Air Jetpump-Listrik Token". Hanya ketika tidak ada spasi
        di kedua sisi, supaya "Sukamaju - Cilodong" tidak ikut terpotong. */
  s = s.replace(/([a-z:,.])-([A-Z])/g, '$1\n- $2');

  /* 5. Rapikan tanda baca yang menempel.
        "Jawa Barat(Samping Gor)" -> "Jawa Barat (Samping Gor)"
        "-+ 5 menit" dan "+- 5 menit" -> "+/- 5 menit"
        Keduanya salah ketik di postingan aslinya, bukan gaya penulisan. */
  s = s.replace(/([\p{L}\p{N}])\(/gu, '$1 (');
  s = s.replace(/(^|\s)[-+]{2}(?=\s*\d)/g, '$1+/-');

  /* 6. Pecah per baris lalu saring. */
  const baris = s
    .split('\n')
    .map((b) => b.replace(/[ \t]+/g, ' ').trim())
    .filter((b) => b.length > 0)
    /* Baris tagar: derau media sosial, tidak memberi tahu apa pun tentang
       rumahnya. Tautan ke postingan asli tetap ada di kartu. */
    .filter((b) => !BARIS_TAGAR.test(b))
    /* Baris yang tinggal menyisakan label setelah nomornya disensor.
       "Cp hub : [nomor ...]" dan "Dilla: [nomor ...]" tidak memuat informasi
       apa pun lagi, dan kartunya sudah punya tombol ke postingan aslinya.
       Ambangnya dihitung HANYA untuk baris yang memang memuat penanda sensor,
       supaya kalimat pendek yang sah seperti "Teras berpagar" tidak ikut
       terbuang. */
    .filter((b) => {
      if (!b.includes(PENGGANTI_NOMOR)) return true;
      const sisa = b.split(PENGGANTI_NOMOR).join('').replace(/[^\p{L}\p{N}]/gu, '');
      return sisa.length >= 12;
    })
    /* Baris yang isinya hanya emoji, sisa dari langkah 1 dan 2. */
    .filter((b) => b.replace(DERET_EMOJI, '').replace(new RegExp(SATU_EMOJI, 'gu'), '').trim().length > 0);

  return baris.join('\n');
}

/* ------------------------------------------------------------------ CLI --- */

/* process.argv[1] tidak ada kalau modul ini diimpor dari konteks tanpa berkas
   masuk, mis. `node --input-type=module -e`. Tanpa penjaga Boolean() di depan,
   sekadar meng-import modul ini melempar TypeError. */
const DIJALANKAN_LANGSUNG =
  Boolean(process.argv[1]) &&
  import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/').replace(/^\//, '');

if (DIJALANKAN_LANGSUNG) {
  const AKAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  if (process.argv.includes('--uji')) {
    let lulus = 0;
    let gagal = 0;
    const cek = (nama, aktual, harap) => {
      const ok = aktual === harap;
      console.log(`${ok ? 'OK   ' : 'GAGAL'} ${nama}`);
      if (!ok) console.log(`      dapat : ${JSON.stringify(aktual)}\n      harap : ${JSON.stringify(harap)}`);
      ok ? lulus++ : gagal++;
    };

    const E = (k) => String.fromCodePoint(k);
    const RUMAH = E(0x1f3e0);
    const PIN = E(0x1f4cd);
    const PANAH = E(0x1f53d);
    const UANG = E(0x1f4b0);

    cek(
      'deretan emoji hias jadi pemisah baris',
      rapikanDeskripsi('Judul rumahnya' + PANAH.repeat(5) + 'Spesifikasi lengkap'),
      'Judul rumahnya\nSpesifikasi lengkap'
    );
    cek(
      'emoji tunggal jadi penanda butir',
      rapikanDeskripsi('Kontrakan murah' + PIN + 'Jl Jatijajar nomor 10'),
      'Kontrakan murah\n' + PIN + ' Jl Jatijajar nomor 10'
    );
    cek(
      'kata menempel di batas huruf besar dipisah',
      rapikanDeskripsi('Toko Sayur, dllCATATAN: harganya nego'),
      'Toko Sayur, dll\nCATATAN: harganya nego'
    );
    cek(
      'butir bertanda hubung tanpa spasi dipecah',
      rapikanDeskripsi('Fasilitas:-Air Jetpump-Listrik Token'),
      'Fasilitas:\n- Air Jetpump\n- Listrik Token'
    );
    cek(
      'tanda hubung BERSPASI tidak dipecah',
      rapikanDeskripsi('Lokasi di Sukamaju - Cilodong, Depok'),
      'Lokasi di Sukamaju - Cilodong, Depok'
    );
    cek('baris tagar dibuang', rapikanDeskripsi('Rumah bagus\n#kontrakandepok\n#taposdepok'), 'Rumah bagus');
    cek(
      'baris kontak yang sudah tersensor dibuang',
      rapikanDeskripsi('Harga 850 ribu net\nCp hub : ' + PENGGANTI_NOMOR),
      'Harga 850 ribu net'
    );
    cek(
      'kalimat utuh yang memuat nomor tetap dipertahankan',
      rapikanDeskripsi('Silakan hubungi pemilik di ' + PENGGANTI_NOMOR + ' pada jam kerja'),
      'Silakan hubungi pemilik di ' + PENGGANTI_NOMOR + ' pada jam kerja'
    );
    cek(
      'kalimat pendek tanpa nomor tidak ikut terbuang',
      rapikanDeskripsi('Teras berpagar'),
      'Teras berpagar'
    );
    cek(
      'emoji yang berdiri sendiri dibuang',
      rapikanDeskripsi('Harga bersaing\n' + RUMAH + '\n' + UANG + ' Harga: 700 per bulan'),
      'Harga bersaing\n' + UANG + ' Harga: 700 per bulan'
    );

    const contoh =
      RUMAH + 'KONTRAKAN MURAH' + RUMAH + '(Tapos)' + PIN + 'Jl Jatijajar' + PANAH.repeat(4) +
      'Fasilitas:-Air Jetpump-Listrik Token' + UANG + 'Harga: 700/bln\n#taposdepok';
    cek(
      'emoji penutup sebelum kurung tidak memecah judul',
      rapikanDeskripsi('KONTRAKAN MURAH DI DEPOK' + RUMAH + '(Tapos, Depok)'),
      'KONTRAKAN MURAH DI DEPOK (Tapos, Depok)'
    );
    cek(
      'kurung yang menempel diberi spasi',
      rapikanDeskripsi('Jawa Barat(Samping Gor Bulutangkis)'),
      'Jawa Barat (Samping Gor Bulutangkis)'
    );
    cek(
      'salah ketik -+ jadi +/-',
      rapikanDeskripsi('-+ 5 menit ke jl Tole Iskandar'),
      '+/- 5 menit ke jl Tole Iskandar'
    );
    cek(
      'tanda kurang yang sah tidak diubah',
      rapikanDeskripsi('Harga 850 - 900 ribu'),
      'Harga 850 - 900 ribu'
    );
    const sekali = rapikanDeskripsi(contoh);
    cek('idempoten: dijalankan dua kali hasilnya sama', rapikanDeskripsi(sekali), sekali);

    cek('teks kosong aman', rapikanDeskripsi(''), '');
    cek('null aman', rapikanDeskripsi(null), '');

    console.log(`\n${lulus} lulus, ${gagal} gagal`);
    process.exit(gagal ? 1 : 0);
  }

  /* Terapkan ulang ke data/video.json tanpa menyentuh jaringan. */
  const berkas = path.join(AKAR, 'data', 'video.json');
  const data = JSON.parse(fs.readFileSync(berkas, 'utf8'));
  let berubah = 0;

  for (const v of data.video) {
    const sebelum = v.deskripsi || '';
    const sesudah = rapikanDeskripsi(sensorNomor(sebelum));
    if (sesudah !== sebelum) {
      v.deskripsi = sesudah;
      berubah++;
      console.log(`[${v.id}] ${sebelum.split('\n').length} baris -> ${sesudah.split('\n').length} baris`);
    } else {
      console.log(`[${v.id}] sudah rapi`);
    }
  }

  if (berubah) {
    fs.writeFileSync(berkas, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`\n${berubah} deskripsi dirapikan, data/video.json diperbarui.`);
  } else {
    console.log('\nTidak ada yang perlu diubah.');
  }
}
