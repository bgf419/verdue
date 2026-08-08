import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function normalizedBase(value: string | undefined) {
  const candidate = value?.trim() || "/verdue/";
  if (!candidate.startsWith("/")) throw new Error("VITE_BASE_PATH must start with /");
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}

function normalizedPublicOrigin(value: string | undefined) {
  const candidate = value?.trim() || "https://bgf419.github.io/verdue/";
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("VITE_PUBLIC_ORIGIN must use HTTPS outside local development");
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

export default defineConfig(() => {
  const base = normalizedBase(process.env.VITE_BASE_PATH);
  const publicOrigin = normalizedPublicOrigin(process.env.VITE_PUBLIC_ORIGIN);
  const ogImageUrl = new URL("og.png", publicOrigin).toString();

  return {
    base,
    root: "static-site",
    publicDir: "../public",
    plugins: [
      react(),
      {
        name: "verdue-public-metadata",
        transformIndexHtml(html) {
          return html
            .replaceAll("__VERDUE_PUBLIC_ORIGIN__", publicOrigin)
            .replaceAll("__VERDUE_OG_IMAGE_URL__", ogImageUrl);
        },
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "robots.txt",
            source: `User-agent: *\nAllow: /\n\nSitemap: ${new URL("sitemap.xml", publicOrigin)}\n`,
          });
          this.emitFile({
            type: "asset",
            fileName: "sitemap.xml",
            source:
              `<?xml version="1.0" encoding="UTF-8"?>\n` +
              `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
              `  <url>\n` +
              `    <loc>${publicOrigin}</loc>\n` +
              `    <changefreq>daily</changefreq>\n` +
              `  </url>\n` +
              `</urlset>\n`,
          });
        },
      },
    ],
    build: {
      outDir: "../dist-public",
      emptyOutDir: true,
    },
  };
});
