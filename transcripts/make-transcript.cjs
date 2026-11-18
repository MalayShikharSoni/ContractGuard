#!/usr/bin/env node
/**
 * make-transcript.cjs — export an OpenCode chat session from the local session
 * store into this repo's transcripts/ folder.
 *
 *   node --experimental-sqlite transcripts/make-transcript.cjs <sessionID>
 *
 * Produces, per session:
 *   transcripts/<date>-<slug>.md          human-readable transcript
 *                                         (user + assistant prose verbatim,
 *                                          tool calls as one-line summaries,
 *                                          model reasoning omitted)
 *   transcripts/<date>-<slug>.raw.json    verbatim export of every message
 *                                         (including reasoning and tool I/O)
 *
 * The session store lives at ~/.local/share/opencode/opencode.db (SQLite).
 * This script reads it through a snapshot copy, so it never touches the live
 * database, and works while OpenCode is running.
 * Needs Node >= 22.5 (node:sqlite) and OpenCode's local session store.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION = process.argv[2];
if (!SESSION || !SESSION.startsWith('ses_')) {
  console.error('usage: node --experimental-sqlite transcripts/make-transcript.cjs <sessionID>');
  console.error("the current session's id is printed by OpenCode as $env:OPENCODE_SESSION_ID");
  process.exit(1);
}

const OUT_DIR = __dirname;

// 1. snapshot the live store so we never read/write the real db concurrently
const store = path.join(os.homedir(), '.local', 'share', 'opencode');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-snap-'));
for (const f of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
  const src = path.join(store, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
}
const db = new DatabaseSync(path.join(tmp, 'opencode.db'), { readOnly: true });

// 2. load session + messages
const session = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(SESSION);
if (!session) {
  console.error(`session ${SESSION} not found in ${store}`);
  process.exit(1);
}
const messages = db
  .prepare('SELECT seq, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq')
  .all(SESSION);

const rows = messages; // all rows already materialised; safe to close the snapshot now
db.close();
fs.rmSync(tmp, { recursive: true, force: true });

// 3. verbatim raw JSON
const raw = {
  exported_at: new Date().toISOString(),
  session: {
    id: session.id,
    title: session.title,
    slug: session.slug,
    directory: session.directory,
    model: session.model,
    agent: session.agent,
    cost: session.cost,
    tokens: {
      input: session.tokens_input,
      output: session.tokens_output,
      reasoning: session.tokens_reasoning,
      cache_read: session.tokens_cache_read,
      cache_write: session.tokens_cache_write,
    },
    time: { created: session.time_created, updated: session.time_updated },
  },
  messages: messages.map((m) => ({ seq: m.seq, type: m.type, time_created: m.time_created, data: JSON.parse(m.data) })),
};
const date = new Date(session.time_created).toISOString().slice(0, 10);
const base = `${date}-${session.slug || 'session'}`;
fs.writeFileSync(path.join(OUT_DIR, `${base}.raw.json`), JSON.stringify(raw, null, 2));

// 4. readable markdown
const fmtTime = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const sessionModel = typeof session.model === 'string' ? JSON.parse(session.model) : session.model || {};
const oneLine = (s, n = 220) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
const toolSummary = (part) => {
  const input = part.state?.input || {};
  const detail =
    input.command || input.path || input.file_path || input.url || input.pattern || input.query || input.description ||
    (input.body ? String(input.body) : '') ||
    Object.values(input)[0] || '';
  const status = part.state?.status ? ` *(${part.state.status})*` : '';
  return `> 🔧 \`${part.name}\` — ${oneLine(detail)}${status}`;
};

const L = [];
L.push(`# Transcript — ${session.title}`);
L.push('');
L.push('| | |');
L.push('| --- | --- |');
L.push(`| Session | \`${session.id}\` (slug: ${session.slug}) |`);
L.push(`| Started | ${fmtTime(session.time_created)} |`);
L.push(`| Model | ${sessionModel.providerID ?? '?'}/${sessionModel.id ?? sessionModel.modelID ?? '?'} · agent: ${session.agent ?? 'build'} |`);
L.push(`| Messages | ${messages.length} in the raw export |`);
L.push(`| Generated | ${fmtTime(Date.now())} from the local OpenCode session store |`);
L.push('');
L.push('**About this transcript.** User and assistant prose is verbatim. Tool calls are summarised');
L.push('as one-liners (their full inputs/outputs live in the companion `.raw.json`). Model reasoning');
L.push('and harness-injected bookkeeping (system/idle/compaction records) are omitted here but kept');
L.push('in the raw export.');
L.push('');
L.push('---');
L.push('');

for (const m of messages) {
  if (m.type === 'idle' || m.type === 'compaction' || m.type === 'system') continue;
  const d = JSON.parse(m.data);
  if (m.type === 'user') {
    L.push(`## User <sub>${fmtTime(m.time_created)}</sub>`);
    L.push('');
    const text = d.text ?? '';
    // harness-injected checkpoint/system-reminder blocks get collapsed
    if (/^<conversation-checkpoint>|<system-reminder>/.test(text.trim())) {
      L.push('<details><summary>harness context block (verbatim inside)</summary>');
      L.push('');
      L.push('```');
      L.push(text.trim());
      L.push('```');
      L.push('');
      L.push('</details>');
    } else {
      L.push(text.trim());
    }
    L.push('');
  } else if (m.type === 'assistant') {
    for (const c of d.content || []) {
      if (c.type === 'text' && c.text?.trim()) {
        L.push(`## Assistant <sub>${fmtTime(m.time_created)}</sub>`);
        L.push('');
        L.push(c.text.trim());
        L.push('');
      } else if (c.type === 'tool') {
        L.push(toolSummary(c));
        L.push('');
      }
      // reasoning omitted from the readable transcript on purpose
    }
  }
}

fs.writeFileSync(path.join(OUT_DIR, `${base}.md`), L.join('\n'));
console.log(`wrote transcripts/${base}.md`);
console.log(`wrote transcripts/${base}.raw.json`);
