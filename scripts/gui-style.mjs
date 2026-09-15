import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const logs = await readFile('.cache/dsh-web.stdout.log', 'utf8') + await readFile('.cache/dsh-web.stderr.log', 'utf8');
const url = logs.match(/http:\/\/127\.0\.0\.1:18089\/\?token=[^\s]+/)?.[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const provider = process.argv[2] ?? 'cline-pass';
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('模型', { exact: true }).click();
  // Open a dormant native editor solely to compare its style. No writes.
  await dialog.getByRole('button', { name: '添加提供方', exact: true }).click();
  await dialog.getByRole('combobox', { name: '提供方', exact: true }).selectOption('anthropic');
  const nativeInput = await dialog.getByLabel('API 密钥', { exact: true }).getAttribute('class');
  const nativeSave = await dialog.getByRole('button', { name: '保存', exact: true }).getAttribute('class');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const existing = dialog.getByRole('button', { name: new RegExp('^编辑 ' + provider) });
  if (await existing.count()) await existing.click();
  else {
    await dialog.getByRole('button', { name: '添加提供方', exact: true }).click();
    await dialog.getByRole('combobox', { name: '提供方', exact: true }).selectOption(provider);
  }
  const editor = page.locator('[data-cline-pass-settings]');
  await editor.waitFor();
  assert.equal(await editor.getByLabel('API 密钥', { exact: true }).getAttribute('class'), nativeInput);
  assert.equal(await editor.getByRole('button', { name: '保存', exact: true }).getAttribute('class'), nativeSave);
  assert.equal(await editor.locator('details').getAttribute('open'), null);
  await editor.screenshot({ path: `.cache/gui-style-${provider}-collapsed.png` });
  await editor.getByText('自定义设置', { exact: true }).click();
  await editor.getByRole('button', { name: '获取可用模型', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择要添加的模型', exact: true });
  await picker.waitFor();
  await picker.getByPlaceholder('搜索模型', { exact: true }).fill('deepseek');
  assert.ok(await picker.locator('input[type=checkbox]').count() > 0);
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  await editor.screenshot({ path: `.cache/gui-style-${provider}-expanded.png` });
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: native input/button classes, localized labels, collapsed disclosure, native model picker and search. Cancelled all drafts; no settings or credential writes.');
} finally { await browser.close(); }
