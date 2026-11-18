import { config } from './config.js';
import { initSchema, close } from './db.js';
import { seedIfEmpty } from './seed.js';
import { app } from './app.js';

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
