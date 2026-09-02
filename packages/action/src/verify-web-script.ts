/**
 * Source of the script that captures web evidence INSIDE the target container
 * (Playwright and the browser come from the target image, not from fixowl).
 * It is written to the runner temp dir and mounted read-only.
 *
 * Exit codes: 0 = passed, 2 = failed (evidence captured), 3 = capability
 * unavailable (no Playwright in the image; the harness records "unavailable"
 * and never fails the issue for it), 1 = app never became reachable.
 */
export const VERIFY_WEB_SCRIPT_MOUNT_PATH = "/fixowl/verify-web.mjs";

export const VERIFY_WEB_SCRIPT = `import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf("--" + name);
  return index >= 0 ? args[index + 1] : undefined;
}
const url = arg("url");
const out = arg("out") ?? "/fixowl/evidence/web";
if (!url) {
  console.error("fixowl-verify-web: --url is required");
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    console.error("fixowl-verify-web: playwright is not installed in this image; web verification unavailable");
    process.exit(3);
  }
}

const deadline = Date.now() + 120_000;
let reachable = false;
let lastError = "";
while (Date.now() < deadline) {
  try {
    const response = await fetch(url);
    if (response.status < 500) {
      reachable = true;
      break;
    }
    lastError = "HTTP " + response.status;
  } catch (error) {
    lastError = String(error);
  }
  await sleep(2000);
}
if (!reachable) {
  console.error("fixowl-verify-web: app never became reachable at " + url + ": " + lastError);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
await sleep(3000);
await page.screenshot({ path: out + "/page.png", fullPage: true });
writeFileSync(out + "/console-errors.log", consoleErrors.join("\\n") + "\\n");
await browser.close();

if (consoleErrors.length > 0) {
  console.error("fixowl-verify-web: " + consoleErrors.length + " console error(s) captured");
  process.exit(2);
}
console.log("fixowl-verify-web: screenshot captured, no console errors");
`;
