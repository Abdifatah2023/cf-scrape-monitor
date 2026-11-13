/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    USER_AGENT: string;
    REQUEST_DELAY_MS?: string;
    RUN_TOKEN?: string;
    ALERT_WEBHOOK_URL?: string;
    ALERT_CHANGE_THRESHOLD?: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}

declare module "*.html?raw" {
  const html: string;
  export default html;
}
