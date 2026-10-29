# Pilih Kontrakan

Halaman voting untuk dua kandidat kontrakan di Depok. Pemilih menonton dua
video, memilih satu, dan menulis alasannya. Hasilnya bisa dilihat siapa saja.

| | Kandidat A | Kandidat B |
|---|---|---|
| Lokasi | Sukamaju, Cilodong | GOR Candik Ayu, Jatijajar |
| Sewa | Rp 850rb / bulan | **Rp 700rb / bulan** |
| Disebut postingan | Rp 850rb | Rp 800rb |
| Jarak dari rumah | 7,1 km | 7,7 km |
| Waktu tempuh | 7,1 menit | 7,5 menit |
| Penjelasan | [postingan Facebook](https://web.facebook.com/groups/infokontrakandepok/permalink/3092601260946147/) | [video TikTok](https://www.tiktok.com/@infokontrakandepok/video/7695235893396901127) |

Angka jarak dan waktu tempuh berasal dari Google Distance Matrix, disimpan di
`data/matrix.json`. Matriksnya **asimetris** (rumah ke A 7,1 menit, A ke rumah
7,5 menit), jadi yang ditampilkan selalu arah "dari rumah".

Harga sewa juga datang dari `data/matrix.json`, bukan dari teks postingan.
Untuk kandidat B keduanya **berbeda**: postingan TikTok-nya menyebut 800 ribu,
sementara harga sebenarnya 700 ribu. Kartu B karena itu menampilkan keduanya --
tanpa itu, pemilih membaca "800 RIBU" di deskripsi tepat di bawah header
"Rp 700rb" dan menyimpulkan halamannya salah. Ini mengikuti konvensi project
induk yang memisahkan klaim iklan dari fakta yang sudah dikonfirmasi sendiri.

---

## Satu kontrak, dua backend

GitHub Pages itu hosting statis: ia tidak bisa menjalankan PHP dan tidak bisa
menulis ke berkas SQLite. Jadi penulisan suara wajib lewat endpoint di luar
Pages. Karena belum tentu ada backend permanen hari ini, halaman ini bicara ke
**satu kontrak API** yang punya **dua implementasi yang bisa ditukar**:

```
              index.html  (statis, nol dependency, nol build)
                   |
                   |  fetch() ke `dasar` dari data/api.json atau ?api=
                   v
     +-------------+--------------------+
     |                                  |
lokal/api.php                   worker/src/index.js
PDO sqlite -> voting.sqlite     binding D1 -> D1
di XAMPP / `php -S`             di edge Cloudflare
     |                                  |
     +-------------+--------------------+
                   |
     db/migrations/0001_awal.sql YANG SAMA PERSIS
     (D1 memang SQLite, jadi ini bukan kebetulan)
                   |
                   v
     data/hasil.json  <- cuplikan statis, selalu terbaca di Pages
                         bahkan saat tidak ada backend hidup sama sekali
```

Konsekuensi praktisnya: skema, query, aturan validasi, dan normalisasi nama
hanya ditulis sekali per sisi, dan `test-api.mjs` dijalankan terhadap **kedua**
backend dengan assertion yang sama. Perbedaan perilaku di antara keduanya tidak
bisa lolos diam-diam.

Satu-satunya perbedaan implementasi yang disengaja: Worker memakai
`INSERT ... RETURNING` dalam satu statement, sementara `lokal/api.php` memakai
transaksi `BEGIN IMMEDIATE` karena SQLite yang dibundel PHP 8.0 di mesin
pengembangan masih 3.33 dan belum punya `RETURNING`. Keduanya menutup race yang
sama, dengan mekanisme yang berbeda.

---

## Menjalankannya

### Lokal, untuk Anda sendiri

Taruh folder ini di `htdocs` XAMPP, nyalakan Apache, lalu isi `data/api.json`:

```json
{ "dasar": "lokal/api.php" }
```

Buka `http://localhost/kontrakan-voting/`. Selesai: Apache melayani halaman
**dan** backend-nya, jadi keduanya satu origin.

Tanpa XAMPP, backend bisa dijalankan sendiri:

```bash
npm install          # hanya playwright-core, untuk tes
npm run dev:php      # backend di http://127.0.0.1:8787
```

lalu buka halaman lewat server statis apa pun dengan
`?api=http://127.0.0.1:8787`. Jangan `file://`: `fetch()` tidak bisa membaca
berkas tetangga dari sana, dan halaman akan memberi tahu kalau ini terjadi.

### Dibagikan ke orang lain, tanpa akun apa pun

Arahkan quick tunnel ke **XAMPP**, bukan ke backend saja:

```bash
npm run bagikan      # cloudflared tunnel --url http://localhost
```

`cloudflared` mencetak URL `https://xxxx.trycloudflare.com`. Bagikan:

```
https://xxxx.trycloudflare.com/kontrakan-voting/
```

Satu origin untuk halaman dan API, jadi tidak ada CORS dan tidak ada
`?api=` yang perlu ditempel. `cloudflared tunnel --url` tidak butuh akun
Cloudflare.

Batasannya nyata: URL-nya berubah setiap `cloudflared` dijalankan ulang, dan
voting hanya hidup selama laptop Anda menyala.

> **Jangan gabungkan halaman GitHub Pages dengan backend di localhost.**
> Chrome memblokirnya lewat Private Network Access dengan pesan
> *"Permission was denied for this request to access the `loopback` address
> space"*, dan header CORS yang benar sekalipun tidak menolong. Ini sudah
> diuji, bukan dugaan. Halaman dan backend harus satu origin, atau backend
> harus punya alamat publik sendiri (lihat bagian berikutnya).

### Permanen, 24 jam

Butuh akun Cloudflare gratis, tanpa kartu kredit. Daftar di
<https://dash.cloudflare.com/sign-up>, lalu:

```bash
npx wrangler login     # OAuth lewat browser, sekali saja
npm run deploy:cf      # sisanya satu perintah
```

`npm run deploy:cf` mengerjakan sembilan langkah yang sebelumnya manual:
membuat basis data D1 kalau belum ada, menulis `database_id` ke
`worker/wrangler.toml`, menerapkan migrasi ke D1 remote, memasang rahasia
`IP_SALT`, men-deploy Worker, **memverifikasi alamatnya sungguhan** dengan
memanggil `/api/hasil`, lalu menulis alamat itu ke `data/api.json`.

Idempoten dan aman dijalankan ulang. Dua hal yang sengaja tidak diulang:
basis data yang sudah ada dipakai lagi, dan `IP_SALT` yang sudah terpasang
**tidak** diputar ulang -- mengganti salt membuat setiap `sidik` yang sudah
diterbitkan tidak lagi cocok dengan yang baru, sehingga riwayat jadi tidak
bisa dibandingkan antar-periode.

Terakhir:

```bash
git add data/api.json worker/wrangler.toml
git commit -m "feat: hidupkan voting lewat Worker + D1"
git push
```

Workflow `Terbitkan` men-deploy ulang Pages, dan voting hidup tanpa laptop
Anda menyala.

Kuotanya: 5 juta baris dibaca per hari, 100.000 baris ditulis per hari,
500 MB per basis data. Satu suara memakai sekitar lima baris tulis, jadi
plafonnya sekitar 20.000 suara per hari.

> Akun Cloudflare yang betul-betul baru kadang belum punya subdomain
> `workers.dev`, dan itu diklaim sekali lewat dashboard. Kalau itu terjadi,
> `npm run deploy:cf` mencetak instruksinya, bukan jejak tumpukan.

---

## Yang TIDAK dilindungi sistem ini

Dinyatakan terang-terangan, karena menyembunyikannya akan lebih buruk daripada
tidak punya pengamanan sama sekali.

**Siapa pun yang punya URL bisa memberi suara memakai nama siapa pun**,
termasuk menimpa suara orang lain. "Nama wajib + URL publik + tanpa akun"
secara definisi adalah sistem tanpa autentikasi. Tidak ada perbaikan untuk itu
tanpa sistem akun, dan akun sengaja tidak dipakai.

Yang ADA, dan apa gunanya:

| Mekanisme | Yang dilakukan |
|---|---|
| **Log append-only** (`suara_log`, ditegakkan trigger basis data) | Setiap pengiriman tercatat, termasuk yang menimpa. Impersonasi jadi **terlihat dan bisa dibalik**, bukan tercegah. Untuk keputusan beberapa orang, itulah kebutuhan sebenarnya. |
| **Token edit lunak** | Pengirim pertama sebuah nama mendapat token di localStorage. Token tidak cocok -> write TETAP berhasil tapi ditandai `asing`, dan UI menulis "diubah dari perangkat lain". Sengaja lunak: kunci keras berarti siapa pun yang mengetik "Ipul" duluan memiliki nama itu permanen, dan Ipul yang asli di HP lain terkunci tanpa jalan pemulihan. |
| **`VOTING_TUTUP`** | Satu flag -> POST membalas 423, GET tetap melayani. Untuk keputusan yang selesai dalam hitungan hari, **ini jawaban paling lengkap atas penyalahgunaan**: bekukan hasilnya dan selesai. |
| **`noindex` + pemberitahuan di atas tombol kirim** | Nama dan alasan tampil publik dan tersimpan permanen. Dinyatakan sebelum orang menekan kirim, bukan sesudah. |
| **Batas panjang + pembuangan zero-width/bidi** | Mencegah kunci dipecah oleh karakter tak terlihat, dan mencegah tampilan tabel dibalik karakter arah. |
| **`sidik` di riwayat** | `sha256(ip + IP_SALT)` dipotong 16 hex. **Bukan IP mentah**, karena nilai ini publik: tanpa salt, ruang IPv4 yang cuma 2^32 membuatnya trivial dibalik. Gunanya supaya suara ganda dari satu perangkat terlihat mata. |

Yang sengaja **tidak** dipakai:

- **Turnstile / CAPTCHA.** Ia butuh `<script src="https://challenges.cloudflare.com/...">`,
  melanggar aturan nol-CDN halaman ini, dan manfaatnya terhadap ancaman yang
  sebenarnya -- manusia yang mengetik nama orang lain -- **tepat nol**.
  Turnstile menghentikan bot; bot bukan lawannya.
- **Kuota per-perangkat.** Tabel `jatah` sudah ada di migrasi pertama supaya
  mengaktifkannya nanti tidak butuh migrasi kedua, tapi penegakannya belum
  ditulis. Ia menambah satu baca dan satu tulis per suara, pada kuota yang
  justru ia lindungi.
- **Antrean vote offline.** Backend mati -> tombol kirim dinonaktifkan. Suara
  yang hilang diam-diam jauh lebih buruk daripada penolakan yang terlihat.
- **NFKC.** PHP di mesin pengembangan tidak punya ekstensi `intl`, dan
  menerapkan NFKC hanya di sisi Worker akan membuat nama yang sama
  menghasilkan kunci berbeda tergantung backend mana yang melayani. Akibat yang
  diterima: "A" + combining acute tetap beda kunci dari "A-akut" precomposed.
- Homoglyph (Cyrillic "a" vs Latin "a") juga tidak tertangani. Menangkalnya
  butuh tabel confusable yang tidak sebanding untuk skala ini.

---

## Data dan privasi

- **Deskripsi dirapikan, bukan ditempel apa adanya.** Caption TikTok datang
  sebagai satu baris raksasa: emoji dipakai sebagai penanda butir, deretan
  emoji sebagai garis pemisah, dan kata saling menempel di batasnya
  (`dllCATATAN:`). Dibiarkan begitu ia jadi dinding teks yang tidak terbaca di
  HP, padahal justru di HP halaman ini dibuka.
  `alat/rapikan-deskripsi.mjs` memecahnya jadi baris, membuang deretan emoji
  hias dan baris tagar, serta membuang baris kontak yang sudah kosong setelah
  nomornya disensor. Fungsinya idempoten dan punya uji mandiri
  (`npm run test:rapikan`), jadi bisa diterapkan ulang ke data yang sudah
  tersimpan tanpa perlu men-scrape lagi (`npm run rapikan`) -- berguna karena
  scrape bergantung pada Facebook dan TikTok mau melayani, sedangkan merapikan
  teks tidak.
- **Nomor telepon disensor.** Deskripsi yang diambil dari Facebook dan TikTok
  memuat nomor kontak pemilik kontrakan. Nomornya sudah tayang di kedua
  platform, tapi menyalinnya ke repo publik adalah penerbitan ulang: tindakan
  berbeda, yang membuatnya terindeks dan terunduh di tempat yang tidak mereka
  pilih. `alat/ambil-deskripsi.mjs` menyensornya, dan `test-ui.mjs` punya
  assertion bahwa tidak ada nomor yang sampai ke layar. Tautan ke postingan
  asli tetap ada bagi yang membutuhkannya.
- **`data/matrix.json` hanya irisan 3x3.** Matriks induk memuat sembilan lokasi
  dari pencarian rumah pribadi; yang diterbitkan hanya titik acuan dan dua
  kandidat yang divoting. Nama jalan rumahnya diredaksi jadi `"RUMAH"`, karena
  halaman ini tidak pernah menampilkannya.
- **`kontrakan.csv` project induk tidak ada di sini**, dan tidak boleh ada. Ia
  memuat 32 nomor WhatsApp orang lain. Repo ini sengaja dibuat sebagai folder
  *sebelah* `Kontrakan/`, bukan di dalamnya, supaya `git add -A` secara fisik
  tidak bisa menjangkaunya.
- **Suara tidak bisa ditarik kembali.** Begitu `data/hasil.json` ter-commit,
  sebuah nama ada di riwayat git publik selamanya, bahkan setelah dihapus dari
  basis data.

---

## Tes

```bash
npm test               # keempatnya berurutan
npm run test:api       # kontrak API terhadap PHP + SQLite
npm run test:worker    # kontrak API yang SAMA terhadap Worker + D1 lokal
npm run test:ui        # browser, dengan backend hidup
npm run test:ui:cuplikan   # browser, jalur cuplikan statis saja
npm run test:ui:relatif    # browser, susunan satu origin seperti di XAMPP
npm run test:rapikan       # uji mandiri perapih deskripsi (fungsi murni, cepat)
```

Tidak butuh XAMPP menyala: `test-ui.mjs` membawa server `node:http` sendiri,
dan keduanya menjalankan backend-nya sendiri lalu membunuhnya beserta seluruh
anak proses (`taskkill /T` di Windows, karena `wrangler dev` memunculkan
`workerd` sebagai cucu yang tidak ikut mati bersama induknya).

Playwright memakai Chrome yang sudah terinstal lewat `channel: 'chrome'`, jadi
tidak ada unduhan browser 150 MB.

**Prinsip yang diwarisi project induk:** nilai yang diharapkan dihitung ulang di
dalam tes dengan implementasi terpisah, bukan diambil dari kode yang diuji.
Tiga assertion yang benar-benar menegakkan itu:

- `normalizer PHP cocok dengan normalizer tes` -- membandingkan `normalkan()`
  milik `lokal/api.php` dengan normalizer yang ditulis terpisah di dalam tes,
  pada 18 input yang sulit. Ini menguji kontraknya langsung, bukan efeknya.
- `hitung ulang mandiri cocok dengan server` -- tes mengambil `/api/riwayat`,
  mereduksinya sendiri ke last-write-per-name, lalu menghitung A/B sendiri.
  Satu-satunya assertion yang bisa menangkap bug agregasi; sisanya mempercayai
  aritmetika server.
- Harga, jarak, dan waktu tempuh di `test-ui.mjs` diparse ulang dari
  `data/matrix.json` dengan regex sendiri, lalu dibandingkan dengan teks yang
  benar-benar tampil.

Beberapa assertion ada karena pernah menangkap bug sungguhan, dan sengaja
dipertahankan:

- `kedua waktu tempuh BERBEDA di layar` -- 423,9 dan 447,4 detik sama-sama
  membulat ke **7 menit**, membuat dua kandidat tampak identik padahal berbeda.
  Yang benar 7,1 dan 7,5.
- `TAB di tengah nama jadi satu spasi` -- TAB sempat ikut terbuang bersama
  control character lain, sehingga "ipul<TAB>samudin" jadi "ipulsamudin":
  kunci berbeda dari "ipul samudin", dan satu orang bisa punya dua suara.
- `tidak ada <script src>` -- menegakkan aturan nol-CDN secara mekanis.
- `kartu X: tidak ada nomor telepon di layar` -- menahan regresi kalau
  penyensoran di alat pengambil dilepas tanpa sengaja.

---

## Peta berkas

```
index.html                  seluruh aplikasi: satu <style>, satu <script>, nol dependency
db/migrations/0001_awal.sql SATU skema untuk kedua backend
lokal/api.php               backend PHP + PDO sqlite
worker/
  src/index.js              backend Cloudflare Worker + D1
  wrangler.toml             binding D1 + [vars]; tanpa rahasia
data/
  matrix.json               irisan 3x3 dari matrix.json induk (di-generate)
  video.json                provenance + nama berkas + matrix_index; TIDAK menduplikasi angka
  api.json                  satu-satunya sumber alamat API
  hasil.json                cuplikan statis, dibaca saat backend tidak terjangkau
video/                      dua mp4, dinamai ulang jadi web-safe
alat/
  deploy-cf.mjs             deploy Worker + D1 sembilan langkah, idempoten
  potong-matrix.mjs         matrix.json induk -> data/matrix.json
  ambil-deskripsi.mjs       scrape FB + TikTok sekali
  rapikan-deskripsi.mjs     sensor nomor + rapikan teks; punya uji mandiri
  normalkan-cli.php         membuka normalkan() PHP ke CLI untuk dibandingkan tes
  cuplikan.py               hasil API -> data/hasil.json, idempoten
test-api.mjs                kontrak API; dijalankan terhadap kedua backend
test-ui.mjs                 browser; membawa server statis sendiri
.github/workflows/terbitkan.yml   segarkan cuplikan + deploy Pages, satu job
```

### Beberapa keputusan yang tidak kelihatan dari kodenya

- **`data/video.json` tidak memuat harga, jarak, atau waktu tempuh.** Angka itu
  diturunkan dari `data/matrix.json` lewat `matrix_index`, supaya tidak ada dua
  sumber angka yang bisa berbeda. Tes menurunkannya ulang dengan parser sendiri.
  Satu pengecualian: `harga_iklan`, yang bukan duplikat melainkan data berbeda
  -- angka yang diklaim postingan aslinya. Ia hanya ditampilkan kalau berbeda
  dari harga sebenarnya, dan ada assertion bahwa ia **tidak** muncul kalau sama.
- **Harga diperbaiki di hulu, bukan di turunannya.** `data/matrix.json`
  di-generate dari `../Kontrakan/matrix.json` oleh `alat/potong-matrix.mjs`.
  Menambal turunannya saja akan tertimpa diam-diam pada `npm run potong-matrix`
  berikutnya, jadi koreksi harga harus masuk ke berkas induk dulu.
- **Log dijamin trigger basis data, bukan disiplin kode.** Dengan dua statement
  di aplikasi, kode harus ingat mencatat, dan menentukan `aksi` butuh `SELECT`
  pendahulu yang bisa berbalapan: dua POST serentak untuk nama yang sama
  sama-sama membaca "belum ada" dan sama-sama mencatat `baru`.
- **Header CORS ditempelkan di satu tempat, termasuk di respons error.** Ini
  kesalahan CORS Worker nomor satu: exception tak tertangkap mengembalikan 500
  tanpa header, browser melaporkan "blocked by CORS policy", dan penyebab
  sebenarnya jadi tidak terlihat. Ada assertion khusus untuk ini.
- **`/api/hasil` memakai `no-store`, bukan `max-age`.** Dengan cache 10 detik
  yang sempat dipakai, urutan "kirim suara lalu muat hasil" dilayani dari cache
  browser, dan pemilih melihat angkanya tidak berubah lalu menyimpulkan suaranya
  hilang.
- **`?api=` dibatasi allowlist host** (`trycloudflare.com`, `workers.dev`,
  localhost). Tanpa itu, siapa pun bisa membagikan tautan yang mengarahkan
  halaman ini ke server mereka dan memanen nama pemilih. Peringatan
  penolakannya memakai banner terpisah yang **tidak pernah** disembunyikan
  otomatis, karena sempat tertimpa pesan operasional berikutnya.
- **Penyegaran cuplikan dan deploy ada di SATU job.** Dengan sumber Pages
  "GitHub Actions", push memakai `GITHUB_TOKEN` sengaja tidak memicu workflow
  lain -- jadi workflow cuplikan terpisah yang meng-commit tidak akan pernah
  men-deploy apa pun, dan cuplikannya duduk di git tanpa pernah terlihat.
- **Alasan tombol kirim dinonaktifkan terbaca di sebelah tombolnya.**
  Sebelumnya alasannya hanya ada di atribut `title` tombol dan di banner
  puncak halaman. `title` tidak muncul sama sekali di HP, dan begitu orang
  scroll ke formulir, banner itu sudah di luar layar -- yang tersisa cuma
  tombol pudar tanpa keterangan apa pun. Sekarang ada elemen `.alasan-mati`
  tepat di ATAS baris tombol, supaya terbaca sebelum orang mengetik alasan
  panjang lalu menemukan suaranya tidak bisa dikirim. `setBisaKirim()` adalah
  satu-satunya tempat yang menyetelnya, jadi tidak ada jalur yang bisa
  menonaktifkan tombol tanpa ikut menjelaskan kenapa.
- **`test-ui.mjs --situs` membaca `data/api.json` milik situsnya.** Kalau ia
  berasumsi situs live tidak punya backend, seluruh blok "belum aktif" berubah
  merah tepat ketika Worker berhasil di-deploy -- tes melaporkan kegagalan
  padahal yang terjadi justru keberhasilan. Mode itu juga **tidak pernah**
  mengirim suara ke situs live: memilih dari UI akan mencemari hasil yang
  sedang dipakai orang mengambil keputusan.
- **Halaman dan backend sebaiknya satu origin.** Chrome memblokir permintaan
  dari origin publik HTTPS ke alamat loopback lewat Private Network Access,
  jadi "GitHub Pages + `php -S` di laptop" tidak bekerja seberapa pun benar
  header CORS-nya. Karena itu `dasar` di `data/api.json` boleh berupa alamat
  relatif seperti `lokal/api.php`, dan `npm run test:ui:relatif` menguji
  susunan itu secara khusus.
- **Git LFS tidak dipakai.** GitHub Pages tidak me-resolve objek LFS; ia
  melayani berkas pointer ~130 byte, dan videonya diam tanpa error. Lagipula
  tidak ada masalah untuk dipecahkan: batas keras GitHub 100 MB per berkas,
  yang terbesar di sini 7,9 MB.
- **`.gitattributes` ada sejak commit pertama** dengan `*.mp4 binary`, karena
  `core.autocrlf=true` di mesin ini bisa merusak mp4 secara senyap. Gejalanya
  hanya "video tidak jalan" di situs live. Verifikasinya:
  `git cat-file -s HEAD:video/a-sukamaju-cilodong.mp4` harus tepat `1906148`.
