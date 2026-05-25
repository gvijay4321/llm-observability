// One-shot Playwright runner: regenerates eval-page.png and eval-infographic.png
// from the latest eval JSON. Dev server must be running at localhost:3000.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { renderInfographic } from './eval/infographic.js';
import type { PromptResult } from './eval/run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

interface EvalRun {
  generatedAt: string;
  judge: { provider: string; model: string } | null;
  results: PromptResult[];
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // 1. In-app eval page
  await page.goto('http://localhost:3000/eval', { waitUntil: 'networkidle' });
  await page.waitForSelector('.eval-tile', { timeout: 10_000 });
  await page.waitForTimeout(400);
  const evalOut = resolve(REPO_ROOT, 'docs/screenshots/eval-page.png');
  await mkdir(dirname(evalOut), { recursive: true });
  await page.screenshot({ path: evalOut, fullPage: true });
  process.stdout.write(`wrote ${evalOut}\n`);

  // 2. Standalone infographic — regenerate HTML from latest JSON so it
  // reflects the current renderInfographic() code.
  const jsonPath = resolve(REPO_ROOT, 'apps/chatbot/public/eval-latest.json');
  const json = JSON.parse(await readFile(jsonPath, 'utf8')) as EvalRun;
  const html = renderInfographic({
    results: json.results,
    judge: json.judge as { provider: 'gemini'; model: string } | null,
  });
  const tmpPath = resolve(REPO_ROOT, 'eval-results/_screenshot.html');
  await writeFile(tmpPath, html);
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.goto(`file:///${tmpPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const infoOut = resolve(REPO_ROOT, 'docs/screenshots/eval-infographic.png');
  await page.screenshot({ path: infoOut, fullPage: true });
  process.stdout.write(`wrote ${infoOut}\n`);

  await browser.close();
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
