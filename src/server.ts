import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200);
    response.end(JSON.stringify({ status: 'ok', service: 'checkout-rewards' }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Checkout rewards starter listening at http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close());
}
