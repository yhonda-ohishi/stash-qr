import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// ビルド結果は web/dist。Worker が Workers static assets (ASSETS binding) として配る
// (worker/wrangler.toml の [assets])。
export default defineConfig({
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true },
});
