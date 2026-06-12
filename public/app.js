'use strict';
/* Sunny Casas Search Engine — frontend */

const $app = document.getElementById('app');
const state = {
  agent: null, agents: [], mock: false,
  queue: [], portalCount: 9,
  session: null, queueEntry: null,
  seconds: 0, timerInt: null,
  wrapupResult: null
};

/* ---------------- helpers ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000);
}
function setMode(text, locked) {
  document.getElementById('modeText').textContent = text;
  document.getElementById('modeLabel').className = 'mode' + (locked ? ' locked' : '');
}
function modal(html) {
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('show');
}
function closeModal() { document.getElementById('modalOverlay').classList.remove('show'); }
function euro(n) {
  const v = parseInt(n, 10);
  return Number.isNaN(v) ? (n || '—') : v.toLocaleString('de-DE') + ' €';
}
function icon(name, style = '') { return `<svg class="ic" style="${style}"><use href="#${name}"/></svg>`; }

/* ---------------- timer ---------------- */
function startTimer() {
  stopTimer();
  state.timerInt = setInterval(() => {
    state.seconds++;
    const el = document.getElementById('timer');
    if (el) {
      const m = String(Math.floor(state.seconds / 60)).padStart(2, '0');
      const s = String(state.seconds % 60).padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }
  }, 1000);
}
function stopTimer() { clearInterval(state.timerInt); state.timerInt = null; }

/* ---------------- login ---------------- */
function renderLogin(err) {
  setMode('Sign in', false);
  document.getElementById('logoutBtn').style.display = 'none';
  $app.innerHTML = `<div class="wrap"><div class="login-box">
    <h1>Search Engine</h1>
    <div class="sub">Locked-in property searches, synced with GoHighLevel.${state.mock ? ' <b>(demo mode)</b>' : ''}</div>
    <label>Agent</label>
    <select id="loginAgent">${state.agents.map(a => `<option>${esc(a)}</option>`).join('')}</select>
    <label>Team password</label>
    <input id="loginPass" type="password" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
    <div class="login-err" id="loginErr">${esc(err || '')}</div>
    <div style="margin-top:20px"><button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doLogin()">Sign in</button></div>
  </div></div>`;
  if (err) document.getElementById('loginErr').style.display = 'block';
}
async function doLogin() {
  try {
    const agent = document.getElementById('loginAgent').value;
    const password = document.getElementById('loginPass').value;
    const r = await api('/api/login', { method: 'POST', body: { agent, password } });
    state.agent = r.agent;
    boot();
  } catch (e) { renderLogin(e.message); }
}
async function doLogout() {
  await api('/api/logout', { method: 'POST' });
  state.agent = null;
  renderLogin();
}

/* ---------------- queue ---------------- */
function ageClass(h) { return h == null ? 'ok' : h >= 48 ? 'late' : h >= 24 ? 'warn' : 'ok'; }
function tempTag(t) {
  const x = (t || '').toLowerCase();
  if (x === 'hot') return '<span class="tag hot">Hot</span>';
  if (x === 'warm') return '<span class="tag warm">Warm</span>';
  if (x === 'cold') return '<span class="tag cold">Cold</span>';
  return '';
}
function critLine(c) {
  const bits = [];
  if (c.budgetMin || c.budgetMax) bits.push(`${euro(c.budgetMin)} – ${euro(c.budgetMax)}`);
  if (c.areas) bits.push(esc(c.areas));
  if (c.minBeds) bits.push(`${esc(c.minBeds)}+ bed${c.minBaths ? ` · ${esc(c.minBaths)}+ bath` : ''}`);
  if (c.propertyStatus) bits.push(esc(Array.isArray(c.propertyStatus) ? c.propertyStatus.join('/') : c.propertyStatus));
  if (c.clientArriving) bits.push('Arriving ' + esc(String(c.clientArriving).slice(0, 10)));
  if (c.timeline) bits.push(esc(c.timeline));
  return bits.join('<span class="sep">|</span>') || '<i>No criteria recorded — fill them in GHL</i>';
}

async function renderQueue() {
  setMode('Queue', false);
  document.getElementById('logoutBtn').style.display = '';
  document.title = 'Sunny Casas — Search Engine';
  $app.innerHTML = `<div class="wrap"><div class="loading">Loading queue from GoHighLevel…</div></div>`;
  let data;
  try {
    data = await api('/api/queue');
  } catch (e) {
    $app.innerHTML = `<div class="wrap">
      <h1>Search Queue</h1>
      <div class="err-box" style="margin-top:18px">${esc(e.message)}</div>
      <button class="btn btn-ghost btn-sm" onclick="renderQueue()">Retry</button></div>`;
    return;
  }
  state.queue = data.queue; state.portalCount = data.portalCount;

  if (data.activeSession) {
    const s = await api(`/api/sessions/${data.activeSession}`);
    state.session = s.session;
    state.queueEntry = state.queue.find(q => q.opportunityId === s.session.opportunity_id) || null;
    state.seconds = s.session.seconds;
    renderSession(); startTimer();
    return;
  }

  let stats = { completedToday: 0, completedWeek: 0 };
  try { stats = await api('/api/stats'); } catch {}

  const cards = state.queue.map((q, i) => {
    const top = i === 0;
    const h = q.hoursSinceSearch;
    const ageTxt = h == null ? '—' : h >= 48 ? Math.round(h) + 'h' : h + 'h';
    const tags = [
      tempTag(q.criteria.leadTemperature),
      `<span class="tag round">Round ${q.round + 1}</span>`,
      q.resumable ? `<span class="tag resume">Resumable</span>` : '',
      q.crossTags.length ? `<span class="tag cross">${q.crossTags.length} tagged match${q.crossTags.length > 1 ? 'es' : ''}</span>` : '',
      q.stageType === 'longTerm' ? `<span class="tag cold">Long-term</span>` : '',
      q.unassigned ? `<span class="tag cold">Unassigned</span>` : ''
    ].join(' ');
    const btn = q.resumable
      ? `<button class="btn ${top ? 'btn-primary' : 'btn-quiet btn-sm'}" onclick="openResume(${i})">Resume · step ${q.resumable.doneSteps + 1}/${q.resumable.totalSteps}</button>`
      : top
        ? `<button class="btn btn-primary" onclick="openCommit(${i})">Start session ${icon('i-arrow')}</button>`
        : `<button class="btn btn-quiet btn-sm" onclick="toast('The queue decides the order — the top card is next.')">${icon('i-lock', 'width:13px;height:13px')} Queued</button>`;
    return `<div class="qcard ${top ? 'top' : ''}">
      <div class="age ${ageClass(h)}"><div class="days">${ageTxt}</div><div class="lbl">last search</div></div>
      <div class="qinfo">
        <div class="qname">${esc(q.name)} ${tags}</div>
        <div class="qcrit">${critLine(q.criteria)}</div>
      </div>
      ${btn}
    </div>`;
  }).join('');

  $app.innerHTML = `<div class="wrap">
    <div class="eyebrow">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · ${esc(state.agent)}</div>
    <h1>Search Queue</h1>
    <div class="sub">Your clients only — opportunities in <i>Active Property Search</i> and <i>Long-Term Property Search</i> assigned to you in GoHighLevel, ordered by priority, arrival date and search age.</div>
    ${state.queue.length ? cards : `<div class="empty">No open property searches right now.<br>New opportunities entering the search stages in GHL appear here automatically.</div>`}
    <div class="statusbar">${icon('i-flag')}
      <div><b>${stats.completedToday}</b> session${stats.completedToday === 1 ? '' : 's'} completed today · <b>${stats.completedWeek}</b> this week${state.mock ? ' · <b>demo mode</b> — sample data, no GHL writes' : ''}</div>
    </div>
  </div>`;
}

/* ---------------- commit & start ---------------- */
function openCommit(i) {
  const q = state.queue[i];
  const est = 33; // refined later by per-agent average
  modal(`
    <div class="mico">${icon('i-lock')}</div>
    <h2>Commit to this session?</h2>
    <p><b>${esc(q.name)}</b> — ${critLine(q.criteria)}<br>
    ${state.portalCount} portals · estimated <b>${est} min</b><br><br>
    While locked in there is no queue, no other clients and no notifications. You can pause for a call at any moment.</p>
    <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="startSession(${i})">Start the search</button>
    <div style="margin-top:12px;text-align:center"><button class="btn btn-ghost btn-sm" onclick="closeModal()">Not now</button></div>
  `);
}
function openResume(i) {
  const q = state.queue[i];
  modal(`
    <div class="mico">${icon('i-pause')}</div>
    <h2>Resume this search?</h2>
    <p><b>${esc(q.name)}</b> — saved at step ${q.resumable.doneSteps + 1} of ${q.resumable.totalSteps}.
    You will land exactly where the session stopped.</p>
    <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="resumeSession(${q.resumable.sessionId}, ${i})">Resume session</button>
    <div style="margin-top:12px;text-align:center"><button class="btn btn-ghost btn-sm" onclick="closeModal()">Not now</button></div>
  `);
}
async function startSession(i) {
  const q = state.queue[i];
  try {
    const r = await api('/api/sessions', { method: 'POST', body: {
      opportunityId: q.opportunityId, contactId: q.contactId, clientName: q.name,
      round: q.round, recap: q.tracking.feedback || null
    }});
    state.session = r.session; state.queueEntry = q; state.seconds = r.session.seconds || 0;
    closeModal(); renderSession(); startTimer();
  } catch (e) { closeModal(); toast(e.message); }
}
async function resumeSession(sessionId, i) {
  try {
    const r = await api('/api/sessions', { method: 'POST', body: { resumeSessionId: sessionId } });
    state.session = r.session;
    state.queueEntry = state.queue[i] || state.queue.find(q => q.opportunityId === r.session.opportunity_id) || null;
    state.seconds = r.session.seconds || 0;
    closeModal(); renderSession(); startTimer();
  } catch (e) { closeModal(); toast(e.message); }
}

/* ---------------- session ---------------- */
function deepUrl(tpl) {
  const c = (state.queueEntry && state.queueEntry.criteria) || {};
  return tpl
    .replace('{minPrice}', encodeURIComponent(c.budgetMin || ''))
    .replace('{maxPrice}', encodeURIComponent(c.budgetMax || ''))
    .replace('{beds}', encodeURIComponent(c.minBeds || ''))
    .replace('{q}', encodeURIComponent(c.areas || ''));
}

function renderSession() {
  const s = state.session;
  const q = state.queueEntry;
  const c = (q && q.criteria) || {};
  setMode(`Locked in — ${s.client_name} · Round ${s.round}`, true);
  document.title = `Session · ${s.client_name} — Sunny Casas`;
  const cur = s.current_step;
  const done = s.steps.filter(st => st.status).length;
  if (cur >= s.steps.length) { renderWrapup(); return; }

  const portalRows = s.steps.map((st, idx) => {
    let cls = 'portal', ic = '', label = '';
    if (st.status === 'found') { cls += ' done'; ic = 'i-check'; label = 'candidates'; }
    else if (st.status === 'none') { cls += ' done'; ic = 'i-check'; label = 'nothing new'; }
    else if (st.status === 'skip') { cls += ' skipped'; ic = 'i-warn'; label = 'skipped'; }
    else if (idx === cur) { cls += ' current'; ic = 'i-arrow'; }
    return `<div class="${cls}">${ic ? icon(ic) : '<span style="width:15px"></span>'}<span>${esc(st.portal)}</span><span class="st">${label}</span></div>`;
  }).join('');

  const step = s.steps[cur];
  const stepCands = s.candidates.filter(cd => cd.step_idx === cur);
  const m = String(Math.floor(state.seconds / 60)).padStart(2, '0');
  const sec = String(state.seconds % 60).padStart(2, '0');
  const others = state.queue.filter(x => x.opportunityId !== s.opportunity_id).slice(0, 6);

  const critRows = [
    ['Budget', (c.budgetMin || c.budgetMax) ? `${euro(c.budgetMin)} – ${euro(c.budgetMax)}` : null],
    ['Areas', c.areas], ['Beds / Baths', (c.minBeds || c.minBaths) ? `${c.minBeds || '—'}+ / ${c.minBaths || '—'}+` : null],
    ['Type', Array.isArray(c.propertyStatus) ? c.propertyStatus.join(', ') : c.propertyStatus],
    ['Arriving', c.clientArriving ? String(c.clientArriving).slice(0, 10) : null],
    ['Contact via', c.contactMethod], ['Timeline', c.timeline]
  ].filter(r => r[1]).map(r => `<div class="crit-row"><span>${r[0]}</span><b>${esc(r[1])}</b></div>`).join('');

  $app.innerHTML = `<div class="wrap"><div class="sess-grid">
    <div>
      <div class="panel">
        <div class="ptitle">${icon('i-pin', 'width:13px;height:13px')} Client — pinned</div>
        <div class="client-name">${esc(s.client_name)}</div>
        ${critRows || '<div class="crit-row"><span>No criteria in GHL</span><b>—</b></div>'}
        ${s.recap ? `<div class="recap"><b>Round ${s.round} recap.</b> ${esc(s.recap)}</div>` : ''}
        <div class="timer">
          <div class="t" id="timer">${m}:${sec}</div>
          <div class="e">elapsed · est. ${s.estimatedMinutes} min — soft target, never blocks</div>
        </div>
      </div>
      <div class="panel parking" style="margin-top:16px">
        <div class="ptitle">${icon('i-note', 'width:13px;height:13px')} Parking lot</div>
        <input id="parkInput" placeholder="Stray thought? Park it and keep going" onkeydown="if(event.key==='Enter')park()">
        <div class="park-items">${s.parking.map(p => `<div>${icon('i-check')}<span>${esc(p.text)} — becomes a GHL task at wrap-up</span></div>`).join('')}</div>
      </div>
    </div>
    <div>
      <div class="panel">
        <div class="progress-head">
          <div class="ptitle" style="margin-bottom:0">Portal checklist</div>
          <span class="plabel">${cur + 1} of ${s.steps.length}</span>
        </div>
        <div class="progress-outer"><div class="progress-inner" style="width:${15 + (done / s.steps.length) * 85}%"></div></div>
        <div class="portal-list">${portalRows}</div>
        <div class="step-box">
          <h2>Now — ${esc(step.portal)}</h2>
          <div class="step-hint">${esc(step.note || '')}</div>
          ${step.url ? `<a class="deeplink" href="${esc(deepUrl(step.url))}" target="_blank" rel="noopener">${icon('i-ext', 'width:14px;height:14px')} Open ${esc(step.portal)}</a>` : ''}
          <div class="capture">
            <div class="clabel">Capture candidates — URL or reference</div>
            <input id="propInput" placeholder="https://…  or  Ref MLSC8808395 — press Enter" onkeydown="if(event.key==='Enter')addProp()">
            <div id="foundList">${stepCands.map(cd => fitemHtml(cd, others)).join('')}</div>
          </div>
          <div class="actions">
            <button class="btn btn-navy btn-sm" onclick="completeStep('found')">${icon('i-check', 'width:13px;height:13px')} Done — candidates found</button>
            <button class="btn btn-ghost btn-sm" onclick="completeStep('none')">${icon('i-check', 'width:13px;height:13px')} Done — nothing new</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('skipReason').classList.toggle('show')">${icon('i-warn', 'width:13px;height:13px')} Skip</button>
          </div>
          <div class="skipreason" id="skipReason">
            <select id="skipSelect">
              <option>Why skip? (required)</option>
              <option>Portal down / error</option>
              <option>No coverage in this area</option>
              <option>Client excluded this source</option>
            </select>
            <button class="btn btn-sm btn-quiet" onclick="confirmSkip()">Confirm skip</button>
          </div>
        </div>
      </div>
      <div class="sess-footer">
        <button class="btn btn-ghost btn-sm" onclick="pauseSession()">${icon('i-phone', 'width:13px;height:13px')} Take call — pause</button>
        <button class="btn btn-ghost btn-sm" onclick="openExit()">${icon('i-door', 'width:13px;height:13px')} Exit session</button>
      </div>
    </div>
  </div></div>`;
}

function fitemHtml(cd, others) {
  const opts = (others || []).map(o => `<option value="${esc(o.opportunityId)}|${esc(o.name)}">${esc(o.name)}</option>`).join('');
  const also = cd.also_for_name
    ? `<span style="margin-left:auto;font-size:11.5px;color:var(--green)">also tagged: ${esc(cd.also_for_name)}</span>`
    : (others && others.length
      ? `<select style="margin-left:auto;font-size:11.5px;border:1px solid var(--line);border-radius:7px;padding:4px 6px;font-family:inherit" onchange="alsoFits(${cd.id}, this.value)">
          <option value="">Also fits…</option>${opts}</select>` : '');
  return `<div class="fitem">${icon('i-home', 'width:14px;height:14px;color:var(--navy-light)')}<span class="ref">${esc(cd.ref)}</span>${also}</div>`;
}

async function addProp() {
  const inp = document.getElementById('propInput');
  if (!inp.value.trim()) return;
  try {
    const r = await api(`/api/sessions/${state.session.id}/candidates`, { method: 'POST',
      body: { stepIdx: state.session.current_step, ref: inp.value.trim() } });
    state.session = r.session;
    renderSession();
    document.getElementById('propInput').focus();
  } catch (e) { toast(e.message); }
}
async function alsoFits(candidateId, val) {
  if (!val) return;
  const [oppId, name] = val.split('|');
  try {
    await api(`/api/candidates/${candidateId}`, { method: 'POST',
      body: { alsoForOpportunity: oppId, alsoForName: name, sessionId: state.session.id } });
    toast(`Tagged for ${name} — it will be waiting in their next session.`);
    const r = await api(`/api/sessions/${state.session.id}`);
    state.session = r.session; renderSession();
  } catch (e) { toast(e.message); }
}
async function completeStep(status) {
  try {
    const r = await api(`/api/sessions/${state.session.id}/steps/${state.session.current_step}`, {
      method: 'POST', body: { status, seconds: state.seconds } });
    state.session = r.session;
    if (state.session.current_step >= state.session.steps.length) { stopTimer(); renderWrapup(); }
    else renderSession();
  } catch (e) { toast(e.message); }
}
async function confirmSkip() {
  const sel = document.getElementById('skipSelect');
  if (sel.selectedIndex === 0) { toast('A reason is required to skip — friction by design.'); return; }
  try {
    const r = await api(`/api/sessions/${state.session.id}/steps/${state.session.current_step}`, {
      method: 'POST', body: { status: 'skip', skipReason: sel.value, seconds: state.seconds } });
    state.session = r.session;
    if (state.session.current_step >= state.session.steps.length) { stopTimer(); renderWrapup(); }
    else renderSession();
  } catch (e) { toast(e.message); }
}
async function park() {
  const inp = document.getElementById('parkInput');
  if (!inp.value.trim()) return;
  try {
    const r = await api(`/api/sessions/${state.session.id}/parking`, { method: 'POST', body: { text: inp.value.trim() } });
    state.session = r.session; renderSession();
    toast('Parked. Back to the search — your head is clear.');
  } catch (e) { toast(e.message); }
}
async function pauseSession() {
  stopTimer();
  await api(`/api/sessions/${state.session.id}/pause`, { method: 'POST', body: { seconds: state.seconds } }).catch(() => {});
  const m = String(Math.floor(state.seconds / 60)).padStart(2, '0');
  const s = String(state.seconds % 60).padStart(2, '0');
  modal(`
    <div class="mico">${icon('i-pause')}</div>
    <h2>Paused — position saved</h2>
    <p>Timer frozen at <b>${m}:${s}</b>. Notes from the call:</p>
    <input id="pauseNote" placeholder="e.g. client can stretch the budget for a corner plot">
    <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="unpause()">Resume exactly where I was</button>
  `);
}
async function unpause() {
  const note = document.getElementById('pauseNote').value.trim();
  if (note) await api(`/api/sessions/${state.session.id}/parking`, { method: 'POST', body: { text: 'Call note: ' + note } }).catch(() => {});
  const r = await api(`/api/sessions/${state.session.id}/resume`, { method: 'POST' });
  state.session = r.session;
  closeModal(); renderSession(); startTimer();
  toast('Resumed exactly where you were.');
}
function openExit() {
  modal(`
    <div class="mico">${icon('i-door')}</div>
    <h2>Exit before finishing?</h2>
    <p>Choose a reason and this search re-enters the queue marked <b>resumable</b>, with your exact position saved.</p>
    <select id="exitSelect">
      <option>Reason (required)</option>
      <option>Urgent client matter</option>
      <option>Scheduled viewing</option>
      <option>End of working day</option>
      <option>Emergency</option>
    </select>
    <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="confirmExit()">Save &amp; exit</button>
    <div style="margin-top:12px;text-align:center"><button class="btn btn-ghost btn-sm" onclick="closeModal()">Stay locked in</button></div>
  `);
}
async function confirmExit() {
  const sel = document.getElementById('exitSelect');
  if (sel.selectedIndex === 0) { toast('Choose a reason — exits are always allowed, never silent.'); return; }
  stopTimer();
  await api(`/api/sessions/${state.session.id}/exit`, { method: 'POST', body: { reason: sel.value, seconds: state.seconds } });
  closeModal();
  toast('Saved — re-queued as resumable.');
  state.session = null;
  renderQueue();
}

/* ---------------- wrap-up ---------------- */
function renderWrapup() {
  const s = state.session;
  setMode('Wrap-up', false);
  document.title = 'Sunny Casas — Search Engine';
  const covered = s.steps.filter(st => st.status === 'found' || st.status === 'none').length;
  const mins = Math.max(1, Math.round(state.seconds / 60));

  const slist = s.candidates.length
    ? s.candidates.map(cd => `
      <div class="slitem">
        <button class="starbtn ${cd.starred ? 'on' : ''}" onclick="toggleStar(${cd.id}, this)" title="Star to include in the shortlist">${icon('i-star')}</button>
        <span class="ref">${esc(cd.ref)}</span>
        <input placeholder="One-line comment for the client (e.g. south-facing terrace, 5 min to beach)"
          value="${esc(cd.comment || '')}" onchange="setComment(${cd.id}, this.value)">
      </div>`).join('')
    : '<div style="font-size:13px;color:var(--muted);padding:8px 0">No candidates captured this round — the coverage log still syncs.</div>';

  $app.innerHTML = `<div class="wrap">
    <div class="wrapup-head">
      <div class="wico">${icon('i-check')}</div>
      <div class="eyebrow">Session complete</div>
      <h1>${esc(s.client_name)} — Round ${s.round}</h1>
      <div class="sub" style="margin:6px auto 0">Star the properties to send, add a one-line comment each, then sync.</div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${s.candidates.length}</div><div class="l">Properties captured</div></div>
      <div class="stat"><div class="n">${covered}/${s.steps.length}</div><div class="l">Portals covered</div></div>
      <div class="stat"><div class="n">${mins} min</div><div class="l">vs. ${s.estimatedMinutes} min estimate</div></div>
    </div>
    <div class="shortlist">
      <h3>Shortlist</h3>
      <div class="sh">Starred items are listed in the GHL note as the shortlist sent to the client${state.mock ? '' : ' and trigger the stage move to Awaiting Feedback'}.</div>
      ${slist}
      <input class="feedback-input" id="feedbackNote" placeholder="Optional: feedback summary for the next round (saved to SE Search Feedback in GHL)">
    </div>
    <div id="syncBox" class="sync-list">
      <h3>One tap writes everything to GoHighLevel</h3>
      <div class="sh">Note with the full portal log · SE fields updated · stage move (if shortlist) · follow-up task · parking-lot items become tasks.</div>
    </div>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-primary" id="syncBtn" onclick="completeAndSync()">Sync to GoHighLevel</button>
    </div>
    <p class="next-hint">Momentum is on your side — the queue is waiting when you are done.</p>
  </div>`;
}
async function toggleStar(id, el) {
  const on = !el.classList.contains('on');
  el.classList.toggle('on', on);
  await api(`/api/candidates/${id}`, { method: 'POST', body: { starred: on } }).catch(e => toast(e.message));
}
async function setComment(id, value) {
  await api(`/api/candidates/${id}`, { method: 'POST', body: { comment: value } }).catch(e => toast(e.message));
}
async function completeAndSync() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const fb = document.getElementById('feedbackNote').value.trim();
    const r = await api(`/api/sessions/${state.session.id}/complete`, {
      method: 'POST', body: { seconds: state.seconds, feedbackNote: fb || undefined } });
    state.wrapupResult = r;
    const box = document.getElementById('syncBox');
    const row = (ok, label) => `<div class="sync-item ${ok ? '' : 'err'}">${icon(ok ? 'i-check' : 'i-warn')}<span>${label}</span></div>`;
    box.innerHTML = `<h3>Sync result</h3>
      ${row(r.sync.note, 'Note on contact — full portal-by-portal log')}
      ${row(r.sync.fields, 'SE fields updated — Last Search Date · Search Round · Portals Covered')}
      ${r.sync.stage ? row(true, 'Stage moved — <b>Awaiting Feedback</b>') : row(true, 'Stage unchanged (no shortlist starred)')}
      ${row(r.sync.task, `Follow-up task created — due in 3 days`)}
      ${r.sync.parkingTasks ? row(true, `${r.sync.parkingTasks} parking-lot item(s) → GHL tasks`) : ''}
      ${r.sync.errors.map(e => row(false, esc(e))).join('')}`;
    btn.textContent = 'Back to queue';
    btn.disabled = false;
    btn.onclick = () => { state.session = null; renderQueue(); };
    toast(r.ok ? 'Synced to GoHighLevel.' : 'Synced with warnings — see details.');
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Retry sync';
    toast(e.message);
  }
}

/* ---------------- boot ---------------- */
async function boot() {
  const me = await api('/api/me');
  state.agents = me.agents; state.mock = me.mock;
  document.getElementById('logoutBtn').onclick = doLogout;
  if (!me.agent) { renderLogin(); return; }
  state.agent = me.agent;
  renderQueue();
}
boot();

/* expose handlers used in inline HTML */
Object.assign(window, { doLogin, doLogout, openCommit, openResume, startSession, resumeSession,
  addProp, alsoFits, completeStep, confirmSkip, park, pauseSession, unpause, openExit, confirmExit,
  toggleStar, setComment, completeAndSync, renderQueue, closeModal });
