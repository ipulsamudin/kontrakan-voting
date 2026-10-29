/**
 * Worker Cloudflare: implementasi kontrak API voting di atas D1.
 *
 * Berkas ini dan lokal/api.php adalah DUA implementasi dari SATU kontrak, dan
 * keduanya memakai db/migrations/0001_awal.sql apa adanya. Kalau Anda mengubah
 * aturan validasi atau normalisasi di satu sisi, ubah juga di sisi lain --
 * test-api.mjs dijalankan terhadap keduanya justru untuk menangkap kelalaian itu.
 *
 *   npx wrangler dev --local --port 8787 --config worker/wrangler.toml
 *   node test-api.mjs --dasar http://127.0.0.1:8787
 *
 * Nol dependency, nol langkah build.
 */

/* ============================================================== konstanta === */

const BATAS_BADAN = 4096; /* byte */
const BATAS_NAMA = 60; /* code point */
const BATAS_ALASAN = 500; /* code point */
const BATAS_RIWAYAT = 500;
const BATAS_SUARA = 500;

/* Kolom disebut satu per satu, JANGAN SELECT *: tabel suara memuat token_hash
   dan sidik, dan endpoint ini publik. Ada assertion di test-api.mjs bahwa
   respons /api/hasil tidak memuat key token_hash, supaya refactor ke SELECT *
   di masa depan gagal berisik alih-alih bocor senyap. */
const KOLOM_PUBLIK = 'id, nama, pilihan, alasan, dibuat, diubah, revisi, asing';

/* ============================================================ normalisasi === */

/* Tabel code point, bukan escape \u di dalam literal regex.
   Dua alasan: sumbernya tetap ASCII sehingga tidak bisa rusak oleh perkakas
   yang memproses escape, dan daftarnya bisa dibaca berdampingan dengan
   POLA_SPASI / POLA_BUANG di lokal/api.php untuk memastikan keduanya sama. */
const KODE_SPASI = [
  [0x09, 0x0d], 0x20, 0x85, 0xa0, 0x1680, [0x2000, 0x200a],
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

const KODE_BUANG = [
  [0x00, 0x08], [0x0e, 0x1f], 0x7f, 0xad, [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2066, 0x2069], 0xfeff,
];

const hex4 = (k) => '\\u' + k.toString(16).padStart(4, '0');
const kelas = (tabel) =>
  tabel.map((e) => (Array.isArray(e) ? hex4(e[0]) + '-' + hex4(e[1]) : hex4(e))).join('');

/* Kelas eksplisit, bukan \s: cakupan \s berbeda antara PCRE (yang dipakai PHP)
   dan JS, dan normalisasi ini harus identik di keduanya. Mengandalkan \s
   berarti mengandalkan dua engine sepakat tanpa pernah diuji. */
const POLA_SPASI = new RegExp('[' + kelas(KODE_SPASI) + ']+', 'g');
const POLA_BUANG = new RegExp('[' + kelas(KODE_BUANG) + ']', 'g');

/**
 * Harus identik dengan normalkan() di lokal/api.php.
 *
 * URUTANNYA MENENTUKAN:
 *   1. semua jenis spasi -> satu spasi biasa (TAB jadi spasi, BUKAN hilang)
 *   2. buang sisa kontrol + zero-width + bidi
 *   3. rapatkan spasi yang mungkin berdampingan setelah langkah 2
 *   4. potong ujung
 *
 * Menukar 1 dan 2 adalah bug: "ipul<TAB>samudin" akan menjadi "ipulsamudin",
 * kunci yang berbeda dari "ipul samudin" yang ditulis orang lain dengan spasi
 * biasa, sehingga satu orang bisa berakhir punya dua suara tanpa niat.
 *
 * CATATAN: NFKC tidak dipakai, walau Worker ini sebenarnya mampu. PHP di mesin
 * pengembangan tidak punya ekstensi intl, dan meng-NFKC hanya di sisi sini
 * membuat nama yang sama menghasilkan kunci berbeda tergantung backend mana
 * yang melayani -- bug yang lebih buruk daripada tidak punya NFKC sama sekali.
 * Konsekuensi yang diterima: "A" + combining acute tetap berbeda kunci dari
 * "A-akut" precomposed.
 */
function normalkan(mentah) {
  const bersih = String(mentah ?? '')
    .replace(POLA_SPASI, ' ')
    .replace(POLA_BUANG, '')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/g, '');
  return { tampil: bersih, kunci: bersih.toLowerCase() };
}

/** Panjang dalam code point, bukan UTF-16 code unit: emoji dihitung 1. */
const panjangCp = (s) => [...String(s ?? '')].length;

/* ================================================================ utilitas === */

async function sha256(teks) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(teks));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * CF-Connecting-IP dipercaya HANYA karena trafik wajib melewati Cloudflare
 * untuk mencapai Worker ini, jadi nilainya diisi edge dan tidak bisa dipalsukan
 * klien. X-Forwarded-For sengaja TIDAK dibaca: siapa pun bisa mengarangnya.
 *
 * Yang disimpan adalah sha256(ip + IP_SALT) dipotong 16 hex, BUKAN IP mentah,
 * karena nilai ini diterbitkan ke publik lewat /api/riwayat. Tanpa salt, hash
 * itu bisa dibalik dengan mudah: ruang IPv4 cuma 2^32, tinggal di-brute force.
 */
async function sidikPerangkat(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return '';
  const salt = env.IP_SALT || '';
  return (await sha256(ip + salt)).slice(0, 16);
}

const sekarangIso = () => new Date().toISOString();

const bendera = (env, nama) => String(env[nama] ?? '0') === '1';

function asalDiizinkan(env) {
  return String(env.ASAL_DIIZINKAN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ================================================================= jawaban === */

/**
 * Header CORS ditempelkan di SINI, satu tempat, supaya ia ikut terpasang di
 * respons error juga.
 *
 * Ini kesalahan CORS Worker nomor satu: throw yang tidak tertangkap
 * mengembalikan 500 tanpa header, browser melaporkan "blocked by CORS policy",
 * dan error yang sebenarnya jadi tidak terlihat sama sekali. Karena itu
 * seluruh fetch() di bawah dibungkus satu try/catch yang tetap lewat sini.
 */
function balas(status, isi, request, env, header = {}) {
  const h = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    /* Vary: Origin wajib. Tanpanya, respons ter-cache bisa dilayani ke origin
       lain dengan header ACAO milik origin pertama. */
    Vary: 'Origin',
    ...header,
  });

  const asal = request.headers.get('Origin');
  if (asal && asalDiizinkan(env).includes(asal)) {
    h.set('Access-Control-Allow-Origin', asal);
  }

  return new Response(status === 204 ? null : JSON.stringify(isi), { status, headers: h });
}

const gagal = (status, kode, pesan, request, env, header = {}) =>
  balas(status, { ok: false, kode, pesan }, request, env, header);

/* =================================================================== query === */

async function ambilHitung(env) {
  /* GROUP BY tidak mengembalikan baris untuk sisi yang nol suara, jadi di-seed
     dulu. Tanpa ini, {"A":4} dikirim tanpa key "B" sama sekali dan halaman
     merender "undefined". */
  const hitung = { A: 0, B: 0 };
  const { results } = await env.DB.prepare('SELECT pilihan, COUNT(*) AS n FROM suara GROUP BY pilihan').all();
  for (const r of results) hitung[r.pilihan] = Number(r.n);
  return hitung;
}

const bentukSuara = (r) => ({
  id: Number(r.id),
  nama: r.nama,
  pilihan: r.pilihan,
  alasan: r.alasan,
  dibuat: r.dibuat,
  diubah: r.diubah,
  revisi: Number(r.revisi),
  asing: Number(r.asing) === 1,
});

async function hasilLengkap(env) {
  const hitung = await ambilHitung(env);
  const { results } = await env.DB.prepare(
    `SELECT ${KOLOM_PUBLIK} FROM suara ORDER BY diubah DESC LIMIT ${BATAS_SUARA}`
  ).all();

  return {
    ok: true,
    sumber: 'langsung',
    dibuat: sekarangIso(),
    tutup: bendera(env, 'VOTING_TUTUP'),
    total: hitung.A + hitung.B,
    hitung,
    suara: results.map(bentukSuara),
  };
}

/* ================================================================= handler === */

async function rutaHasil(request, env) {
  /* no-store, BUKAN max-age.
     Dengan cache pendek, urutan "kirim suara lalu muat hasil" dilayani dari
     cache browser dan pemilih melihat angkanya tidak berubah -- lalu
     menyimpulkan suaranya hilang. Penghematan row-read tidak sebanding dengan
     angka yang salah di depan mata orang. */
  return balas(200, await hasilLengkap(env), request, env, { 'Cache-Control': 'no-store' });
}

async function rutaRiwayat(request, env, url) {
  /* batas di-CLAMP, bukan ditolak dengan 400. Nilai di luar jangkauan itu
     kesalahan tak berbahaya; menolaknya cuma menyusahkan pemakai curl. */
  let batas = Number(url.searchParams.get('batas') ?? 200);
  if (!Number.isFinite(batas)) batas = 200;
  batas = Math.max(1, Math.min(BATAS_RIWAYAT, Math.floor(batas)));

  const { results } = await env.DB.prepare(
    `SELECT ke, nama, pilihan, alasan, aksi, asing, sidik, waktu
       FROM suara_log ORDER BY ke DESC LIMIT ${batas}`
  ).all();

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM suara_log').first('n');

  return balas(
    200,
    {
      ok: true,
      total: Number(total),
      riwayat: results.map((r) => ({
        ke: Number(r.ke),
        nama: r.nama,
        pilihan: r.pilihan,
        alasan: r.alasan,
        aksi: r.aksi,
        asing: Number(r.asing) === 1,
        sidik: r.sidik,
        waktu: r.waktu,
      })),
    },
    request,
    env,
    { 'Cache-Control': 'no-store' }
  );
}

async function rutaEkspor(request, env) {
  const suara = await env.DB.prepare(`SELECT ${KOLOM_PUBLIK} FROM suara ORDER BY id`).all();
  const log = await env.DB.prepare(
    'SELECT ke, nama, pilihan, alasan, aksi, asing, sidik, waktu FROM suara_log ORDER BY ke'
  ).all();

  return balas(
    200,
    {
      ok: true,
      dibuat: sekarangIso(),
      suara: suara.results.map(bentukSuara),
      suara_log: log.results,
    },
    request,
    env,
    { 'Cache-Control': 'no-store' }
  );
}

async function rutaSuara(request, env) {
  if (bendera(env, 'VOTING_TUTUP')) {
    /* 423 Locked, bukan 403, supaya halaman bisa membedakan "voting sudah
       ditutup" dari "permintaanmu ditolak". */
    return gagal(423, 'voting-tutup', 'Voting sudah ditutup. Hasilnya tetap bisa dilihat.', request, env);
  }

  const mentah = await request.text();
  if (new TextEncoder().encode(mentah).length > BATAS_BADAN) {
    return gagal(400, 'badan-rusak', 'Data yang dikirim terlalu besar.', request, env);
  }

  let badan = null;
  try {
    badan = JSON.parse(mentah);
  } catch {
    return gagal(400, 'badan-rusak', 'Data yang dikirim tidak bisa dibaca.', request, env);
  }
  if (badan === null || typeof badan !== 'object' || Array.isArray(badan)) {
    return gagal(400, 'badan-rusak', 'Data yang dikirim tidak bisa dibaca.', request, env);
  }

  /* --- nama --- */
  const n = normalkan(badan.nama);
  if (n.kunci === '') return gagal(400, 'nama-kosong', 'Nama belum diisi.', request, env);
  if (panjangCp(n.tampil) > BATAS_NAMA) {
    return gagal(400, 'nama-panjang', `Nama maksimal ${BATAS_NAMA} karakter.`, request, env);
  }
  if (!/\p{L}/u.test(n.tampil)) {
    return gagal(400, 'nama-tanpa-huruf', 'Nama harus memuat setidaknya satu huruf.', request, env);
  }

  /* --- pilihan: cocok persis, tanpa coercion dan tanpa lipat huruf --- */
  const pilihan = badan.pilihan;
  if (pilihan !== 'A' && pilihan !== 'B') {
    return gagal(400, 'pilihan-tidak-sah', 'Pilih salah satu video dulu.', request, env);
  }

  /* --- alasan --- */
  let alasanMentah = badan.alasan ?? '';
  if (typeof alasanMentah !== 'string') {
    return gagal(400, 'badan-rusak', 'Alasan harus berupa teks.', request, env);
  }
  /* Baris baru sengaja DIPERTAHANKAN di sini, tidak seperti di nama: alasan
     itu teks bebas, dan halaman merendernya dengan white-space: pre-wrap. */
  const alasan = alasanMentah.replace(POLA_BUANG, '').trim();
  if (panjangCp(alasan) > BATAS_ALASAN) {
    return gagal(400, 'alasan-panjang', `Alasan maksimal ${BATAS_ALASAN} karakter.`, request, env);
  }

  /* --- token --- */
  const token = badan.token ?? null;
  const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (token !== null && (typeof token !== 'string' || !POLA_UUID.test(token))) {
    return gagal(400, 'token-tidak-sah', 'Token perangkat tidak dikenali.', request, env);
  }

  const tokenBaru = token ?? crypto.randomUUID();
  const tokenHash = await sha256(tokenBaru);
  const sekarang = sekarangIso();
  const sidik = await sidikPerangkat(request, env);

  if (bendera(env, 'KETAT')) {
    const ada = await env.DB.prepare('SELECT token_hash FROM suara WHERE nama_norm = ?')
      .bind(n.kunci)
      .first();
    if (ada && ada.token_hash && ada.token_hash !== tokenHash) {
      return gagal(403, 'bukan-pemilik', 'Nama ini sudah dipakai dari perangkat lain.', request, env);
    }
  }

  /* Satu statement, tanpa SELECT pendahulu: `aksi` diturunkan dari revisi di
     RETURNING. Dua POST serentak untuk nama yang sama karena itu tidak bisa
     sama-sama mengira dirinya "baru".
     (lokal/api.php memakai transaksi BEGIN IMMEDIATE untuk hasil yang sama,
     karena SQLite yang dibundel PHP 8.0 di sana belum punya RETURNING.) */
  const sql = `INSERT INTO suara
      (nama_norm, nama, pilihan, alasan, dibuat, diubah, revisi, token_hash, sidik, asing)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, ?6, ?7, 0)
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
                   END
    RETURNING ${KOLOM_PUBLIK}`;

  let baris;
  try {
    baris = await env.DB.prepare(sql)
      .bind(n.kunci, n.tampil, pilihan, alasan, sekarang, tokenHash, sidik)
      .first();
  } catch (e) {
    const pesan = String(e && e.message);
    /* CHECK constraint yang jebol di sini berarti ada aturan validasi di atas
       yang bocor. Dilaporkan 400, bukan 500, supaya halaman memberi pesan
       yang berguna. */
    if (/CHECK constraint/i.test(pesan)) {
      return gagal(400, 'data-tidak-sah', 'Data yang dikirim tidak memenuhi aturan.', request, env);
    }
    throw e;
  }

  if (!baris) return gagal(500, 'simpan-gagal', 'Suara tidak tersimpan. Coba lagi.', request, env);

  const suara = bentukSuara(baris);
  const aksi = suara.revisi === 0 ? 'baru' : 'ubah';
  const hitung = await ambilHitung(env);

  const isi = { ok: true, aksi, suara, hitung, total: hitung.A + hitung.B };

  /* Token hanya dikembalikan saat nama ini pertama kali diklaim. Sesudah itu
     ia tidak pernah dikirim lagi, jadi tidak bisa dipanen dari respons. */
  if (aksi === 'baru') isi.token = tokenBaru;

  /* Respons membawa tally terbaru supaya halaman tidak perlu GET susulan. */
  return balas(200, isi, request, env, { 'Cache-Control': 'no-store' });
}

/* ================================================================== fetch === */

const TABEL = {
  '/api/hasil': ['GET', rutaHasil],
  '/api/riwayat': ['GET', rutaRiwayat],
  '/api/ekspor': ['GET', rutaEkspor],
  '/api/suara': ['POST', rutaSuara],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rute = '/' + url.pathname.replace(/^\/+|\/+$/g, '');

    try {
      if (request.method === 'OPTIONS') {
        return balas(204, null, request, env, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Max-Age': '86400',
        });
      }

      const entri = TABEL[rute];
      if (!entri) return gagal(404, 'rute-tidak-ada', 'Alamat ini tidak ada.', request, env);

      const [metodeWajib, handler] = entri;
      if (request.method !== metodeWajib) {
        return gagal(405, 'metode-salah', `Metode ${request.method} tidak dilayani di sini.`, request, env, {
          Allow: metodeWajib,
        });
      }

      return await handler(request, env, url);
    } catch (e) {
      const pesan = String(e && e.message);

      /* Kuota D1 habis itu tebing, bukan perlambatan: write gagal keras sampai
         00:00 UTC. Dipetakan ke 503 yang bersih supaya halaman turun ke
         cuplikan statis alih-alih menampilkan sesuatu yang tampak rusak. */
      if (/exceed|limit|quota|too many|D1_ERROR.*storage/i.test(pesan)) {
        return gagal(
          503,
          'basis-data-penuh',
          'Basis data sedang penuh. Hasil masih bisa dilihat, tapi suara baru belum bisa masuk.',
          request,
          env
        );
      }

      console.error('voting:', pesan);
      return gagal(500, 'galat-server', 'Ada yang salah di server. Coba lagi sebentar.', request, env);
    }
  },
};
