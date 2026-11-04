import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const configured = loadEnv(mode, process.cwd(), "");
  for (const key of [
    "DATABASE_URL",
    "DATA_DIR",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "ALLOW_SIGN_UP",
  ]) {
    if (process.env[key] === undefined && configured[key] !== undefined)
      process.env[key] = configured[key];
  }
  return {
    server: { host: "0.0.0.0", port: 8080, strictPort: true },
    preview: { host: "0.0.0.0", port: 8080, strictPort: true },
    resolve: { tsconfigPaths: true },
    plugins: [tailwindcss(), tanstackStart(), viteReact()],
  };
});
