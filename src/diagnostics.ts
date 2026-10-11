import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Diagnostic } from './adapter.js';

const queues = new Map<string, Promise<void>>();
const MAX_BYTES = 2 * 1024 * 1024;

/** One active log plus one rotated log; serialized across plugin remounts. */
export function writeDiagnostic(path: string, event: Diagnostic): Promise<void> {
  const line = JSON.stringify({ version: 1, ...event }) + '\n';
  // Refuse unexpectedly oversized records rather than writing partial JSON.
  if (Buffer.byteLength(line) > 16384) return Promise.reject(new Error('Diagnostic record too large'));
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const size = await stat(path).then(value => value.size, error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    if (size + Buffer.byteLength(line) > MAX_BYTES) await rename(path, path + '.1');
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  });
  queues.set(path, next);
  void next.finally(() => { if (queues.get(path) === next) queues.delete(path); }).catch(() => {});
  return next;
}
