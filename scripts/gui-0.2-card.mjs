// Browser acceptance for the 0.2.0 Models card.
//
// Boots the extracted DSH 0.2.0-rc.2 web host against a scratch DSH home (the
// plugin must already be installed there), captures the token URL from the
// host's own output stream, and drives the real GUI with Microsoft Edge.
//
//   node scripts/gui-0.2-card.mjs
//   DSH_GUI_HOME=C:\scratch DSH_GUI_RUNTIME=C:\host-runtime node scripts/gui-0.2-card.mjs
//
// Notes learned the hard way: Node buffers stdout when it is redirected to a
// FILE, so the boot URL is read from the host's live output stream instead, and
// killing the host needs the port owner.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const RUNTIME = process.env.DSH_GUI_RUNTIME ?? 'C:\\Users\\cloudy064\\dsh-build\\host-runtime';
const HOME = process.env.DSH_GUI_HOME ?? 'C:\\Users\\cloudy064\\dsh-build\\scratch-boot-check';
const BIN = join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(BIN)) throw new Error(`No DSH runtime at ${RUNTIME}; set DSH_GUI_RUNTIME.`);

const host = spawn(process.execPath, [BIN, 'web', '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = [];
host.stdout.on('data', chunk => output.push(String(chunk)));
host.stderr.on('data', chunk => output.push(String(chunk)));

/** Wait for the host to print its token URL. */
async function bootUrl(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = output.join('').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
    if (match) return match[0];
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`host did not report a URL; output:\n${output.join('')}`);
}

let browser;
try {
  const url = await bootUrl();
  console.log(`host booted: ${url.replace(/token=[A-Za-z0-9_-]+/, 'token=***')}`);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { console.log(`page console [${message.type()}]:`, message.text().slice(0, 300)); if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(url);
  await page.waitForTimeout(4000);
  // A first-run dialog (welcome notice / credential step) can be open and
  // modal; dismiss whatever is in the way before touching the settings nav.
  const masks = await page.locator('div[aria-hidden="true"]').count();
  if (masks > 0) {
    console.log('modal open at boot, text:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600));
    console.log('buttons:', (await page.getByRole('button').allInnerTexts()).join(' | ').replace(/\s+/g, ' '));
    await page.screenshot({ path: '.cache/gui-0.2-boot-modal.png' });
    for (const name of [/稍后配置|Configure later|跳过|Skip|知道了|Got it|继续|Continue/]) {
      const acknowledge = page.getByRole('button', { name }).first();
      if (await acknowledge.count() > 0) { await acknowledge.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
  }
  console.log('masks after dismissal:', await page.locator('div[aria-hidden="true"]').count());
  const settingsButton = page.getByRole('button', { name: /^(设置|Settings)$/ }).first();
  await settingsButton.click();
  await page.waitForTimeout(1500);
  const dialog = page.getByRole('dialog').first();
  console.log('settings dialog text:', (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 500));
  const modelsNav = dialog.getByText(/^(模型|Models)$/).first();
  await modelsNav.click();
  await page.waitForTimeout(1000);
  console.log('models page text:', (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 500));
  const addButton = dialog.getByRole('button', { name: /添加模型提供商|添加提供方|Add model provider|Add provider/ }).first();
  await addButton.click();
  await page.waitForTimeout(1500);
  const combos = await dialog.locator('select').all();
  for (const combo of combos) console.log('select label:', await combo.getAttribute('aria-label'), 'options:', (await combo.locator('option').allInnerTexts()).join(','));
  if (await page.locator('[data-cline-pass-settings]').count() === 0) {
    console.log('add-card text:', (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 900));
    await page.screenshot({ path: '.cache/gui-0.2-add-card.png' });
  }
  const providerSelect = dialog.getByRole('combobox', { name: /提供商|提供方|Provider/ }).first();
  await providerSelect.selectOption('cline-pass');
  await page.waitForTimeout(2000);
  console.log('card nodes after select:', await page.locator('[data-cline-pass-settings]').count());
  const card = page.locator('[data-cline-pass-settings]').first();
  await card.waitFor({ timeout: 20_000 });
  // A saved row renders collapsed inside <details>; the add-provider draft
  // renders open, so only expand when a summary exists.
  if (await card.locator('summary').count() > 0) await card.locator('summary').click();
  const keyInput = await card.locator('input[type=password]').count();
  console.log('card preview:', (await card.innerText()).replace(/\s+/g, ' ').slice(0, 200));
  const fetchButton = card.getByRole('button', { name: /获取可用模型|Fetch available models/ });
  console.log(`card rendered: key inputs=${keyInput}, fetch button=${await fetchButton.count()}`);
  const rpc = [];
  page.on('response', response => { if (/llm|rpc|api/i.test(response.url())) rpc.push(`${response.status()} ${response.url().slice(0, 160)}`); });
  await fetchButton.click();
  await page.waitForTimeout(8000);
  console.log('rpc responses:', rpc.slice(-10).join('\n  '));
  const options = await card.locator('.dshpe-picker input[type=checkbox]').count();
  const notice = (await card.locator('.dshpe-error').allInnerTexts()).join(' | ');
  console.log(`discovery: checkbox options=${options}, notice="${notice}"`);
  if (options === 0) console.log('host log tail:', output.join('').split('\n').slice(-12).join('\n'));
  await page.screenshot({ path: '.cache/gui-0.2-card.png' });
  const meaningful = errors.filter(message => !/favicon|Failed to load resource|401|403|password field/i.test(message));
  assert.deepEqual(meaningful, [], `browser errors: ${meaningful.join(' | ')}`);
  assert.ok(keyInput === 1, 'the card shows its own API-key input');
  assert.ok(options > 0 || /模型目录获取失败|The model catalog could not be fetched/.test(notice), 'discovery answered with models or an explicit refusal');
  console.log('PASS: the plugin card renders inside the 0.2.0 Models page.');
} finally {
  if (browser) await browser.close();
  host.kill();
  const port = output.join('').match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (port) {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('powershell', ['-NoProfile', '-Command',
        `foreach ($c in Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }`],
        { stdio: 'ignore' });
    } catch {}
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}
