import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end smoke test against the real unpacked extension.
 *
 * `channel: 'chromium'` is required because extensions do not run in the
 * headless-shell build. The test drives the options page exactly like a user
 * and then reloads it to prove data went through chrome.storage + IndexedDB.
 */

const extensionPath = path.resolve(process.cwd());

let context;
let extensionId;
let userDataDir;

test.beforeAll(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'context-drop-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

test('loads the extension and saves a text context', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);

  await expect(page).toHaveTitle(/Context Drop/);
  await expect(page.locator('#version')).toHaveText(/^v?\d+\.\d+\.\d+/);

  await page.click('details.paste summary');
  await page.fill('#text-name', 'E2E note');
  await page.fill('#text-body', 'hello from the end-to-end test');
  await page.click('#save-text');

  await expect(page.locator('#contexts .context .name')).toHaveText('E2E note');

  // Reload to prove the context was persisted, not just rendered.
  await page.reload();
  await expect(page.locator('#contexts .context .name')).toHaveText('E2E note');
  await page.close();
});

test('popup lists the saved context', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

  await expect(page.locator('#list .option .name')).toHaveText('E2E note');
  await page.close();
});
