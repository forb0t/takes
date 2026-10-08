import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * pdf.js loads its standard fonts and image decoders at run time from fixed
 * URLs (`/pdfjs/...`): serve them from node_modules in development and copy
 * them into the build, instead of keeping copies in the repository.
 */
function pdfjsAssets(): Plugin {
  const root = fileURLToPath(new URL("node_modules/pdfjs-dist/", import.meta.url));
  const dirs = ["standard_fonts", "wasm"];
  // PDF scripting is never run, so its engine is left out.
  const wanted = (file: string) => !file.startsWith("quickjs");
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const [dir, file, ...rest] = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
        if (!dirs.includes(dir) || !file || rest.length > 0 || !wanted(file)) return next();
        try {
          const data = readFileSync(join(root, dir, file));
          if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
          res.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const file of readdirSync(join(root, dir)).filter(wanted)) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${file}`, source: readFileSync(join(root, dir, file)) });
        }
      }
    },
  };
}

// Tauri expects a fixed port and must not watch its own Rust sources.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
