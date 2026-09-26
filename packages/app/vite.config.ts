import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The engine worker starts the CPU workers itself, so workers must be ES modules.
  worker: { format: "es" },
});
