import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { ClinePassAdapter, parseCatalog } from '../lib/adapter.js';
import { BASE_URL, resolveConfig, subscriptionModel } from '../lib/config.js';
import { attributionHeaders, MessageId } from '@deepseek-ai/dsh-llm';

const args = process.argv.slice(2);
const argument = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--catalog')) {
  const res = await fetch(`${BASE_URL}/ai/cline/recommended-models`, { headers: attributionHeaders(), signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  console.log(JSON.stringify(parseCatalog(await res.json()), null, 2));
} else if (!args.includes('--live')) {
  console.log('Usage: npm run probe -- --catalog\nLive (uses subscription quota): npm run probe -- --live --model cline-pass/MODEL [--upstream SLUG]\nReads CLINEPASS_API_KEY from the environment. Writes a sanitized report under reports/.');
} else {
  const key = process.env.CLINEPASS_API_KEY;
  if (!key) throw new Error('Set CLINEPASS_API_KEY locally before running --live. Do not paste it into chat.');
  const model = subscriptionModel(argument('--model') ?? '');
  const upstream = argument('--upstream');
  const report = { createdAt: new Date().toISOString(), model, upstream, routingVerified: false, calls: [], conclusion: '' };
  const session = randomUUID();
  // Identical, synthetic prefix above common cache thresholds. No workspace content is sent.
  const prompt = 'Read the following reference; reply only OK.\n' + Array.from({ length: 220 }, (_, i) => `Reference ${i}: preserve stable routing and identical request prefixes across repeated calls.`).join('\n');
  const messages = [{ id: MessageId('probe-user'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }];
  const plans = [ ['default', undefined, 2], ['sticky', undefined, 2],
    ...(upstream ? [['experimental-pin', upstream, 2]] : []),
    ['experimental-pin', `nonexistent-dsh-probe-${randomUUID()}`, 1] ];
  for (const [routing, slug, repeats] of plans) {
    for (let i = 0; i < repeats; i++) {
      let event;
      const adapter = new ClinePassAdapter({ config: () => resolveConfig({ routing, upstream: slug, timeoutMs: 120000 }), apiKey: async () => key, diagnostic: value => { event = value; } });
      let errorCode, status;
      try {
        for await (const chunk of adapter.stream({ provider: 'cline-pass', model, sessionId: `${session}:${routing}:${slug ?? ''}`, messages, maxTokens: 64 })) { /* Consume without printing model text. */ }
      } catch (error) { errorCode = error.code ?? 'UNKNOWN'; status = error.failure?.status; }
      const result = { mode: slug?.startsWith('nonexistent-') ? 'invalid-upstream-control' : routing, iteration: i + 1, ...event, errorCode, status };
      report.calls.push(result);
      console.log(JSON.stringify(result));
      if (['AUTH', 'SUBSCRIPTION_REQUIRED', 'RATE_LIMIT'].includes(errorCode)) break;
    }
    if (report.calls.some(c => ['AUTH', 'SUBSCRIPTION_REQUIRED', 'RATE_LIMIT'].includes(c.errorCode))) break;
  }
  const control = report.calls.find(c => c.mode === 'invalid-upstream-control');
  report.conclusion = !control ? 'Probe incomplete; routing remains unverified.' : !control.errorCode
    ? 'Invalid upstream succeeded: allowlist is not enforced as requested. Do not treat pinning as working.'
    : 'Invalid upstream failed. This alone does not prove pinning; inspect baseline success and authoritative upstream evidence.';
  await mkdir('reports', { recursive: true });
  const file = `reports/routing-${Date.now()}.json`;
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`${report.conclusion}\nReport: ${file}`);
}
