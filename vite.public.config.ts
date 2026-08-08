import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/verdue/",
  root: "static-site",
  publicDir: "../public",
  plugins: [react()],
  build: {
    outDir: "../dist-public",
    emptyOutDir: true,
  },
});
