# AGENT.md — Panduan Eksekusi & Standar Engineering (Rora)

Dokumen ini adalah aturan wajib yang harus dipatuhi selama mengembangkan proyek `canva-svg-splitter`.

## 1. Prinsip Arsitektur Utama
- **100% Client-Side Processing:** Dilarang menambahkan backend API untuk memproses gambar, database eksternal, atau panggilan LLM/AI pihak ketiga. Seluruh manipulasi piksel, *flood fill*, segmentasi region, dan pembuatan string `.svg` wajib berjalan di browser menggunakan Web APIs (`HTMLCanvasElement`, `ImageData`, `OffscreenCanvas` / Web Worker jika perlu).
- **Zero-Lock-in & Offline Ready:** Aplikasi harus tetap berfungsi penuh meskipun koneksi internet terputus setelah halaman dimuat.
- **Kepatuhan Skill:** Selalu baca dan terapkan algoritma serta aturan ekspor SVG yang tertulis di `.agent/skills/canva-svg-engine/SKILL.md`.

## 2. Alur Pengerjaan Bertahap (Incremental Development)
Jangan membangun seluruh fitur sekaligus dalam satu kali jalan. Eksekusi dan verifikasi secara bertahap:
- **Fase 1 (Foundation & Responsive Canvas):** Setup layout mobile-first, unggah gambar dengan validasi tipe/ukuran, fitur *auto-trim* background sudut kanvas, serta kontrol *pinch-to-zoom* dan *pan*.
- **Fase 2 (Pixel Quantization & CCL Engine):** Implementasi pembersih piksel *anti-aliasing* dan algoritma *Connected-Component Labeling* (CCL) untuk memisahkan region tertutup.
- **Fase 3 (Interactive Region Grouping & Live Preview):** Implementasi interaksi *tap-to-select* region di kanvas, manajemen grup warna, dan pratinjau perubahan warna real-time.
- **Fase 4 (Canva SVG Exporter & Guardrails):** Implementasi generator `<svg>` bersih dengan *Canva 5-Color Guard*, opsi *Split Multi-Layer Export*, serta pengujian unduhan file `.svg` asli.

## 3. Standar UI/UX & Anti-AI-Slop
- Hindari tampilan template generik yang penuh teks penjelasan panjang atau dekorasi tidak perlu. Gunakan antarmuka ala alat kreatif (*tool-centric workspace*): kanvas mendominasi layar (minimal 65% tinggi viewport di mobile), toolbar ringkas, dan ikon yang jelas.
- Pastikan seluruh tombol aksi di layar sentuh (HP/tablet) memiliki ukuran minimum `44x44px` dengan jarak aman agar tidak salah ketuk saat memilih detail kecil ilustrasi.
- Selalu sediakan tombol **Reset View** untuk mengembalikan posisi dan *zoom* kanvas ke tengah layar.

## 4. Keamanan & Performa
- Gunakan `URL.createObjectURL()` untuk membaca file gambar lokal dan wajib memanggil `URL.revokeObjectURL()` saat gambar diganti untuk mencegah *memory leak* di browser mobile.
- Lakukan *downscaling* otomatis pada gambar input yang melebihi `2048px` pada sisi terpanjang sebelum diproses ke `ImageData` agar perulangan piksel tetap instan (< 1.5 detik).
- Konfigurasikan *Security Headers* standar di `next.config.ts` (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).

## 5. Checklist Verifikasi Sebelum Selesai
- [ ] Tidak ada error TypeScript (`npm run build` lulus bersih).
- [ ] File `.svg` yang dihasilkan murni berisi tag `<svg>` dan `<path>` dengan atribut `fill="#HEXCODE"` solid (tanpa `<image>` base64 tersembunyi di dalamnya).
- [ ] Responsif di viewport `375x812` (mobile), `768x1024` (tablet), dan `1440x900` (desktop).
