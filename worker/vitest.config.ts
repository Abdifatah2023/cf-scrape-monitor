import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.join(import.meta.dirname, "wrangler.toml") },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            REQUEST_DELAY_MS: "0",
            RUN_TOKEN: "test-token",
          },
        },
      }),
    ],
    test: {
      root: path.join(import.meta.dirname, ".."),
      include: ["test/**/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
    },
  };
});
