import { config } from './config.js';
import { query } from './db.js';

/**
 * Fire-and-forget webhook notification (chat/email stand-in from the kit).
 * Never blocks or fails the pipeline: delivery problems are logged in the
 * notifications table so the UI can show whether the platform leads were told.
 */
export async function notify(event, payload) {
  if (!config.webhookUrl) return { sent: false, reason: 'WEBHOOK_URL not configured' };
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), ...payload });
  let statusCode = null;
  let error = null;
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    statusCode = res.status;
    if (!res.ok) error = `webhook responded ${res.status}`;
  } catch (err) {
    error = err?.message || String(err);
  }
  try {
    await query('INSERT INTO notifications (attempt_id, event, url, status_code, error) VALUES ($1,$2,$3,$4,$5)', [
      payload.attempt_id ?? null,
      event,
      config.webhookUrl,
      statusCode,
      error,
    ]);
  } catch (dbErr) {
    console.error('[notify] could not record notification:', dbErr.message);
  }
  if (error) console.error(`[notify] ${event} delivery problem: ${error}`);
  return { sent: !error, status_code: statusCode, error };
}
