import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { createApp } from './app.ts';
import { createStore } from './domain.ts';

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
const port = integerSetting('PORT', 3000, 1, 65535);
const host = process.env.HOST ?? '127.0.0.1';
if (host !== 'localhost' && isIP(host) === 0) throw new Error('HOST must be localhost or an IPv4/IPv6 address');
const store = createStore({
  milestoneEvery: integerSetting('MILESTONE_EVERY', 5, 1, Number.MAX_SAFE_INTEGER),
  discountPercent: integerSetting('DISCOUNT_PERCENT', 10, 0, 100),
});
const server = createServer(createApp(store));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.on('error', (error) => {
  console.error(`Server failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const displayHost = host.includes(':') ? `[${host}]` : host;
  console.log(`Checkout rewards listening at http://${displayHost}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    deadline.unref();
  });
}
