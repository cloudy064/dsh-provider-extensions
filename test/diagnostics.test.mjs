import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDiagnostic } from '../lib/diagnostics.js';

test('diagnostic writes stay valid under concurrency and rotate at 2 MiB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cline-diagnostic-'));
  const path = join(dir, 'failures.jsonl');
  try {
    await writeFile(path, 'x'.repeat(2 * 1024 * 1024));
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeDiagnostic(path, { attemptId: `test-${i}`, outcome: 'error' })));
    assert.equal((await stat(path + '.1')).size, 2 * 1024 * 1024);
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 20);
    assert.deepEqual(rows.map(r => r.attemptId), Array.from({ length: 20 }, (_, i) => `test-${i}`));
    await assert.rejects(writeDiagnostic(path, { outcome: 'x'.repeat(20000) }), /too large/);
    await writeDiagnostic(path, { attemptId: 'after-rejection' });
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 21);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
