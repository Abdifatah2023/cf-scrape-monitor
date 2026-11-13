import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file: bring the isolated test D1 up to the latest schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
