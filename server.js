'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('./src/config');
const db = require('./src/db');
const ghl = require('./src/ghl');

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

/* ---------------- auth (lightweight, for a 2–5 agent team) ---------------- */
function sign(value) {
  return crypto.createHmac('sha256', config.cookieSecret).update(value).digest('base64url');
}
function makeToken(agent) {
  const payload = Buffer.from(JSON.stringify({ agent, ts: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readToken(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('se_auth='));
  if (!raw) return null;
  const token = decodeURIComponent(raw.slice('se_auth='.length));
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sign(payload)), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - data.ts > 30 * 24 * 3600 * 1000) return null; // 30-day expiry
    return data.agent;
  } catch { return null; }
}
function requireAuth(req, res, next) {
  const agent = readToken(req);
  if (!agent) return res.status(401).json({ error: 'Not signed in' });
  req.agent = agent;
  next();
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post('/api/login', (req, res) => {
  const { agent, password } = req.body || {};
  const known = config.agents.find(a => a.name === agent);
  // Per-agent password; falls back to APP_PASSWORD only if the agent has none configured
  const expected = known ? (known.password || config.appPassword) : null;
  if (!known || !password || !safeEqual(password, expected)) {
    return res.status(401).json({ error: 'Wrong agent or password' });
  }
  res.setHeader('Set-Cookie',
    `se_auth=${encodeURIComponent(makeToken(agent))}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
  res.json({ ok: true, agent });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'se_auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const agent = readToken(req);
  res.json({ agent: agent || null, agents: config.agents.map(a => a.name), mock: config.mock });
});

/* ---------------- queue ---------------- */
function hoursSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 3600000));
}

app.get('/api/queue', requireAuth, async (req, res) => {
  try {
    // Ownership: only show opportunities assigned to the signed-in agent's GHL user
    const { userId, error: userErr } = await ghl.resolveAgentUserId(req.agent);
    if (!userId) {
      return res.status(502).json({ error: `Cannot match you to a GoHighLevel user. ${userErr}` });
    }
    const all = await ghl.fetchQueue();
    const entries = all.filter(e =>
      e.assignedTo === userId || (config.ghl.showUnassigned && !e.assignedTo)
    ).map(e => ({ ...e, unassigned: !e.assignedTo }));
    const resumable = db.prepare(
      `SELECT * FROM sessions WHERE status IN ('paused','exited') ORDER BY started_at DESC`
    ).all();
    const resumableByOpp = new Map(resumable.map(s => [s.opportunity_id, s]));
    const activeSession = db.prepare(`SELECT * FROM sessions WHERE status='active' AND agent=? LIMIT 1`).get(req.agent);

    const list = entries.map(e => {
      const local = db.prepare(`SELECT * FROM search_log WHERE opportunity_id=?`).get(e.opportunityId);
      const lastSearch = e.tracking.lastSearchDate || (local && local.last_search_at) || null;
      const round = Math.max(e.tracking.searchRound || 0, (local && local.rounds) || 0);
      const hrs = hoursSince(lastSearch);
      const sess = resumableByOpp.get(e.opportunityId);
      const totalSteps = config.portals.length;
      const doneSteps = sess
        ? db.prepare(`SELECT COUNT(*) n FROM steps WHERE session_id=? AND status IS NOT NULL`).get(sess.id).n
        : 0;
      const crossTags = db.prepare(
        `SELECT ref FROM cross_tags WHERE opportunity_id=? AND consumed=0`
      ).all(e.opportunityId).map(r => r.ref);

      // priority: resumable first, then temperature, aging, arrival proximity, priority score
      let score = 0;
      if (sess) score += 10000;
      const temp = (e.criteria.leadTemperature || '').toLowerCase();
      score += temp === 'hot' ? 3000 : temp === 'warm' ? 1500 : 0;
      score += Math.min(hrs ?? 96, 96) * 20;            // older search = higher
      if (e.criteria.clientArriving) {
        const days = (Date.parse(e.criteria.clientArriving) - Date.now()) / 86400000;
        if (!Number.isNaN(days) && days > 0 && days < 30) score += (30 - days) * 40;
      }
      score += parseInt(e.criteria.priorityScore || '0', 10) || 0;
      if (e.stageType === 'longTerm') score -= 2000;

      return {
        ...e, lastSearch, hoursSinceSearch: hrs, round,
        resumable: sess ? { sessionId: sess.id, doneSteps, totalSteps, agent: sess.agent } : null,
        crossTags, score
      };
    }).sort((a, b) => b.score - a.score);

    res.json({ queue: list, activeSession: activeSession ? activeSession.id : null, portalCount: config.portals.length });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not load queue from GoHighLevel: ' + e.message });
  }
});

/* ---------------- sessions ---------------- */
function sessionPayload(id) {
  const s = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
  if (!s) return null;
  const steps = db.prepare(`SELECT * FROM steps WHERE session_id=? ORDER BY idx`).all(id);
  const candidates = db.prepare(`SELECT * FROM candidates WHERE session_id=? ORDER BY id`).all(id);
  const parking = db.prepare(`SELECT * FROM parking WHERE session_id=? ORDER BY id`).all(id);
  return {
    ...s,
    steps: steps.map((st, i) => ({ ...st, ...config.portals[i] ? { note: config.portals[i].note, url: config.portals[i].url, minutes: config.portals[i].minutes } : {} })),
    candidates, parking,
    estimatedMinutes: config.portals.reduce((a, p) => a + p.minutes, 0)
  };
}

app.post('/api/sessions', requireAuth, async (req, res) => {
  const { opportunityId, contactId, clientName, round, recap, resumeSessionId } = req.body || {};
  if (resumeSessionId) {
    const s = db.prepare(`SELECT * FROM sessions WHERE id=? AND status IN ('paused','exited')`).get(resumeSessionId);
    if (!s) return res.status(404).json({ error: 'Resumable session not found' });
    db.prepare(`UPDATE sessions SET status='active', agent=? WHERE id=?`).run(req.agent, s.id);
    return res.json({ session: sessionPayload(s.id) });
  }
  if (!opportunityId || !clientName) return res.status(400).json({ error: 'opportunityId and clientName required' });
  const existing = db.prepare(`SELECT id FROM sessions WHERE status='active' AND agent=?`).get(req.agent);
  if (existing) return res.status(409).json({ error: 'You already have an active session', sessionId: existing.id });

  const info = db.prepare(
    `INSERT INTO sessions (opportunity_id, contact_id, client_name, agent, round, recap) VALUES (?,?,?,?,?,?)`
  ).run(opportunityId, contactId || null, clientName, req.agent, (round || 0) + 1, recap || null);
  const id = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO steps (session_id, idx, portal) VALUES (?,?,?)`);
  config.portals.forEach((p, i) => ins.run(id, i, p.name));
  // consume cross-tags into pre-filled candidates on step 0
  const tags = db.prepare(`SELECT * FROM cross_tags WHERE opportunity_id=? AND consumed=0`).all(opportunityId);
  for (const t of tags) {
    db.prepare(`INSERT INTO candidates (session_id, step_idx, ref, comment) VALUES (?,0,?,?)`)
      .run(id, t.ref, 'Tagged from another client’s session');
    db.prepare(`UPDATE cross_tags SET consumed=1 WHERE id=?`).run(t.id);
  }
  res.json({ session: sessionPayload(id) });
});

app.get('/api/sessions/active', requireAuth, (req, res) => {
  const s = db.prepare(`SELECT id FROM sessions WHERE status='active' AND agent=?`).get(req.agent);
  res.json({ session: s ? sessionPayload(s.id) : null });
});

app.get('/api/sessions/:id', requireAuth, (req, res) => {
  const s = sessionPayload(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ session: s });
});

app.post('/api/sessions/:id/steps/:idx', requireAuth, (req, res) => {
  const { status, skipReason, seconds } = req.body || {};
  if (!['found', 'none', 'skip'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'skip' && !skipReason) return res.status(400).json({ error: 'Skip requires a reason' });
  const idx = parseInt(req.params.idx, 10);
  if (status === 'found') {
    const n = db.prepare(`SELECT COUNT(*) n FROM candidates WHERE session_id=? AND step_idx=?`).get(req.params.id, idx).n;
    if (n === 0) return res.status(400).json({ error: 'Capture at least one candidate, or mark “nothing new”.' });
  }
  db.prepare(`UPDATE steps SET status=?, skip_reason=?, completed_at=datetime('now') WHERE session_id=? AND idx=?`)
    .run(status, skipReason || null, req.params.id, idx);
  const next = idx + 1;
  db.prepare(`UPDATE sessions SET current_step=?, seconds=COALESCE(?, seconds) WHERE id=?`)
    .run(Math.min(next, config.portals.length), seconds, req.params.id);
  res.json({ session: sessionPayload(req.params.id) });
});

app.post('/api/sessions/:id/candidates', requireAuth, (req, res) => {
  const { stepIdx, ref, comment } = req.body || {};
  if (!ref || !ref.trim()) return res.status(400).json({ error: 'ref required' });
  db.prepare(`INSERT INTO candidates (session_id, step_idx, ref, comment) VALUES (?,?,?,?)`)
    .run(req.params.id, stepIdx ?? 0, ref.trim().slice(0, 500), (comment || '').slice(0, 500) || null);
  res.json({ session: sessionPayload(req.params.id) });
});

app.post('/api/candidates/:cid', requireAuth, (req, res) => {
  const { starred, comment, alsoForOpportunity, alsoForName, sessionId } = req.body || {};
  const c = db.prepare(`SELECT * FROM candidates WHERE id=?`).get(req.params.cid);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (starred !== undefined) db.prepare(`UPDATE candidates SET starred=? WHERE id=?`).run(starred ? 1 : 0, req.params.cid);
  if (comment !== undefined) db.prepare(`UPDATE candidates SET comment=? WHERE id=?`).run((comment || '').slice(0, 500), req.params.cid);
  if (alsoForOpportunity) {
    db.prepare(`UPDATE candidates SET also_for_opportunity=?, also_for_name=? WHERE id=?`)
      .run(alsoForOpportunity, alsoForName || null, req.params.cid);
    db.prepare(`INSERT INTO cross_tags (opportunity_id, ref, from_session) VALUES (?,?,?)`)
      .run(alsoForOpportunity, c.ref, sessionId || c.session_id);
  }
  res.json({ ok: true });
});

app.post('/api/sessions/:id/parking', requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  db.prepare(`INSERT INTO parking (session_id, text) VALUES (?,?)`).run(req.params.id, text.trim().slice(0, 300));
  res.json({ session: sessionPayload(req.params.id) });
});

app.post('/api/sessions/:id/pause', requireAuth, (req, res) => {
  db.prepare(`UPDATE sessions SET status='paused', seconds=COALESCE(?, seconds) WHERE id=? AND status='active'`)
    .run(req.body?.seconds, req.params.id);
  res.json({ ok: true });
});
app.post('/api/sessions/:id/resume', requireAuth, (req, res) => {
  db.prepare(`UPDATE sessions SET status='active' WHERE id=? AND status IN ('paused','exited')`).run(req.params.id);
  res.json({ session: sessionPayload(req.params.id) });
});
app.post('/api/sessions/:id/exit', requireAuth, (req, res) => {
  const { reason, seconds } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'A reason is required to exit' });
  db.prepare(`UPDATE sessions SET status='exited', exit_reason=?, seconds=COALESCE(?, seconds) WHERE id=?`)
    .run(reason, seconds, req.params.id);
  res.json({ ok: true });
});

/* ---------------- wrap-up: complete & sync to GHL ---------------- */
function fmtEuro(n) {
  const v = parseInt(n, 10);
  if (Number.isNaN(v)) return n || '';
  return v.toLocaleString('de-DE') + ' €';
}

app.post('/api/sessions/:id/complete', requireAuth, async (req, res) => {
  const { seconds, feedbackNote } = req.body || {};
  const s = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.synced) return res.json({ ok: true, alreadySynced: true });

  const steps = db.prepare(`SELECT * FROM steps WHERE session_id=? ORDER BY idx`).all(s.id);
  const candidates = db.prepare(`SELECT * FROM candidates WHERE session_id=?`).all(s.id);
  const parking = db.prepare(`SELECT * FROM parking WHERE session_id=?`).all(s.id);
  const starred = candidates.filter(c => c.starred);
  const covered = steps.filter(st => st.status === 'found' || st.status === 'none').length;
  const mins = Math.max(1, Math.round((seconds ?? s.seconds) / 60));
  const today = new Date().toISOString().slice(0, 10);

  // 1) note body
  const lines = [];
  lines.push(`SEARCH SESSION — Round ${s.round} — ${today} — ${s.agent} — ${mins} min`);
  lines.push('');
  lines.push('Portal coverage:');
  for (const st of steps) {
    const mark = st.status === 'found' ? 'candidates found' : st.status === 'none' ? 'nothing new' : st.status === 'skip' ? `SKIPPED (${st.skip_reason})` : 'not reached';
    const cands = candidates.filter(c => c.step_idx === st.idx);
    lines.push(`• ${st.portal}: ${mark}${cands.length ? ' — ' + cands.map(c => c.ref).join(' | ') : ''}`);
  }
  if (starred.length) {
    lines.push('');
    lines.push(`Shortlist sent (${starred.length}):`);
    for (const c of starred) lines.push(`★ ${c.ref}${c.comment ? ' — ' + c.comment : ''}`);
  }
  if (feedbackNote) { lines.push(''); lines.push(`Agent note: ${feedbackNote}`); }

  const results = { note: false, fields: false, stage: false, task: false, parkingTasks: 0, errors: [] };

  try {
    if (s.contact_id) {
      await ghl.createNote(s.contact_id, `Search Session — Round ${s.round}`, lines.join('\n'));
      results.note = true;
    }
  } catch (e) { results.errors.push('Note: ' + e.message); }

  try {
    const shouldMoveStage = config.ghl.autoStageMove && starred.length > 0;
    await ghl.updateOpportunity(s.opportunity_id, {
      stageId: shouldMoveStage ? config.ghl.stages.awaitingFeedback : undefined,
      fields: {
        'opportunity.se_last_search_date': new Date().toISOString(),
        'opportunity.se_search_round': String(s.round),
        'opportunity.se_portals_covered': `${covered}/${steps.length} — ${today}`,
        ...(feedbackNote ? { 'opportunity.se_search_feedback': feedbackNote } : {})
      }
    });
    results.fields = true;
    results.stage = shouldMoveStage;
  } catch (e) { results.errors.push('Opportunity update: ' + e.message); }

  try {
    if (s.contact_id) {
      const due = new Date(Date.now() + config.ghl.followUpDays * 86400000).toISOString();
      await ghl.createTask(s.contact_id, `Chase ${s.client_name} feedback on shortlist`,
        `Round ${s.round} shortlist sent ${today} (${starred.length} properties). Follow up if no reply.`, due);
      results.task = true;
      for (const p of parking) {
        await ghl.createTask(s.contact_id, p.text.slice(0, 80), `Parked during search session (${s.client_name}, Round ${s.round}): ${p.text}`,
          new Date(Date.now() + 86400000).toISOString());
        results.parkingTasks++;
      }
    }
  } catch (e) { results.errors.push('Tasks: ' + e.message); }

  // local tracking
  db.prepare(`UPDATE sessions SET status='completed', ended_at=datetime('now'), seconds=?, synced=? WHERE id=?`)
    .run(seconds ?? s.seconds, results.errors.length === 0 ? 1 : 0, s.id);
  db.prepare(`INSERT INTO search_log (opportunity_id, last_search_at, rounds) VALUES (?,?,?)
              ON CONFLICT(opportunity_id) DO UPDATE SET last_search_at=excluded.last_search_at, rounds=excluded.rounds`)
    .run(s.opportunity_id, new Date().toISOString(), s.round);

  res.json({
    ok: results.errors.length === 0,
    summary: { properties: candidates.length, starred: starred.length, covered, total: steps.length, minutes: mins },
    sync: results
  });
});

/* ---------------- misc ---------------- */
app.get('/api/portals', requireAuth, (req, res) => res.json({ portals: config.portals }));

app.get('/api/stats', requireAuth, (req, res) => {
  const today = db.prepare(`SELECT COUNT(*) n FROM sessions WHERE status='completed' AND date(ended_at)=date('now')`).get().n;
  const week = db.prepare(`SELECT COUNT(*) n FROM sessions WHERE status='completed' AND ended_at > datetime('now','-7 days')`).get().n;
  res.json({ completedToday: today, completedWeek: week });
});

app.get('/api/health', async (req, res) => {
  res.json(await ghl.healthCheck());
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------------- boot ---------------- */
(async () => {
  try {
    if (!config.mock) {
      const { created, existing } = await ghl.ensureManagedFields();
      if (created.length) console.log('Created GHL custom fields:', created.join(', '));
      console.log('GHL field check OK —', existing.length, 'managed fields present.');
    } else {
      console.log('Running in MOCK mode (GHL_MOCK=1) — no GHL token needed, sample data served.');
    }
  } catch (e) {
    console.error('WARNING: GHL setup failed at boot:', e.message);
    console.error('The app will still start; check GHL_TOKEN and scopes, then restart.');
  }
  app.listen(config.port, () => {
    console.log(`Sunny Casas Search Engine running → http://localhost:${config.port}`);
  });
})();
