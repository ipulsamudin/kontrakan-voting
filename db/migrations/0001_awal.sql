-- Migrasi 0001: tabel suara, log append-only, dan kuota per-perangkat.
--
-- File ini dipakai APA ADANYA oleh dua backend:
--   - Cloudflare D1     (wrangler d1 migrations apply, migrations_dir = ../db/migrations)
--   - PHP + pdo_sqlite  (lokal/api.php menjalankannya saat basis data masih kosong)
--
-- Itu mungkin karena D1 memang SQLite. Jangan masukkan sintaks yang hanya ada
-- di salah satunya, dan jangan pakai PRAGMA di sini (D1 menolak sebagian PRAGMA).

CREATE TABLE IF NOT EXISTS suara (
  id         INTEGER PRIMARY KEY,

  -- Kunci satu-suara-per-nama. Normalisasinya dikerjakan di KODE APLIKASI,
  -- bukan di SQL: lower() dan COLLATE NOCASE milik SQLite hanya melipat ASCII
  -- A-Z, jadi mencampur keduanya menghasilkan kunci yang case-insensitive
  -- untuk A-Z tapi case-sensitive untuk sisanya. Satu tempat saja.
  nama_norm  TEXT    NOT NULL UNIQUE CHECK(length(nama_norm) BETWEEN 1 AND 60),

  -- Nama apa adanya untuk ditampilkan. NOT NULL tidak menolak string kosong,
  -- karena '' bukan NULL, jadi batas bawah CHECK yang mengurusnya.
  nama       TEXT    NOT NULL        CHECK(length(nama)      BETWEEN 1 AND 60),

  -- NOT NULL di sini WAJIB, bukan gaya. Tanpanya `NULL IN ('A','B')` bernilai
  -- NULL, dan SQLite menganggap CHECK yang bukan FALSE sebagai lulus. Payload
  -- {"pilihan": null} akan masuk mulus, GROUP BY pilihan memunculkan ember
  -- ketiga, dan A + B jadi lebih kecil dari total tanpa gejala apa pun.
  pilihan    TEXT    NOT NULL        CHECK(pilihan IN ('A','B')),

  -- length() SQLite menghitung karakter, bukan byte, sama seperti [...s].length
  -- di JS. Jadi batas ini benar-benar sama dengan yang ditegakkan aplikasi,
  -- dan berfungsi sebagai jaring pengaman lapis kedua.
  alasan     TEXT    NOT NULL DEFAULT '' CHECK(length(alasan) <= 500),

  -- ISO-8601 dari kode aplikasi. JANGAN datetime('now'), yang menghasilkan
  -- '2026-10-29 06:12:00' (spasi, tanpa Z) -- bukan ISO-8601, dan historis
  -- gagal di new Date() Safari.
  dibuat     TEXT    NOT NULL,
  diubah     TEXT    NOT NULL,

  -- 0 = baru, >0 = sudah pernah diubah. Dipakai untuk menurunkan `aksi` dari
  -- RETURNING, sehingga tidak perlu SELECT pendahulu yang bisa berbalapan.
  revisi     INTEGER NOT NULL DEFAULT 0,

  -- sha256(token) hex. NULL = nama ini belum pernah diklaim perangkat mana pun.
  token_hash TEXT,

  -- sha256(ip + IP_SALT) dipotong 16 hex. BUKAN IP mentah: data ini publik,
  -- dan IPv4 cuma 2^32 sehingga hash tanpa salt bisa dibalik dengan mudah.
  sidik      TEXT    NOT NULL DEFAULT '',

  -- 1 = write terakhir datang dari perangkat yang bukan pengklaim pertama.
  -- Sengaja tidak memblokir, hanya menandai. Lihat README bagian penyalahgunaan.
  asing      INTEGER NOT NULL DEFAULT 0 CHECK(asing IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_suara_diubah ON suara(diubah DESC);

-- Log append-only. AUTOINCREMENT, bukan rowid biasa, supaya `ke` tidak pernah
-- dipakai ulang setelah DELETE: monotonisitasnya jadi sifat struktural, bukan
-- janji yang bisa dilanggar.
CREATE TABLE IF NOT EXISTS suara_log (
  ke        INTEGER PRIMARY KEY AUTOINCREMENT,
  nama_norm TEXT    NOT NULL,
  nama      TEXT    NOT NULL,
  pilihan   TEXT,
  alasan    TEXT    NOT NULL DEFAULT '',
  aksi      TEXT    NOT NULL CHECK(aksi IN ('baru','ubah','hapus')),
  asing     INTEGER NOT NULL DEFAULT 0,
  sidik     TEXT    NOT NULL DEFAULT '',
  waktu     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_ke ON suara_log(ke DESC);

-- Log ditegakkan BASIS DATA, bukan disiplin kode aplikasi.
--
-- Dengan dua statement di aplikasi, kode harus ingat untuk mencatat, dan
-- menentukan `aksi` butuh SELECT pendahulu yang bisa berbalapan: dua POST
-- serentak untuk nama yang sama sama-sama membaca "belum ada" dan sama-sama
-- mencatat 'baru'. Dengan trigger, log jadi properti skema -- satu statement
-- atomik, tanpa race, mustahil terlupa, dan ikut terbawa wrangler d1 export.
CREATE TRIGGER IF NOT EXISTS trg_log_baru AFTER INSERT ON suara
BEGIN
  INSERT INTO suara_log (nama_norm, nama, pilihan, alasan, aksi, asing, sidik, waktu)
  VALUES (new.nama_norm, new.nama, new.pilihan, new.alasan, 'baru', new.asing, new.sidik, new.diubah);
END;

CREATE TRIGGER IF NOT EXISTS trg_log_ubah AFTER UPDATE ON suara
BEGIN
  INSERT INTO suara_log (nama_norm, nama, pilihan, alasan, aksi, asing, sidik, waktu)
  VALUES (new.nama_norm, new.nama, new.pilihan, new.alasan, 'ubah', new.asing, new.sidik, new.diubah);
END;

-- Trigger hapus berarti jejak audit selamat bahkan dari pembersihan manual.
CREATE TRIGGER IF NOT EXISTS trg_log_hapus AFTER DELETE ON suara
BEGIN
  INSERT INTO suara_log (nama_norm, nama, pilihan, alasan, aksi, asing, sidik, waktu)
  VALUES (old.nama_norm, old.nama, old.pilihan, old.alasan, 'hapus', 0, old.sidik,
          strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;

-- Kuota tulis per-perangkat. Tabelnya ada sejak migrasi pertama supaya
-- mengaktifkan BATAS_AKTIF nanti tidak butuh migrasi kedua, tapi
-- penegakannya ada di kode dan default-nya mati.
-- WITHOUT ROWID: separuh penyimpanan dan separuh row-read untuk tabel
-- yang isinya hanya kunci komposit + satu angka.
CREATE TABLE IF NOT EXISTS jatah (
  sidik   TEXT    NOT NULL,
  jendela TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sidik, jendela)
) WITHOUT ROWID;
