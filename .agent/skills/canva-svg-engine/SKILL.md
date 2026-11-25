---
name: canva-svg-engine
description: Domain rules and client-side algorithms for Dual-Pipeline (Native SVG + 2D Raster) conversion, smart 5-color compaction, batch palette sync, and HD/ZIP exports compatible with Canva Free.
---

# Canva SVG Vectorizer & Region Splitter Engine (v2.0)

Gunakan panduan teknis ini setiap kali menulis atau memodifikasi modul pemrosesan citra (`src/lib/image-processor/*`) dan modul ekspor vektor/HD (`src/lib/svg-exporter/*`).

## 1. Aturan Mutlak Kompatibilitas Canva Free
Agar Canva Free memunculkan kotak *color picker* saat file `.svg` diunggah dan ditaruh ke kanvas:
1. **Maksimal 5 Warna Unik:** Satu file `.svg` tidak boleh mengandung lebih dari **5 nilai hex `fill` berbeda**. Jika pengguna membuat `> 5` grup warna, sediakan `autoCompactToFiveColors()` untuk meringkas menjadi 1 file, atau pecah hasil ekspor menjadi beberapa file `.svg` (maksimal 5 warna per file) dengan `viewBox` identik serta sub-path **Alignment Anchor** `0.1×0.1px` di sudut `(0,0)` dan `(width,height)` pada `<path>` pertama tiap part.
2. **Solid Hex Fill Only:** Gunakan format hex 6-digit standar (contoh: `#1A1A1A`, `#FFFFFF`, `#C8A2C8`). Dilarang menggunakan `linearGradient`, `radialGradient`, `rgba()` transparan pada `<path>` warna utama, atau `filter` SVG (`feDropShadow`, `feGaussianBlur`).
3. **No Embedded Raster:** Dilarang membungkus `<image xlink:href="data:image/png;base64,...">` di dalam `.svg`. Semua elemen wajib berupa kurva vektor `<path>`.
4. **Even-Odd Fill Rule:** Gunakan `fill-rule="evenodd"` pada `<path>` agar lubang di dalam huruf (`o`, `d`, `e`) dan bagian dalam bingkai kacamata terpotong transparan dengan benar.

## 2. Dual-Pipeline Input

### Jalur A: Native `.svg` Passthrough (`native-svg-parser.ts`)
- Jika file input berformat `.svg` (`image/svg+xml`): **jangan** lakukan raster quantization atau tracing ulang.
- Parse XML SVG memakai `DOMParser` dengan sanitasi ketat (hapus `<script>`, `<foreignObject>`, atribut `on*`, dan `javascript:` URI).
- Ekstrak elemen vektor (`<path>`, `<circle>`, `<rect>`, `<polygon>`, `<ellipse>`) ke representasi `d` path standar beserta warna `fill` hex solid dan `viewBox` asli.
- Render tiap elemen vektor dengan ID warna unik ke kanvas offscreen (`alpha = 255`, anti-aliasing dimatikan / threshold) untuk membangun `regionMap: Int32Array` sehingga *Tap-to-Select* O(1) tetap bekerja identik.
- Saat ekspor `.svg`, gunakan langsung geometri `d` vektor asli tiap grup tanpa kehilangan presisi.

### Jalur B: Pipeline Raster 4-Tahap (`PNG / JPG / WEBP`)
1. **Corner Flood-Fill Background Removal:** Baca 4 piksel sudut `(0,0)`, `(w-1,0)`, `(0,h-1)`, `(w-1,h-1)` dan jalankan BFS 4-arah dalam batas Euclidean RGB (`default tolerance = 25`) tanpa menembus border *die-cut* putih.
2. **Anti-Aliasing Color Snapping & Quantization:** Alpha snapping (`<128 → 0`, `>=128 → 255`), K-Means++ deterministik (`2–16` warna, **default `4`**), penekanan bobot piksel transisi AA, *local-neighbor snapping*, dan deteksi foto realistis (`> 64` klaster dominan).
3. **Connected-Component Labeling (CCL):** BFS `Int32Array` 4-arah + *speckle removal* (`pixelCount < 4`) yang menyerap noise ke tetangga terbesar.
4. **Contour Tracing, RDP & Chaikin Smoothing:**
   - Ekstrak loop luar dan lubang dalam dengan graf tepi terarah (*directed boundary edge graph*).
   - Terapkan **Ramer-Douglas-Peucker (RDP)** (`epsilon = 0.4–2.0`, default `0.9`).
   - Terapkan **Chaikin Corner-Cutting** ringan hanya pada sudut tumpul (`angle >= 75°`), pertahankan sudut lancip (`< 75°`) seperti bintang dan telinga kucing.
   - Gabungkan semua sub-path dalam `assignedGroupId` yang sama menjadi satu `<path fill="#HEXCODE" fill-rule="evenodd" d="..." />`.

## 3. Smart Compaction, Batch Sync & HD Raster Export
- **Auto-Compact ≤ 5 Warna (`autoCompactToFiveColors`):** Gabungkan secara iteratif pasangan grup dengan jarak Euclidean RGB terdekat (memprioritaskan grup dengan `totalPixels` terkecil) hingga `groups.length <= 5`.
- **Ekspor Raster HD (`raster-hd-exporter.ts`):** Render SVG hasil grup aktif ke `<canvas>` pada skala **`1x`**, **`2x`**, atau **`4x`**, dengan batas pengaman sisi terpanjang maksimal **`4096px`** agar aman di RAM browser mobile. Dukung **PNG Transparan** dan **JPG Katalog** (latar solid default `#FFFFFF`).
- **Arsip `.ZIP` (`JSZip`):** Jika hasil ekspor berjumlah `> 1` file (Batch atau Multi-Part SVG), bungkus menjadi satu file `.zip` di browser dan bersihkan Object URL setelah unduhan.
