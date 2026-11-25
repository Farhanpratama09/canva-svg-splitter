import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Canva SVG Splitter",
    short_name: "SVG Splitter",
    description:
      "Pecah ilustrasi 2D datar dan vektor SVG menjadi layer terpisah yang siap diedit warnanya di Canva Free, 100% client-side.",
    start_url: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#10b981",
    orientation: "any",
    categories: ["design", "graphics", "utilities"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
