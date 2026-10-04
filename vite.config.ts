import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// `npm run dev:ui` serves the Radar locally against a deployed Contrail (CONTRAIL_URL).
const api = process.env.CONTRAIL_URL ?? "https://contrail.mikey9220.workers.dev";

export default defineConfig({
	root: "ui",
	plugins: [preact()],
	build: { outDir: "../dist/ui", emptyOutDir: true, sourcemap: false },
	server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: true, ws: true } } },
});
