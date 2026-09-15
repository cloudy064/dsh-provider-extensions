// Narrow, reversible compatibility patch for DSH 0.1.5-rc.1's built-in
// Models editor. Directory registration and provider CRUD remain native.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const hostDir = process.argv[2] ?? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh');
const host = createRequire(join(hostDir, 'package.json'));
const entry = host.resolve('@deepseek-ai/dsh-client-ui-settings-models');
const file = join(dirname(entry), 'client.js');
const manifest = JSON.parse(await readFile(join(dirname(entry), '../package.json'), 'utf8'));
if (manifest.version !== '0.1.5-rc.1') throw new Error('Unsupported Models version; no files changed.');
let source = await readFile(file, 'utf8');
const marker = '// cline-pass provider-editor compatibility v4';
if (source.includes(marker)) { console.log('Models compatibility already installed.'); process.exit(0); }
const backup = file + '.cline-pass-original';
const upgrading = source.includes('// cline-pass provider-editor compatibility v');
if (upgrading) {
  source = await readFile(backup, 'utf8');
  const record = JSON.parse(await readFile(file + '.cline-pass-patch.json', 'utf8'));
  if (createHash('sha256').update(source).digest('hex') !== record.originalSha256) throw new Error('Backup checksum mismatch; no files changed.');
}
const original = source;
const replace = (from, to, count) => {
  if (source.split(from).length - 1 !== count) throw new Error('Models source changed; no files changed.');
  source = source.replaceAll(from, to);
};
replace('function ProviderEditor(props) {', `${marker}
        function ProviderEditor(props) {
          if (props.namespace.ns === 'llm-cline-pass' && props.renderSlot) {
            return props.renderSlot('settings.models.provider-editor', { ...props, styles: ModelsSection_module_css_default, EditorFooter, ModelListEditor }, { entryKey: props.namespace.ns });
          }
          return (0, react_jsx_runtime.jsx)(NativeProviderEditor, props);
        }
        function NativeProviderEditor(props) {`, 1);
// All three Models editor postures carry the owner's slot dispatcher.
replace('readOnly: !state.writable,', 'renderSlot, readOnly: !state.writable,', 4);
replace('"settings.models.provider-card": {', '"settings.models.provider-editor": { kind: "keyed", scope: "root" },\n\t\t\t\t\t"settings.models.provider-card": {', 1);
replace('const addable = configurable.filter((row) => !row.configured);', 'const addable = configurable.filter((row) => !row.configured).sort((a, b) => a.entry.displayName.localeCompare(b.entry.displayName, "en"));', 1);
if (!upgrading) await copyFile(file, backup, 1); // never replace the original
await writeFile(file, source);
await writeFile(file + '.cline-pass-patch.json', JSON.stringify({ version: manifest.version, originalSha256: createHash('sha256').update(original).digest('hex'), patchedSha256: createHash('sha256').update(source).digest('hex') }, null, 2));
console.log('Installed Models provider-editor compatibility; original backed up beside client.js.');
