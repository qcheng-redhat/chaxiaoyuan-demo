/*
 * Playwright config — Tea Courtyard E2E tests.
 *
 * Starts the real server.js on port 3780 with an isolated data directory
 * and a test-only admin password, so tests never touch data/orders.json.
 *
 * Run:   npx playwright test
 * Debug: npx playwright test --ui      (or --headed to watch the browser)
 */
'use strict';

module.exports = {
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3780',
    headless: true,
    viewport: { width: 1280, height: 800 }
  },
  webServer: {
    command: 'node server.js',
    port: 3780,
    reuseExistingServer: false,
    timeout: 15000,
    env: Object.assign({}, process.env, {
      PORT: '3780',
      DATA_DIR: '.playwright-data',
      ADMIN_PASSWORD: 'test-pass-123'
    })
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true
      }
    }
  ]
};
