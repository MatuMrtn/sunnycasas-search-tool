'use strict';
/**
 * GoHighLevel API v2 client (Private Integration token, Version 2021-07-28).
 * Endpoint shapes verified against marketplace.gohighlevel.com/docs (June 2026):
 *  - GET  /opportunities/search?location_id&pipeline_id&pipeline_stage_id&status&limit&page
 *  - PUT  /opportunities/:id           body { pipelineStageId?, customFields: [{id, field_value}] }
 *  - POST /contacts/:id/notes          body { title?, body }
 *  - POST /contacts/:id/tasks          body { title, body?, dueDate(ISO), completed }
 *  - GET  /locations/:id/customFields?model=opportunity
 *  - POST /locations/:id/customFields  body { name, dataType, model }
 */
const config = require('./config');
const mock = require('./mock');

const H = () => ({
  Authorization: `Bearer ${config.ghl.token}`,
  Version: config.ghl.version,
  'Content-Type': 'application/json',
  Accept: 'application/json'
});

async function api(method, path, { query, body } = {}) {
  const url = new URL(config.ghl.baseUrl + path);
  if (query) Object.entries(query).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, v));
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
      if (res.status === 429) { // rate limited — back off and retry
        await new Promise(r => setTimeout(r, attempt * 1200));
        continue;
      }
      const text = await res.text();
      let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok) {
        const msg = json.message || json.error || res.statusText;
        const err = new Error(`GHL ${method} ${path} → ${res.status}: ${Array.isArray(msg) ? msg.join('; ') : msg}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500) throw e; // don't retry client errors
      await new Promise(r => setTimeout(r, attempt * 800));
    }
  }
  throw lastErr;
}

/* ---------------- custom field registry ---------------- */
let fieldCache = { byKey: new Map(), byId: new Map(), fetchedAt: 0 };

async function loadFields(force = false) {
  if (config.mock) return mock.loadFields(fieldCache);
  if (!force && Date.now() - fieldCache.fetchedAt < 10 * 60 * 1000 && fieldCache.byKey.size) return fieldCache;
  const json = await api('GET', `/locations/${config.ghl.locationId}/customFields`, { query: { model: 'all' } });
  const byKey = new Map(), byId = new Map();
  for (const f of json.customFields || []) {
    byKey.set(f.fieldKey, f);
    byId.set(f.id, f);
  }
  fieldCache = { byKey, byId, fetchedAt: Date.now() };
  return fieldCache;
}

/** Create the app-managed opportunity fields if they don't exist yet. */
async function ensureManagedFields() {
  if (config.mock) return { created: [], existing: config.ghl.managedFields.map(f => f.key) };
  const fields = await loadFields(true);
  const created = [], existing = [];
  for (const mf of config.ghl.managedFields) {
    // GHL derives the fieldKey from the name; match on either our expected key or the name
    const found = fields.byKey.get(mf.key) ||
      [...fields.byKey.values()].find(f => f.model === 'opportunity' && f.name === mf.name);
    if (found) { existing.push(found.fieldKey); continue; }
    await api('POST', `/locations/${config.ghl.locationId}/customFields`, {
      body: { name: mf.name, dataType: mf.dataType, model: 'opportunity' }
    });
    created.push(mf.name);
  }
  if (created.length) await loadFields(true);
  return { created, existing };
}

function resolveFieldId(keyOrName) {
  const f = fieldCache.byKey.get(keyOrName) ||
    [...fieldCache.byKey.values()].find(x => x.name === keyOrName);
  return f ? f.id : null;
}

/* ---------------- opportunities ---------------- */
function cfValue(opp, fieldId) {
  const cf = (opp.customFields || []).find(c => c.id === fieldId);
  if (!cf) return null;
  return cf.fieldValue ?? cf.field_value ?? cf.fieldValueString ?? cf.value ?? null;
}

async function searchStage(stageId) {
  if (config.mock) return mock.searchStage(stageId);
  const out = [];
  let page = 1;
  for (;;) {
    const json = await api('GET', '/opportunities/search', {
      query: {
        location_id: config.ghl.locationId,
        pipeline_id: config.ghl.pipelineId,
        pipeline_stage_id: stageId,
        status: 'open',
        limit: 100,
        page
      }
    });
    const batch = json.opportunities || [];
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 10) break; // safety
  }
  return out;
}

/** Fetch both search stages and map to queue entries with parsed criteria. */
async function fetchQueue() {
  await loadFields();
  const K = config.ghl.criteriaFieldKeys;
  const id = {};
  for (const [k, key] of Object.entries(K)) id[k] = resolveFieldId(key);
  const managedId = {};
  for (const mf of config.ghl.managedFields) managedId[mf.key] = resolveFieldId(mf.key) || resolveFieldId(mf.name);

  const [active, longTerm] = await Promise.all([
    searchStage(config.ghl.stages.activeSearch),
    searchStage(config.ghl.stages.longTermSearch)
  ]);

  const mapOpp = (opp, stageType) => ({
    opportunityId: opp.id,
    contactId: opp.contactId || (opp.contact && opp.contact.id) || null,
    name: opp.name || (opp.contact && opp.contact.name) || 'Unnamed',
    stageType,
    monetaryValue: opp.monetaryValue || null,
    assignedTo: opp.assignedTo || null,
    criteria: {
      budgetMin: cfValue(opp, id.budgetMin),
      budgetMax: cfValue(opp, id.budgetMax),
      areas: cfValue(opp, id.areas),
      minBeds: cfValue(opp, id.minBeds),
      minBaths: cfValue(opp, id.minBaths),
      propertyStatus: cfValue(opp, id.propertyStatus),
      timeline: cfValue(opp, id.timeline),
      clientArriving: cfValue(opp, id.clientArriving),
      clientLeaving: cfValue(opp, id.clientLeaving),
      contactMethod: cfValue(opp, id.contactMethod),
      leadTemperature: cfValue(opp, id.leadTemperature),
      priorityScore: cfValue(opp, id.priorityScore),
      propertyReference: cfValue(opp, id.propertyReference)
    },
    tracking: {
      lastSearchDate: cfValue(opp, managedId['opportunity.se_last_search_date']),
      searchRound: parseInt(cfValue(opp, managedId['opportunity.se_search_round']) || '0', 10) || 0,
      feedback: cfValue(opp, managedId['opportunity.se_search_feedback'])
    }
  });

  return [
    ...active.map(o => mapOpp(o, 'active')),
    ...longTerm.map(o => mapOpp(o, 'longTerm'))
  ];
}

/* ---------------- wrap-up writes ---------------- */
async function createNote(contactId, title, body) {
  if (config.mock) return mock.record('note', { contactId, title, body });
  return api('POST', `/contacts/${contactId}/notes`, { body: { title, body } });
}

async function createTask(contactId, title, body, dueDateISO) {
  if (config.mock) return mock.record('task', { contactId, title, body, dueDateISO });
  return api('POST', `/contacts/${contactId}/tasks`, {
    body: { title, body: body || '', dueDate: dueDateISO, completed: false }
  });
}

async function updateOpportunity(opportunityId, { stageId, fields }) {
  if (config.mock) return mock.record('oppUpdate', { opportunityId, stageId, fields });
  await loadFields();
  const customFields = [];
  for (const [keyOrName, value] of Object.entries(fields || {})) {
    const fid = resolveFieldId(keyOrName);
    if (fid && value !== undefined && value !== null) customFields.push({ id: fid, field_value: String(value) });
  }
  const body = {};
  if (customFields.length) body.customFields = customFields;
  if (stageId) body.pipelineStageId = stageId;
  if (!Object.keys(body).length) return null;
  return api('PUT', `/opportunities/${opportunityId}`, { body });
}

/* ---------------- users (for ownership filtering) ---------------- */
let userCache = { users: [], fetchedAt: 0 };

/** GET /users/?locationId= — scope users.readonly */
async function getUsers(force = false) {
  if (config.mock) return mock.getUsers();
  if (!force && Date.now() - userCache.fetchedAt < 10 * 60 * 1000 && userCache.users.length) return userCache.users;
  const json = await api('GET', '/users/', { query: { locationId: config.ghl.locationId } });
  userCache = { users: json.users || [], fetchedAt: Date.now() };
  return userCache.users;
}

/** Resolve an agent (from config.agents) to a GHL user id: explicit id wins, else email match. */
async function resolveAgentUserId(agentName) {
  const agent = config.agents.find(a => a.name === agentName);
  if (!agent) return { userId: null, error: `Agent "${agentName}" not in AGENTS config` };
  if (agent.ghlUserId) return { userId: agent.ghlUserId, error: null };
  if (!agent.email) return { userId: null, error: `Agent "${agentName}" has no email in AGENTS config` };
  try {
    const users = await getUsers();
    const u = users.find(x => (x.email || '').toLowerCase() === agent.email);
    if (!u) return { userId: null, error: `No GHL user found with email ${agent.email} — add the GHL user id to AGENTS (Name:email:userId) or check the users.readonly scope` };
    return { userId: u.id, error: null };
  } catch (e) {
    return { userId: null, error: 'Could not list GHL users: ' + e.message };
  }
}

async function healthCheck() {
  if (config.mock) return { ok: true, mode: 'mock' };
  try {
    await api('GET', `/locations/${config.ghl.locationId}`, {});
    return { ok: true, mode: 'live' };
  } catch (e) {
    return { ok: false, mode: 'live', error: e.message };
  }
}

module.exports = { fetchQueue, createNote, createTask, updateOpportunity, ensureManagedFields, loadFields, healthCheck, getUsers, resolveAgentUserId };
