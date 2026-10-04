import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
	root: "ui",
	plugins: [preact()],
	build: { outDir: "../dist/ui", emptyOutDir: true, sourcemap: false },
	server: { port: 5173 },
});
