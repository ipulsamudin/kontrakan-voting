"""Menyegarkan data/hasil.json dari respons /api/hasil.

    python alat/cuplikan.py /tmp/hasil-mentah.json [data/hasil.json]

Dipakai GitHub Actions setelah meng-curl API, dan bisa dijalankan manual.

Dua hal yang membuat skrip ini tidak sesepele "salin berkas":

1. IDEMPOTEN. Respons /api/hasil selalu memuat `dibuat` yang baru, jadi
   menyalinnya mentah-mentah menjamin ada diff di SETIAP run -- riwayat commit
   jadi tak berujung untuk nol informasi. Di sini `dibuat` dikecualikan dari
   perbandingan, dan berkasnya hanya ditulis kalau isinya benar-benar berubah.

2. MENOLAK SAMPAH. Respons 200 yang isinya bukan hasil voting (halaman error
   dari proxy, misalnya) tidak boleh menimpa cuplikan yang masih baik. Bentuknya
   divalidasi dulu.

Keluar dengan kode 0 kalau berhasil ATAU kalau tidak ada yang perlu diubah,
dan 1 kalau datanya tidak sah -- supaya langkah CI gagal berisik, bukan diam.
"""

import json
import sys
from pathlib import Path

TUJUAN_BAWAAN = Path("data/hasil.json")


def sah(d):
    """Memastikan ini benar-benar respons /api/hasil, bukan sembarang JSON."""
    if not isinstance(d, dict):
        return "bukan objek JSON"
    if d.get("ok") is not True:
        return "field ok bukan true"
    if not isinstance(d.get("hitung"), dict):
        return "field hitung tidak ada atau bukan objek"
    for sisi in ("A", "B"):
        if not isinstance(d["hitung"].get(sisi), int):
            return f"hitung.{sisi} bukan bilangan bulat"
    if not isinstance(d.get("total"), int):
        return "field total bukan bilangan bulat"
    if not isinstance(d.get("suara"), list):
        return "field suara bukan array"
    if d["hitung"]["A"] + d["hitung"]["B"] != d["total"]:
        return "A + B tidak sama dengan total"
    return None


def bentuk(d):
    """Menyusun ulang jadi bentuk cuplikan yang dipakai halaman."""
    return {
        "catatan": (
            "Cuplikan statis hasil voting, dihasilkan alat/cuplikan.py. "
            "Bentuknya identik dengan respons GET /api/hasil supaya halaman "
            "memakai satu renderer untuk keduanya; bedanya hanya field `sumber`."
        ),
        "dibuat": d.get("dibuat"),
        "hitung": {"A": d["hitung"]["A"], "B": d["hitung"]["B"]},
        "ok": True,
        "suara": d["suara"],
        # Halaman membaca field ini untuk memilih badge "Hasil langsung" atau
        # "Cuplikan". Satu field menggerakkan satu badge, satu renderer.
        "sumber": "cadangan",
        "total": d["total"],
        "tutup": bool(d.get("tutup", False)),
    }


def tanpa_waktu(d):
    """Salinan tanpa `dibuat`, untuk membandingkan isi yang sebenarnya."""
    return {k: v for k, v in d.items() if k != "dibuat"}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    sumber = Path(sys.argv[1])
    tujuan = Path(sys.argv[2]) if len(sys.argv) > 2 else TUJUAN_BAWAAN

    try:
        mentah = json.loads(sumber.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"GAGAL membaca {sumber}: {e}", file=sys.stderr)
        return 1

    masalah = sah(mentah)
    if masalah:
        print(f"GAGAL, respons tidak sah ({masalah}). Cuplikan lama dipertahankan.", file=sys.stderr)
        return 1

    baru = bentuk(mentah)

    if tujuan.exists():
        try:
            lama = json.loads(tujuan.read_text(encoding="utf-8"))
            if tanpa_waktu(lama) == tanpa_waktu(baru):
                print(f"Tidak ada perubahan isi, {tujuan} dibiarkan apa adanya.")
                return 0
        except Exception:
            # Cuplikan lama rusak; ditimpa saja.
            pass

    tujuan.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys supaya urutan kunci stabil antar-run dan diff-nya kecil.
    # ensure_ascii=False supaya nama dan alasan berbahasa Indonesia tetap
    # terbaca langsung di GitHub, bukan jadi deretan \uXXXX.
    tujuan.write_text(
        json.dumps(baru, indent=1, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"{tujuan} disegarkan: total {baru['total']} (A {baru['hitung']['A']}, B {baru['hitung']['B']}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
