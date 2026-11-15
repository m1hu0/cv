import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DATA_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            ADMIN_TOKEN: "test-admin-token-0123456789abcdef0123456789",
            GEMINI_KEY: "test-gemini-key",
            CONTACT_TEXT: "test contact",
            ALLOWED_ORIGIN: "http://localhost:8000",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.js"] },
  };
});
