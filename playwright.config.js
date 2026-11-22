import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4174';

export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL },
  webServer: {
    command: 'node scripts/dev.mjs --memory --host 127.0.0.1 --port 4174',
    url: baseURL,
    reuseExistingServer: false,
    env: { STRIPE_TEST_KEY: '', STRIPE_PRICE_STARTER: '', RETAILPILOT_HTTPS: '', RESEND_API_KEY: '', RETAILPILOT_FROM_EMAIL: '' }
  }
});
