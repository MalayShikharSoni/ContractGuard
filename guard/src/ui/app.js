/* Contract Guard UI - vanilla JS, hash routing, no build step. */
'use strict';

const app = document.getElementById('app');

/* ------------------------------- utilities ------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(body?.error || `${res.status} ${res.statusText}`);
    err.body = body;
    err.status = res.status;
    throw err;
  }
  return body;
}

function chip(sev) { return `<span class="chip ${esc(sev)}">${esc(sev)}</span>`; }
function chipCount(sev, n) {
  return n ? `<span class="chip ${esc(sev)}" title="${esc(sev)}">${esc(sev)} ${n}</span>` : '';
}
function badge(status) { return `<span class="badge ${esc(status)}">${esc(status)}</span>`; }

function countsChips(counts) {
  if (!counts) return '';
  return ['DANGEROUS', 'WARNING', 'DEPRECATED', 'SAFE'].map((s) => chipCount(s, counts[s] || 0)).join(' ');
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function changeRow(c) {
  const affected = (c.affected || [])
    .map((a) => `<span class="chip consumer" title="${esc(a.usage)}${a.via?.length ? ' · ' + esc(a.via.join('; ')) : ''}">${esc(a.consumer)}</span>`)
    .join(' ');
  return `
    <div class="change ${esc(c.severity)}">
      <div class="spread">
        <div>
          ${chip(c.severity)} <span class="loc">${esc(c.location || locOf(c))}</span>
        </div>
        <span class="small muted">${esc(c.kind)}</span>
      </div>
      <div class="note">${esc(c.note || '')}</div>
      ${affected ? `<div class="meta"><span class="small muted">affects</span> ${affected}</div>` : ''}
    </div>`;
}

function locOf(c) {
  if (c.endpointKey) {
    if (c.path) return `${c.endpoint} · ${c.locationLabel || c.direction} · ${c.path}`;
    if (c.name) return `${c.endpoint} · ${c.location} param ${c.name}`;
    return c.endpoint;
  }
  return c.path || c.name || c.kind;
}

function groupChanges(changes) {
  const groups = new Map();
  for (const c of changes) {
    const key = c.endpoint || '(spec level)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return groups;
}

function renderChanges(changes) {
  if (!changes.length) return '<div class="empty">No changes - the wire contract is identical.</div>';
  const groups = groupChanges(changes);
  let html = '';
  for (const [ep, list] of groups) {
    const internal = list.some((c) => c.internal);
    html += `<div class="endpoint-group">${esc(ep)}${internal ? ' <span class="chip internal">x-internal</span>' : ''}</div>`;
    html += list.map(changeRow).join('');
  }
  return html;
}

/* --------------------------------- router --------------------------------- */

const routes = [
  { re: /^#\/$/, view: viewServices, nav: 'services' },
  { re: /^#\/services\/([\w.-]+)$/, view: viewService, nav: 'services' },
  { re: /^#\/diff/, view: viewDiff, nav: 'diff' },
  { re: /^#\/impact/, view: viewImpact, nav: 'impact' },
  { re: /^#\/consumers/, view: viewConsumers, nav: 'consumers' },
];

async function route() {
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) {
      document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.nav));
      app.innerHTML = '<div class="loading">Loading…</div>';
      try {
        await r.view(...m.slice(1));
      } catch (err) {
        app.innerHTML = `<div class="card notice err"><strong>${esc(err.message)}</strong></div>`;
      }
      return;
    }
  }
  app.innerHTML = '<div class="card">Page not found.</div>';
}

window.addEventListener('hashchange', route);

/* ------------------------------ services list ----------------------------- */

async function viewServices() {
  const [services, health] = await Promise.all([api('/services'), api('/health')]);
  document.getElementById('health').textContent = `db ok · webhook ${health.webhook}`;
  app.innerHTML = `
    <h1>Services</h1>
    <p class="sub">Every registered API, its owner and where its contract stands. Click a service for versions, attempts and consumers.</p>
    <div class="grid cols3">
      ${services
        .map(
          (s) => `
        <div class="card">
          <div class="spread">
            <h3 style="margin:0"><a href="#/services/${esc(s.slug)}">${esc(s.name)}</a></h3>
            ${s.current_version ? `<span class="chip SAFE">v${esc(s.current_version)}</span>` : '<span class="badge DRAFT">no version</span>'}
          </div>
          <div class="small muted" style="margin:6px 0 10px">${esc(s.owner_team)}${s.owner_contact ? ' · ' + esc(s.owner_contact) : ''}</div>
          <div class="small">
            <span class="chip count">${s.version_count} version${s.version_count === 1 ? '' : 's'}</span>
            <span class="chip count">${s.consumer_count} consumer${s.consumer_count === 1 ? '' : 's'}</span>
            ${s.last_attempt_status ? badge(s.last_attempt_status) : ''}
          </div>
          <div style="margin-top:12px"><a class="btn small" href="#/services/${esc(s.slug)}">Open</a></div>
        </div>`
        )
        .join('')}
    </div>
    <details style="margin-top:18px">
      <summary>Register another service</summary>
      <div class="card">
        <div class="row">
          <div><label>slug</label><input id="sv-slug" placeholder="pricing-api"></div>
          <div><label>name</label><input id="sv-name" placeholder="Pricing API"></div>
          <div><label>owner team</label><input id="sv-owner" placeholder="Pricing team"></div>
        </div>
        <div class="row">
          <div><label>owner contact</label><input id="sv-contact" placeholder="pricing-team@corp.example"></div>
          <div style="flex:2"><label>description</label><input id="sv-desc" placeholder="What this API does"></div>
        </div>
        <div class="actions"><button class="btn primary" id="sv-save">Register service</button><span id="sv-msg" class="small"></span></div>
      </div>
    </details>`;
  document.getElementById('sv-save').onclick = async () => {
    try {
      await api('/services', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: val('sv-slug'), name: val('sv-name'), owner_team: val('sv-owner'),
          owner_contact: val('sv-contact'), description: val('sv-desc'),
        }),
      });
      route();
    } catch (err) { set('sv-msg', err.message); }
  };
}

const val = (id) => document.getElementById(id)?.value.trim() || '';
const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

/* ------------------------------ service detail ---------------------------- */

async function viewService(slug) {
  const d = await api(`/services/${slug}`);
  const { service, versions, attempts, usages, current } = d;

  const endpointRows = (current?.flat?.endpoints || [])
    .map(
      (e) => `
      <tr>
        <td class="mono"><strong>${esc(e.method)}</strong> ${esc(e.path)}${e.internal ? ' <span class="chip internal">x-internal</span>' : ''}${e.deprecated ? ' <span class="chip DEPRECATED">deprecated</span>' : ''}</td>
        <td class="small muted">${esc(e.summary || e.operationId || '')}</td>
        <td class="small mono">${e.pathParams.map((p) => esc(p.name)).join(', ') || '—'}</td>
        <td class="small mono">${e.queryParams.map((p) => esc(p.name) + (p.required ? '*' : '')).join(', ') || '—'}</td>
      </tr>`
    )
    .join('');

  const versionRows = versions
    .slice()
    .reverse()
    .map(
      (v) => `
      <tr>
        <td class="mono"><strong>v${esc(v.version)}</strong>${service.current_version_id === v.id ? ' <span class="chip SAFE">current</span>' : ''}</td>
        <td class="small muted">#${v.revision} · ${fmtTime(v.created_at)}</td>
        <td>${countsChips(v.counts)}</td>
        <td><details><summary>changes</summary>${renderChanges(v.changes || [])}</details></td>
      </tr>`
    )
    .join('');

  const attemptRows = attempts
    .map(
      (a) => `
      <tr>
        <td class="small muted">#${a.attempt_no}</td>
        <td>${badge(a.status)}</td>
        <td class="mono small">${esc(a.from_version || '—')} → ${esc(a.to_version || '—')}</td>
        <td>${countsChips(a.counts)}</td>
        <td class="small muted">${fmtTime(a.created_at)}</td>
        <td class="small">
          ${a.status === 'ERROR' ? `<span class="chip ERROR">${esc(a.error_stage || 'error')}</span> <span class="muted">${esc(a.error_message || '')}</span>` : ''}
          ${(a.impact?.consumers || []).length ? `affects: ${(a.impact.consumers).map((c) => `<span class="chip consumer">${esc(c.consumer)}</span>`).join(' ')}` : '<span class="muted">no consumers affected</span>'}
          ${a.notified ? '<span class="small muted" title="webhook notification sent"> · notified ✓</span>' : ''}
          <details><summary>details</summary>${renderChanges(a.changes || [])}</details>
        </td>
      </tr>`
    )
    .join('');

  const unmatched = await api('/metrics');
  const unmatchedForService = unmatched.unmatchedUsages.filter((u) => u.provider === slug);

  const usageRows = usages
    .map(
      (u) => `
      <tr>
        <td><span class="chip consumer">${esc(u.consumer)}</span> <span class="small muted">${esc(u.consumer_team)}</span></td>
        <td class="mono small"><strong>${esc(u.method)}</strong> ${esc(u.path)}</td>
        <td class="mono small">${(u.sends || []).map(esc).join('<br>') || '—'}</td>
        <td class="mono small">${(u.reads || []).map(esc).join('<br>') || '—'}</td>
      </tr>`
    )
    .join('');

  app.innerHTML = `
    <div class="spread">
      <div>
        <h1>${esc(service.name)} <span class="muted mono" style="font-size:13px">${esc(service.slug)}</span></h1>
        <p class="sub">${esc(service.description || '')}</p>
      </div>
      <div>${current ? `<span class="chip SAFE" style="font-size:13px">current v${esc(current.version)}</span>` : ''}</div>
    </div>
    <div class="card">
      <div class="kv">
        <div class="k">Owner</div><div>${esc(service.owner_team)}</div>
        <div class="k">Contact</div><div>${esc(service.owner_contact || '—')}</div>
        <div class="k">Versions</div><div>${versions.map((v) => `<a href="#/diff" title="open in diff">v${esc(v.version)}</a>`).join(' · ') || '—'}</div>
      </div>
    </div>

    <h2>Publish a new version</h2>
    <div class="card">
      <p class="small muted">Paste or upload the next OpenAPI YAML. Contract Guard diffs it against the current version,
      checks every registered consumer and refuses to publish dangerous changes (the attempt is recorded either way).</p>
      <label>Specification (YAML)</label>
      <textarea id="pb-yaml" rows="10" placeholder="openapi: 3.0.3 ..."></textarea>
      <div class="actions">
        <button class="btn" id="pb-preview">Preview result</button>
        <button class="btn primary" id="pb-publish">Publish</button>
        <input type="file" id="pb-file" accept=".yaml,.yml,.json" style="width:auto">
        <span id="pb-msg" class="small"></span>
      </div>
      <div id="pb-result"></div>
    </div>

    <h2>Current endpoints ${current ? `(v${esc(current.version)})` : ''}</h2>
    ${current ? `<table class="wrap"><tr><th>Endpoint</th><th>Summary</th><th>Path params</th><th>Query params</th></tr>${endpointRows}</table>` : '<div class="empty">No version published yet.</div>'}

    <h2>Version history &amp; changelog</h2>
    ${versions.length ? `<table class="wrap"><tr><th>Version</th><th>Published</th><th>Findings</th><th>Changes vs previous</th></tr>${versionRows}</table>` : '<div class="empty">Nothing published yet.</div>'}

    <h2>Publish attempts</h2>
    <p class="small muted">Every attempt is kept - published, blocked or failed - with the full analysis and who would have been affected.</p>
    ${attempts.length ? `<table class="wrap"><tr><th>#</th><th>Result</th><th>From → To</th><th>Findings</th><th>When</th><th>Impact</th></tr>${attemptRows}</table>` : '<div class="empty">No attempts yet.</div>'}

    <h2>Consumers of this API</h2>
    ${unmatchedForService.length ? `<div class="notice warn small">Declared usages that match no endpoint of the current spec (check method/path): ${unmatchedForService.map((u) => `${esc(u.consumer)} ${esc(u.usage)}`).join(', ')}</div>` : ''}
    ${usages.length ? `<table class="wrap"><tr><th>Consumer</th><th>Call</th><th>Sends</th><th>Reads</th></tr>${usageRows}</table>` : '<div class="empty">No consumer has registered usage of this API yet.</div>'}
  `;

  // wire publish controls
  const fileInput = document.getElementById('pb-file');
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (f) document.getElementById('pb-yaml').value = await f.text();
  };
  document.getElementById('pb-preview').onclick = async () => {
    const yaml = document.getElementById('pb-yaml').value;
    set('pb-msg', 'analysing…');
    try {
      const r = await api(`/services/${slug}/preview`, { method: 'POST', headers: { 'content-type': 'text/yaml' }, body: yaml });
      document.getElementById('pb-result').innerHTML = resultNotice(r, true);
      set('pb-msg', '');
    } catch (err) {
      document.getElementById('pb-result').innerHTML = errNotice(err);
      set('pb-msg', '');
    }
  };
  document.getElementById('pb-publish').onclick = async () => {
    const yaml = document.getElementById('pb-yaml').value;
    set('pb-msg', 'publishing…');
    try {
      const r = await api(`/services/${slug}/publish`, { method: 'POST', headers: { 'content-type': 'text/yaml' }, body: yaml });
      document.getElementById('pb-result').innerHTML = resultNotice(r, false);
      set('pb-msg', '');
    } catch (err) {
      document.getElementById('pb-result').innerHTML = errNotice(err);
      set('pb-msg', '');
    }
  };
}

function resultNotice(r, preview) {
  const head = preview
    ? `<strong>${esc(r.would_be)}</strong> if published now (preview only, nothing recorded)`
    : `<strong>${esc(r.status)}</strong> — ${esc(r.reason)}`;
  const consumers = (r.impact?.consumers || []).length
    ? r.impact.consumers.map((c) => `<span class="chip consumer">${esc(c.consumer)}</span>`).join(' ')
    : '<span class="muted">none registered</span>';
  const unmatched = (r.impact?.unmatched || []).length
    ? `<div class="small muted" style="margin-top:4px">unmatched usages: ${r.impact.unmatched.map((u) => esc(`${u.consumer} ${u.usage}`)).join(', ')}</div>`
    : '';
  return `
    <div class="notice ${r.status === 'PUBLISHED' || r.would_be === 'PUBLISHED' ? 'ok' : r.status === 'BLOCKED' || r.would_be === 'BLOCKED' ? 'err' : 'warn'}">
      ${head}<br>
      <span class="small">${r.from_version ? `v${esc(r.from_version)} → ` : ''}v${esc(r.to_version)} · ${chipCount('DANGEROUS', r.counts.DANGEROUS)} ${chipCount('WARNING', r.counts.WARNING)} ${chipCount('DEPRECATED', r.counts.DEPRECATED)} ${chipCount('SAFE', r.counts.SAFE)}</span>
      <div class="small" style="margin-top:6px">Affected consumers: ${consumers}</div>
      ${unmatched}
      <details><summary>all findings</summary>${renderChanges(r.changes || [])}</details>
      ${r.summary ? `<details><summary>notification preview</summary><pre class="raw" style="background:#111826">${esc(r.summary)}</pre></details>` : ''}
    </div>`;
}

function errNotice(err) {
  const b = err.body || {};
  return `
    <div class="notice err">
      <strong>Publish refused (fail safe)</strong> — the guard could not verify this spec, so nothing was published or recorded as valid.<br>
      <span class="small muted">${esc(b.stage ? `stage: ${b.stage}` : '')} ${esc(b.error || err.message)}</span>
      ${b.brokenRefs ? `<pre class="raw">broken $refs:\n${esc(b.brokenRefs.join('\n'))}</pre>` : ''}
      ${b.problems ? `<pre class="raw">${esc(b.problems.join('\n'))}</pre>` : ''}
    </div>`;
}

/* ---------------------------------- diff ---------------------------------- */

async function viewDiff() {
  const services = await api('/services');
  app.innerHTML = `
    <h1>Diff two versions</h1>
    <p class="sub">Compare what the API accepts and returns between any two published versions - file organisation is ignored.</p>
    <div class="card">
      <div class="row">
        <div><label>Service</label><select id="df-svc">${services.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('')}</select></div>
        <div><label>From</label><select id="df-from"></select></div>
        <div><label>To</label><select id="df-to"></select></div>
        <div style="flex:0"><button class="btn primary" id="df-run" style="margin-top:22px">Run diff</button></div>
      </div>
      <div id="df-msg" class="small"></div>
    </div>
    <div id="df-out"></div>

    <h2>Check a candidate spec</h2>
    <div class="card">
      <p class="small muted">Upload a spec that is <em>not</em> registered yet and see exactly what it would change and who it would affect. Nothing is recorded.</p>
      <label>Candidate YAML (compared against the service's current version)</label>
      <textarea id="df-cand" rows="8" placeholder="openapi: 3.0.3 ..."></textarea>
      <div class="actions">
        <button class="btn" id="df-cand-run">Analyse candidate</button>
        <input type="file" id="df-cand-file" accept=".yaml,.yml,.json" style="width:auto">
        <span id="df-cand-msg" class="small"></span>
      </div>
      <div id="df-cand-out"></div>
    </div>`;

  const svcSel = document.getElementById('df-svc');
  const fromSel = document.getElementById('df-from');
  const toSel = document.getElementById('df-to');

  async function fillVersions() {
    const versions = await api(`/services/${svcSel.value}/versions`);
    const opts = versions.map((v) => `<option value="${esc(v.version)}">v${esc(v.version)}</option>`).join('');
    fromSel.innerHTML = opts;
    toSel.innerHTML = opts;
    if (versions.length > 1) toSel.selectedIndex = versions.length - 1;
  }
  svcSel.onchange = fillVersions;
  await fillVersions();

  document.getElementById('df-run').onclick = async () => {
    set('df-msg', 'diffing…');
    try {
      const r = await api(`/services/${svcSel.value}/diff?from=${encodeURIComponent(fromSel.value)}&to=${encodeURIComponent(toSel.value)}`);
      document.getElementById('df-out').innerHTML = `
        <div class="card">
          <div class="spread">
            <h3 style="margin:0">${esc(r.service)}: v${esc(r.from_version)} → v${esc(r.to_version)}</h3>
            <span>${badge(r.verdict === 'BLOCKED' ? 'BLOCKED' : 'PUBLISHED')}</span>
          </div>
          <div style="margin:8px 0">${countsChips(r.counts)} <span class="small muted">${esc(r.reason)}</span></div>
          ${(r.impact.consumers || []).length ? `<div class="small">affected consumers: ${r.impact.consumers.map((c) => `<span class="chip consumer">${esc(c.consumer)}</span>`).join(' ')}</div>` : '<div class="small muted">no registered consumers affected</div>'}
          ${renderChanges(r.changes)}
        </div>`;
      set('df-msg', '');
    } catch (err) { set('df-msg', err.message); }
  };

  const file = document.getElementById('df-cand-file');
  file.onchange = async () => { const f = file.files[0]; if (f) document.getElementById('df-cand').value = await f.text(); };
  document.getElementById('df-cand-run').onclick = async () => {
    set('df-cand-msg', 'analysing…');
    try {
      const r = await api(`/services/${svcSel.value}/preview`, {
        method: 'POST', headers: { 'content-type': 'text/yaml' }, body: document.getElementById('df-cand').value,
      });
      document.getElementById('df-cand-out').innerHTML = resultNotice(r, true);
      set('df-cand-msg', '');
    } catch (err) {
      document.getElementById('df-cand-out').innerHTML = errNotice(err);
      set('df-cand-msg', '');
    }
  };
}

/* ---------------------------------- impact --------------------------------- */

async function viewImpact() {
  const m = await api('/metrics');
  const events = await api('/events');
  const t = m.totals;
  const sev = m.severityTotals;
  const totalSev = Math.max(1, Object.values(sev).reduce((a, b) => a + b, 0));
  const sevColors = { DANGEROUS: '#c62828', WARNING: '#f0a500', DEPRECATED: '#8e44d0', SAFE: '#4caf72' };

  app.innerHTML = `
    <h1>Impact &amp; metrics</h1>
    <p class="sub">Registry-wide view: what changed, what it would affect, and what the guard stopped.</p>

    <div class="grid cols4">
      <div class="stat"><div class="n">${t.services}</div><div class="l">services</div></div>
      <div class="stat"><div class="n">${t.versions}</div><div class="l">published versions</div></div>
      <div class="stat"><div class="n">${t.consumers}</div><div class="l">consumers</div></div>
      <div class="stat"><div class="n">${t.usages}</div><div class="l">registered usages</div></div>
    </div>

    <div class="grid cols4" style="margin-top:14px">
      <div class="stat"><div class="n">${t.published}</div><div class="l">publishes allowed</div></div>
      <div class="stat"><div class="n" style="color:var(--danger)">${t.blocked}</div><div class="l">publishes blocked</div></div>
      <div class="stat"><div class="n" style="color:var(--err)">${t.errors}</div><div class="l">failed analyses</div></div>
      <div class="stat"><div class="n">${m.unmatchedUsages.length}</div><div class="l">unmatched usages</div></div>
    </div>

    <h2>Findings across all attempts</h2>
    <div class="card">
      <div class="bar">${Object.entries(sev).map(([k, v]) => `<div title="${k}: ${v}" style="width:${(v / totalSev) * 100}%;background:${sevColors[k]}"></div>`).join('')}</div>
      <div style="margin-top:8px">${countsChips(sev)}</div>
    </div>

    <h2>Most affected consumers</h2>
    ${m.affectedConsumersTop.length ? `<table class="wrap"><tr><th>Consumer</th><th>Team</th><th>Findings that touched them</th></tr>${m.affectedConsumersTop.map((c) => `<tr><td><span class="chip consumer">${esc(c.consumer)}</span></td><td class="small muted">${esc(c.team)}</td><td>${c.findings}</td></tr>`).join('')}</table>` : '<div class="empty">No consumer has been affected so far.</div>'}

    <h2>Per service</h2>
    <table class="wrap">
      <tr><th>Service</th><th>Owner</th><th>Current</th><th>Versions</th><th>Blocked attempts</th><th>Usages</th></tr>
      ${m.perService
        .map(
          (s) => `<tr>
            <td><a href="#/services/${esc(s.slug)}">${esc(s.name)}</a></td>
            <td class="small muted">${esc(s.owner_team)}</td>
            <td class="mono small">${s.current_version ? 'v' + esc(s.current_version) : '—'}</td>
            <td>${s.versions}</td>
            <td>${s.blocked_attempts ? `<span class="chip BLOCKED">${s.blocked_attempts}</span>` : '0'}</td>
            <td>${s.usages}</td>
          </tr>`
        )
        .join('')}
    </table>

    <h2>Recent publish attempts</h2>
    <table class="wrap">
      <tr><th>Service</th><th>Result</th><th>From → To</th><th>Findings</th><th>When</th></tr>
      ${m.recentAttempts
        .map(
          (a) => `<tr>
            <td><a href="#/services/${esc(a.service)}">${esc(a.service_name)}</a></td>
            <td>${badge(a.status)}${a.error_stage ? ` <span class="chip ERROR">${esc(a.error_stage)}</span>` : ''}</td>
            <td class="mono small">${esc(a.from_version || '—')} → ${esc(a.to_version || '—')}</td>
            <td>${countsChips(a.counts)}${a.error_message ? `<div class="small muted">${esc(a.error_message)}</div>` : ''}</td>
            <td class="small muted">${fmtTime(a.created_at)}</td>
          </tr>`
        )
        .join('')}
    </table>

    ${m.unmatchedUsages.length ? `
    <h2>Unmatched consumer usages</h2>
    <div class="notice warn small">These declared usages match no endpoint of the provider's current spec. Either the consumer file is stale or the provider renamed/removed the route - worth reconciling.</div>
    <table class="wrap"><tr><th>Consumer</th><th>Provider</th><th>Declares</th></tr>
      ${m.unmatchedUsages.map((u) => `<tr><td><span class="chip consumer">${esc(u.consumer)}</span></td><td>${esc(u.provider)}</td><td class="mono small">${esc(u.usage)}</td></tr>`).join('')}
    </table>` : ''}

    <h2>Notification log (webhook)</h2>
    ${events.length ? `<table class="wrap"><tr><th>Event</th><th>Service</th><th>Delivered</th><th>When</th></tr>${events.map((e) => `<tr><td class="mono small">${esc(e.event)}</td><td>${esc(e.service || '—')}</td><td>${e.error ? `<span class="chip ERROR">failed</span> <span class="small muted">${esc(e.error)}</span>` : `<span class="chip SAFE">ok</span>`}</td><td class="small muted">${fmtTime(e.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">No notifications sent yet.</div>'}
  `;
}

/* --------------------------------- consumers -------------------------------- */

async function viewConsumers() {
  const [consumers, services] = await Promise.all([api('/consumers'), api('/services')]);
  app.innerHTML = `
    <h1>Consumers</h1>
    <p class="sub">Services that call other APIs register what they use - the routes they call, the fields they send and read. Impact analysis is only as good as these registrations.</p>

    <details open>
      <summary>Register a consumer</summary>
      <div class="card">
        <div class="row">
          <div><label>slug</label><input id="cn-slug" placeholder="invoice-svc"></div>
          <div><label>name</label><input id="cn-name" placeholder="Invoice Service"></div>
          <div><label>team</label><input id="cn-team" placeholder="Billing"></div>
          <div><label>contact</label><input id="cn-contact" placeholder="billing@corp.example"></div>
        </div>
        <div class="actions"><button class="btn primary" id="cn-save">Register</button><span id="cn-msg" class="small"></span></div>
      </div>
    </details>

    <details open style="margin-top:10px">
      <summary>Declare a usage</summary>
      <div class="card">
        <div class="row">
          <div><label>Consumer</label><select id="us-consumer">${consumers.map((c) => `<option value="${esc(c.slug)}">${esc(c.slug)}</option>`).join('')}</select></div>
          <div><label>Provider</label><select id="us-provider">${services.map((s) => `<option value="${esc(s.slug)}">${esc(s.slug)}</option>`).join('')}</select></div>
          <div><label>Method</label><select id="us-method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'].map((m) => `<option>${m}</option>`).join('')}</select></div>
          <div><label>Path (template)</label><input id="us-path" placeholder="/quotes/{id}"></div>
        </div>
        <div class="row">
          <div><label>Sends (comma-separated field paths)</label><input id="us-sends" placeholder="vehicle.make, rider.age, id"></div>
          <div><label>Reads</label><input id="us-reads" placeholder="quoteId, premium.total"></div>
        </div>
        <div class="actions"><button class="btn primary" id="us-save">Save usage</button><span id="us-msg" class="small"></span></div>
      </div>
    </details>

    ${consumers
      .map(
        (c) => `
      <h2>${esc(c.name)} <span class="muted mono" style="font-size:12px">${esc(c.team)}</span></h2>
      <table class="wrap">
        <tr><th>Provider</th><th>Call</th><th>Sends</th><th>Reads</th><th></th></tr>
        ${c.usages.length
          ? c.usages
              .map(
                (u) => `<tr>
                  <td><a href="#/services/${esc(u.provider)}">${esc(u.provider)}</a></td>
                  <td class="mono small"><strong>${esc(u.method)}</strong> ${esc(u.path)}</td>
                  <td class="mono small">${(u.sends || []).map(esc).join('<br>') || '—'}</td>
                  <td class="mono small">${(u.reads || []).map(esc).join('<br>') || '—'}</td>
                  <td><button class="btn small" data-del="${u.id}">remove</button></td>
                </tr>`
              )
              .join('')
          : '<tr><td colspan="5" class="empty">No usages declared.</td></tr>'}
      </table>`
      )
      .join('')}`;

  document.getElementById('cn-save').onclick = async () => {
    try {
      await api('/consumers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: val('cn-slug'), name: val('cn-name'), team: val('cn-team'), contact: val('cn-contact') }),
      });
      route();
    } catch (err) { set('cn-msg', err.message); }
  };
  document.getElementById('us-save').onclick = async () => {
    try {
      await api(`/consumers/${val('us-consumer')}/usages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: val('us-provider'), method: val('us-method'), path: val('us-path'),
          sends: val('us-sends').split(',').map((s) => s.trim()).filter(Boolean),
          reads: val('us-reads').split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      route();
    } catch (err) { set('us-msg', err.message); }
  };
  app.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/usages/${btn.dataset.del}`, { method: 'DELETE' });
      route();
    };
  });
}

/* ---------------------------------- boot ---------------------------------- */

route();
