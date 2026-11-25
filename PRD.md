# Product Requirements Document (PRD)
**Nama Proyek:** Canva SVG Splitter (`canva-svg-splitter`)  
**Versi:** 2.0  
**Target Platform:** Web App (Mobile-First, Tablet, & Desktop Browser)  
**Arsitektur:** 100% Client-Side (Next.js + TypeScript + HTML5 Canvas + Dual-Pipeline SVG/Raster Engine)

---

## 1. Latar Belakang & Masalah
Pengguna **Canva Free** tidak memiliki akses ke *Background Remover* maupun *Magic Edit*, dan fitur konversi gambar bawaan Canva hanya memecah ilustrasi 2D menjadi potongan gambar raster (PNG) datar—bukan elemen vektor (SVG) berlapis. Akibatnya, pengguna tidak bisa mengganti warna bagian ilustrasi secara terpisah (misalnya warna topi, pin bintang, kacamata, dan syal pada desain *keyring* atau stiker) menggunakan *color picker* bawaan Canva. Selain itu, kreator *merchandise* sering bekerja dengan beberapa variasi desain sekaligus, menerima file `.svg` mentah yang warnanya masih menyatu, serta membutuhkan ekspor katalog PNG/JPG beresolusi tinggi (HD).

## 2. Solusi & Tujuan Produk
Membangun aplikasi web ringan yang berjalan sepenuhnya di browser (tanpa biaya server/API AI) dengan **Dual-Pipeline (Native SVG + Raster)** untuk:
- Mengubah ilustrasi 2D datar (PNG/JPG/WEBP) menjadi file **`.svg` vektor berlapis** yang kompatibel penuh dengan **Canva Free**.
- Mem-parsing file **`.svg` native** secara langsung tanpa kehilangan ketajaman vektor aslinya agar dapat dipecah/diganti warnanya per elemen dan tetap mendukung *Tap-to-Select* di kanvas.
- Mendukung **Batch Multi-Upload** (hingga 10 desain) dengan duplikasi *colorway* dan sinkronisasi palet, serta ekspor multi-format HD (SVG Canva, PNG Transparan HD `1x–4x`, JPG Katalog HD `1x–4x`, dan paket `.zip`).

## 3. Target Pengguna & Skenario Penggunaan
- Kreator *merchandise* (desain *keyring*, stiker *die-cut*, pin akrilik) yang mengedit aset di HP, tablet, atau laptop menggunakan akun Canva Free.
- Alur kerja cepat tanpa login, tanpa instalasi aplikasi tambahan, dan tetap berjalan lancar di perangkat spesifikasi menengah.

## 4. Fitur Utama (v2.0 Scope)

### F1. Smart Image Import, Dual-Pipeline Input & Auto-Trim Background
- Mendukung unggah **PNG, JPG, WEBP, dan SVG** hingga **10 file sekaligus** (*multi-select*, *drag-and-drop*, atau tambah bertahap).
- Input raster di-downscale otomatis jika sisi terpanjang melebihi `2048px` untuk menjaga performa memori browser mobile.
- **Native SVG Passthrough:** Jika file input adalah `.svg`, aplikasi mem-parsing XML secara aman (menghapus `<script>` dan atribut `on*`), mempertahankan geometri vektor asli beserta `viewBox`, dan merasterisasi peta region offscreen untuk *Tap-to-Select*.
- **Auto Background Removal (Raster):** Mendeteksi warna latar terluar dari 4 sudut kanvas menggunakan *Flood Fill* dengan slider toleransi (*Tolerance 0–50*) untuk menghapus latar belakang tanpa merusak *border* potong (*die-cut*) putih di sekeliling karakter.

### F2. Anti-Aliasing Cleanup & Smart Color Quantization
- Membersihkan piksel transisi buram (*anti-aliasing*) di tepi garis hitam (*outline*) menggunakan *color snapping* lokal ke warna tetangga solid terdekat.
- Default **Detail Warna Awal = 4** (rentang `2–16`) agar gradasi abu-abu/hitam tipis pada ilustrasi 2D tidak terpecah berlebihan.

### F3. Interactive Region Picker (Tap-to-Split) & Batch Filmstrip
- Algoritma **Connected-Component Labeling (CCL)** (untuk raster) dan **Vector Element Mapper** (untuk native SVG) mendeteksi setiap bagian tertutup secara terpisah meski warna awalnya sama.
- Pengguna dapat mengetuk (*tap/click*) region di kanvas untuk memisahkan region ke grup warna baru, memindahkan antar grup, dan menguji pratinjau ganti warna (*Live Preview*) lengkap dengan riwayat **Undo/Redo**.
- **Filmstrip Workspace:** Mengelola hingga 10 desain dalam antrean dengan state terpisah, **Duplikat Desain** untuk membuat varian *colorway*, dan **Salin Palet ke Semua** (*Sync Palette*).

### F4. Canva Free Compatibility Guard & Auto-Compact 5 Warna
- **Batasan Sistem Canva:** Canva hanya mengaktifkan *color picker* pada `.svg` dengan **maksimal 5 warna solid unik** tanpa gradasi.
- Indikator penghitung `X / 5 Warna Canva` dan tombol aksi cepat **"Ringkas ke ≤ 5 Warna (1 File SVG)"** (`autoCompactToFiveColors`) untuk menggabungkan warna terdekat secara cerdas hingga muat dalam 1 file SVG Canva Free.
- Jika pengguna tetap memilih `> 5` grup warna, mode ekspor SVG otomatis memecah menjadi beberapa file berjangkar sudut `0.1×0.1px` (`part-1-of-N.svg`).

### F5. Chaikin Smoothing, Ekspor HD (PNG/JPG 1x–4x) & Paket `.ZIP`
- **Chaikin Corner-Cutting Smoothing** selektif (hanya menghaluskan sudut tumpul kurva sambil menjaga sudut lancip `< 75°` seperti ujung bintang & telinga kucing).
- Pilihan ekspor: **SVG (Canva Free Ready)**, **PNG Transparan HD (`1x / 2x / 4x`)**, dan **JPG Katalog HD (`1x / 2x / 4x`, dengan warna latar solid)** — dibatasi aman maksimal `4096px` pada sisi terpanjang.
- Tombol **"Unduh Semua (.ZIP)"** via `JSZip` jika hasil ekspor lebih dari 1 file (baik dari *Batch* maupun *Multi-Part SVG*).

### F6. Mobile & Tablet Touch Canvas UX
- Kanvas interaktif mendukung **Pinch-to-Zoom**, **Pan/Geser**, *Touch Guard* (`< 6px`), tombol **Reset View**, dan target sentuh minimal `44×44px`.

## 5. Edge Cases & Mitigasi
1. **File SVG Input Mengandung Skrip / CSS / Transform:** Sanitasi DOM (`<script>`, `on*`, `javascript:`), dukung bentuk dasar SVG (`<path>`, `<circle>`, `<rect>`, `<polygon>`, `<ellipse>`), dan tetap pertahankan `viewBox` asli.
2. **Detail Teks Kecil & Lubang Huruf:** Pertahankan lubang dalam huruf (`o`, `e`, `a`, `d`) dengan `fill-rule="evenodd"`.
3. **Gambar Foto Realistis (Non-2D):** Peringatan halus jika `> 64` klaster warna dominan terdeteksi.
4. **Batas Memori Browser Mobile pada Ekspor 4x:** Batasi sisi terpanjang hasil rasterisasi HD di `4096px` dan gunakan `URL.revokeObjectURL()` di seluruh siklus muat & unduh.

## 6. Kriteria Keberhasilan (Acceptance Criteria)
- File `.svg` hasil ekspor (baik dari input raster maupun native SVG) memunculkan palet kotak warna di toolbar **Canva Free** tanpa ikon mahkota Pro.
- Proses konversi gambar `1024×1024px` selesai dalam waktu **< 1.5 detik** di browser mobile.
- Nol dependensi API eksternal berbayar dan 100% privasi terjaga di browser pengguna.
