import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { initSchema, close } from './db.js';
import { api } from './routes.js';
import { seedIfEmpty } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
// Specs can be big-ish; 5MB is a generous ceiling for one OpenAPI document.
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ limit: '5mb', type: ['text/yaml', 'application/yaml', 'application/x-yaml', 'text/plain'] }));

app.use('/api', api);

// Static UI (vanilla, no build step).
const uiDir = path.join(__dirname, 'ui');
if (fs.existsSync(uiDir)) {
  app.use(express.static(uiDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(uiDir, 'index.html')));
}

// Last-resort error handler (outside /api too).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

async function main() {
  await initSchema();
  await seedIfEmpty().catch((err) => {
    // Seeding must never stop the registry from serving.
    console.error('[seed] failed:', err.message);
  });
  app.listen(config.port, () => {
    console.log(`contract-guard listening on :${config.port}`);
    if (config.webhookUrl) console.log(`webhook notifications -> ${config.webhookUrl}`);
  });
}

main().catch(async (err) => {
  console.error('fatal startup error:', err);
  await close().catch(() => {});
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await close().catch(() => {});
    process.exit(0);
  });
}
