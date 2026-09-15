import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const host = createRequire(join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/package.json'));
const settings = host('js-yaml').load(await readFile(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'), 'settings.yaml'), 'utf8'));
const existing = settings?.['llm-cline-pass'] ?? {};
if (existing.enabled || Object.keys(existing).some(k => k !== 'enabled')) throw new Error('Lifecycle test requires an unconfigured provider; preserving existing settings.');
let url;
for (let i = 0; i < 50 && !url; i++) {
  const logs = await readFile('.cache/dsh-web.stdout.log', 'utf8') + await readFile('.cache/dsh-web.stderr.log', 'utf8');
  url = logs.match(/http:\/\/127\.0\.0\.1:18089\/\?token=[^\s]+/)?.[0];
  if (!url) await new Promise(r => setTimeout(r, 1000));
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const openModels = async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('dialog').getByText('模型', { exact: true }).click();
  };
  await page.goto(url); await openModels();
  const dialog = page.getByRole('dialog');
  const add = async () => {
    await dialog.getByRole('button', { name: /^(添加提供方|Add provider)$/ }).click();
    const select = dialog.getByRole('combobox', { name: /^(提供方|Provider)$/ });
    const names = await select.locator('option').allTextContents();
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
    const position = names.indexOf('cline-pass');
    assert.equal(names[position - 1], 'cerebras');
    assert.equal(names[position + 1], 'cloudflare-ai-gateway');
    await select.selectOption('anthropic');
    const nativeInput = await dialog.getByLabel('API 密钥', { exact: true }).getAttribute('class');
    const nativeSave = await dialog.getByRole('button', { name: '保存', exact: true }).getAttribute('class');
    await select.selectOption('cline-pass');
    assert.equal(await dialog.getByLabel('API 密钥', { exact: true }).getAttribute('class'), nativeInput);
    assert.equal(await dialog.getByRole('button', { name: '保存', exact: true }).getAttribute('class'), nativeSave);
    try { await page.getByLabel('API 密钥').waitFor({ timeout: 8000 }); }
    catch (e) { console.log('Browser errors:', errors); await page.screenshot({ path: '.cache/gui-failure.png' }); throw e; }
    assert.equal(await page.getByRole('button', { name: '添加 ClinePass', exact: true }).count(), 0);
    assert.equal(await dialog.locator('input[type=password]').count(), 1);
  };
  await add();
  await page.locator('[data-cline-pass-settings]').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: /^编辑 cline-pass/ }).count(), 0);
  await add();
  const editor = page.locator('[data-cline-pass-settings]');
  await editor.locator('summary').click();
  await editor.getByRole('button', { name: '获取可用模型', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择要添加的模型', exact: true });
  await picker.waitFor();
  const choices = picker.locator('input[type=checkbox]');
  assert.ok(await choices.count() > 1);
  await picker.getByRole('button', { name: '添加所选', exact: true }).click();
  const chosenModels = await editor.getByRole('textbox', { name: /^模型 ID \d+$/ }).count();
  assert.ok(chosenModels > 0);
  await editor.getByLabel('请求超时（毫秒）', { exact: true }).fill('45678');
  await editor.locator('summary').click();
  await page.locator('[data-cline-pass-settings]').getByRole('button', { name: '保存', exact: true }).click();
  const edit = dialog.getByRole('button', { name: /^编辑 cline-pass/ });
  await edit.waitFor();
  assert.equal(await page.getByLabel('API 密钥').count(), 0);
  await page.reload(); await openModels(); await edit.waitFor();
  assert.equal(await page.getByLabel('API 密钥').count(), 0);
  await edit.click();
  await page.getByLabel('API 密钥').waitFor();
  await editor.locator('summary').click();
  assert.equal(await editor.getByRole('textbox', { name: /^模型 ID \d+$/ }).count(), chosenModels);
  assert.equal(await editor.getByLabel('请求超时（毫秒）', { exact: true }).inputValue(), '45678');
  await page.locator('[data-cline-pass-settings]').getByRole('button', { name: '取消', exact: true }).click();
  await dialog.getByRole('button', { name: /^删除 cline-pass/ }).click();
  const confirmation = page.getByRole('dialog', { name: /^删除 cline-pass/ });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await edit.waitFor();
  await dialog.getByRole('button', { name: /^删除 cline-pass/ }).click();
  await confirmation.getByRole('button', { name: /^删除 cline-pass/ }).click();
  await edit.waitFor({ state: 'detached' });
  await add();
  await page.locator('[data-cline-pass-settings]').locator('..').screenshot({ path: '.cache/gui-native-editor.png' });
  await page.locator('[data-cline-pass-settings]').getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: alphabetic cline-pass option, editor, public model catalog, model/settings persistence, cancel, apply, collapsed reload, edit, delete and re-add. No API key or inference used. Final state: absent.');
} finally { await browser.close(); }
