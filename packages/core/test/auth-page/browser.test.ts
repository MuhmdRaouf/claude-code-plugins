// The key page in a real browser: only a browser decides which Origin a form POST carries (Chrome sends
// `Origin: null` under some referrer policies), so a page that passes every raw-HTTP test can still refuse its own
// form. Skips where no headless Chromium is installed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthPage, startAuthPage } from "../../src/auth-page/server.ts";
import { type Browser, findHeadlessChrome, launchBrowser } from "../support/browser.ts";
import { TEST_KEY } from "../support/fake-keystore.ts";

const chrome = typeof WebSocket === "function" ? findHeadlessChrome() : undefined;
const reason = chrome === undefined ? " (skipped: no headless Chromium; set KEYPAGE_CHROME)" : "";

describe.skipIf(chrome === undefined)(`the key page in headless Chromium${reason}`, () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser(chrome ?? "");
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("admits the form's own POST: the key is checked, saved, and the page says so", async () => {
    const checked: string[] = [];
    const saved: string[] = [];
    const page: AuthPage = await startAuthPage({
      plugin: "zai-plugin-cc",
      display: "Z.ai GLM",
      keysUrl: "https://z.ai/manage-apikey/apikey-list",
      billingUrl: "https://z.ai/manage-apikey/billing",
      storeLabel: "macOS Keychain",
      timeoutMs: 30_000,
      check: async (key) => {
        checked.push(key);
        return "accepted";
      },
      save: async (key) => {
        saved.push(key);
      },
    });
    try {
      const tab = await browser.tab();
      await tab.goto(page.url);
      await tab.evaluate("document.getElementById('key').focus()");
      await tab.type(TEST_KEY);
      await tab.navigation(() => tab.evaluate("document.querySelector('form').requestSubmit()"));
      const text = await tab.evaluate<string>("document.body.innerText");
      const status = await tab.evaluate<number>(
        "performance.getEntriesByType('navigation')[0].responseStatus",
      );
      expect(status).toBe(200);
      expect(checked).toEqual([TEST_KEY]);
      expect(saved).toEqual([TEST_KEY]);
      expect(text).toContain("Saved");
      expect(text).not.toContain(TEST_KEY);
      expect(await page.done).toBe("saved");
    } finally {
      page.close();
    }
  });
});
