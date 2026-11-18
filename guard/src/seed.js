import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { query } from './db.js';
import { registerService, registerConsumer, registerUsage } from './services/registry.js';
import { publish } from './services/publish.js';
import { config } from './config.js';

/**
 * First-boot import of the starter kit: registers the three provider services with
 * their owners, replays every spec version through the real publish pipeline (so
 * attempts, verdicts, changelog and notifications all exist), then registers the
 * consumer services and what they use.
 *
 * Publish order matters: all first versions, then consumers, then the remaining
 * versions - so impact analysis has consumers registered before the changes that
 * would affect them.
 */
export async function seedIfEmpty() {
  if (!config.seedDir || !config.seedOnBoot) return;
  const specsDir = path.join(config.seedDir, 'specs');
  const consumersDir = path.join(config.seedDir, 'consumers');
  if (!fs.existsSync(specsDir)) {
    console.log(`[seed] no specs dir at ${specsDir} - skipping seed`);
    return;
  }
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM services');
  if (rows[0].n > 0) {
    console.log('[seed] services already registered - skipping seed');
    return;
  }

  console.log('[seed] importing starter kit...');
  const serviceDirs = fs
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const registered = [];
  for (const dir of serviceDirs) {
    const files = fs
      .readdirSync(path.join(specsDir, dir))
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();
    if (!files.length) continue;

    const firstText = fs.readFileSync(path.join(specsDir, dir, files[0]), 'utf8');
    const firstDoc = yaml.load(firstText);
    const owner = extractOwner(firstDoc?.info?.description) || 'unknown team';
    const slug = dir;
    try {
      await registerService({
        slug,
        name: firstDoc?.info?.title || slug,
        owner_team: owner,
        owner_contact: null,
        description: firstDoc?.info?.description || null,
      });
      registered.push({ slug, files });
      console.log(`[seed] service ${slug} registered (owner: ${owner})`);
    } catch (err) {
      console.error(`[seed] could not register ${slug}: ${err.message}`);
      continue;
    }

    const service = (await query('SELECT * FROM services WHERE slug = $1', [slug])).rows[0];
    await tryPublish(service, firstText, files[0]);
  }

  // Consumers register before later versions so impact analysis covers them.
  if (fs.existsSync(consumersDir)) {
    for (const file of fs.readdirSync(consumersDir).filter((f) => f.endsWith('.yaml')).sort()) {
      try {
        const doc = yaml.load(fs.readFileSync(path.join(consumersDir, file), 'utf8'));
        const slug = doc.consumer;
        await registerConsumer({ slug, name: slug, team: doc.team || slug, contact: doc.contact || null });
        let n = 0;
        for (const use of doc.uses || []) {
          await registerUsage(slug, {
            provider: use.provider,
            method: use.method,
            path: use.path,
            sends: use.sends || [],
            reads: use.reads || [],
            note: use.note || null,
          });
          n++;
        }
        console.log(`[seed] consumer ${slug} registered with ${n} usage(s)`);
      } catch (err) {
        console.error(`[seed] consumer file ${file} failed: ${err.message}`);
      }
    }
  }

  // Remaining versions, in file order, through the same guarded pipeline.
  for (const { slug, files } of registered) {
    const service = (await query('SELECT * FROM services WHERE slug = $1', [slug])).rows[0];
    if (!service) continue;
    for (const file of files.slice(1)) {
      const text = fs.readFileSync(path.join(config.seedDir, 'specs', slug, file), 'utf8');
      await tryPublish(service, text, file);
    }
  }
  console.log('[seed] done');
}

async function tryPublish(service, text, label) {
  try {
    const result = await publish(service, text);
    const tag =
      result.status === 'PUBLISHED'
        ? `published ${result.from_version || 'new'} -> ${result.to_version}`
        : `BLOCKED ${result.from_version} -> ${result.to_version}`;
    console.log(`[seed] ${service.slug}: ${label} ${tag} (D:${result.counts.DANGEROUS} W:${result.counts.WARNING})`);
  } catch (err) {
    if (err.status === 422) {
      console.log(`[seed] ${service.slug}: ${label} refused at stage ${err.extra?.stage}: ${err.message}`);
    } else {
      console.error(`[seed] ${service.slug}: ${label} unexpected error: ${err.message}`);
    }
  }
}

function extractOwner(description) {
  if (!description) return null;
  const m = /Owner:\s*([^.]+)/i.exec(description);
  return m ? m[1].trim() : null;
}
