import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Express app (REST API + static UI). Exported separately from the boot
 * logic in index.js so the HTTP layer can also be driven in-process by the
 * API test-suite (supertest) without listening, seeding or schema-init.
 */
export const app = express();

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
