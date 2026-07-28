'use strict';

/**
 * kaizen-executor.js — the HANDS of KAIZEN-01
 * v1.0
 *
 * Applies approved ENV_VAR remedies to Railway services via the Railway
 * GraphQL API, then redeploys the target service. This is the missing piece
 * between "AUTO_APPLY verdict" and reality.
 *
 * SAFETY MODEL (all enforced here, independent of what any model proposes):
 *   1. Requires RAILWAY_API_TOKEN — without it, executor reports disabled.
 *   2. Only variables in TUNABLE_VARS (verified to exist in each agent's code)
 *      can ever be touched. Phantom vars are refused with a clear note.
 *   3. LOCKED_VARS (from kaizen-brain) always refused, belt-and-braces.
 *   4. Values must match a strict character whitelist and length cap.
 *   5. One variable per remedy; anything unparseable is refused.
 */

const { LOCKED_VARS } = require('./kaizen-brain');

const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN || '';
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

// ── Registry: variables VERIFIED to exist in each agent's source code. ──────
// A remedy naming any other variable is refused as "not in tunable registry".
// Extend this list only after confirming the target agent actually reads the var.
const TUNABLE_VARS = {
  'SUPREME-LEADER': [
    'CONVICTION_MIN', 'ATR_STOP_MULT', 'TARGET_R', 'MIN_VOL_USD', 'MIN_OI_USD',
    'DECISION_MS', 'MANAGE_MS', 'STRATEGY_MODE', 'ENTRY_SCORE',
    'SUSPEND_THESIS_TAGS', 'EMAIL_TRADES', 'DIGEST_HOUR_UTC',
  ],
  'ACTUARY-01': ['POLL_MS'],
  'KAIZEN-01': ['KAIZEN_INTERVAL_MS', 'FIRST_CYCLE_DELAY_MS', 'SNAPSHOT_MS', 'ANTHROPIC_MODEL'],
};

// ── Railway service discovery: target agent id → service name candidates ────
const SERVICE_NAMES = {
  'SUPREME-LEADER': ['supreme-leader'],
  'ACTUARY-01': ['actuary-01', 'actuary'],
  'KAIZEN-01': ['kaizen-01-agent', 'kaizen-01', 'kaizen'],
  'GECKO-01': ['gecko-01-agent', 'gecko-01', 'gecko'],
  'ALPHA-01': ['alpha-01-agent', 'alpha-01', 'alpha'],
  'VIZIER-01': ['vizier-01', 'vizier'],
};

const VALUE_RE = /^[A-Za-z0-9_.,:+%\-]{1,80}$/;

/** "Set ENV_VAR SUSPEND_THESIS_TAGS=CONTRARIAN_FEAR_LONG; ..." → {name, value} */
function parseRemedy(remedy) {
  const m = String(remedy || '').match(/\b([A-Z][A-Z0-9_]{3,})\s*=\s*([A-Za-z0-9_.,:+%\-]+)/);
  if (!m) return null;
  return { name: m[1], value: m[2] };
}

function validate(task) {
  if (!RAILWAY_API_TOKEN) return { ok: false, note: 'executor disabled — RAILWAY_API_TOKEN not set' };
  const target = String(task.target || '').toUpperCase();
  if (!SERVICE_NAMES[target]) return { ok: false, note: `no Railway service mapping for target ${target}` };
  const pv = parseRemedy(task.remedy);
  if (!pv) return { ok: false, note: 'remedy has no parseable VAR=value' };
  if (LOCKED_VARS.has(pv.name)) return { ok: false, note: `${pv.name} is constitutionally locked` };
  const allowed = TUNABLE_VARS[target] || [];
  if (!allowed.includes(pv.name)) return { ok: false, note: `${pv.name} is not in ${target}'s tunable registry (likely a phantom var — no code reads it)` };
  if (!VALUE_RE.test(pv.value)) return { ok: false, note: `value fails safety whitelist: ${String(pv.value).slice(0, 40)}` };
  return { ok: true, target, name: pv.name, value: pv.value };
}

async function gql(fetchFn, query, variables) {
  const res = await fetchFn(RAILWAY_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RAILWAY_API_TOKEN}` },
    body: JSON.stringify({ query, variables }),
    timeout: 20000,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error(`Railway API: ${res.status} ${JSON.stringify(j.errors || {}).slice(0, 160)}`);
  return j.data;
}

let topoCache = null; // { at, services: [{projectId, environmentId, envName, serviceId, name}] }

async function discover(fetchFn) {
  if (topoCache && Date.now() - topoCache.at < 3600000) return topoCache.services;
  const q = `query { projects { edges { node { id name
      environments { edges { node { id name } } }
      services { edges { node { id name } } } } } } }`;
  let data;
  try { data = await gql(fetchFn, q); } catch (e) {
    // some token types scope projects under me{}
    data = await gql(fetchFn, `query { me { projects { edges { node { id name
        environments { edges { node { id name } } }
        services { edges { node { id name } } } } } } } }`);
    data = { projects: data.me.projects };
  }
  const services = [];
  for (const pe of data.projects.edges || []) {
    const p = pe.node;
    const envs = (p.environments.edges || []).map(e => e.node);
    const env = envs.find(e => /^prod/i.test(e.name)) || envs[0];
    if (!env) continue;
    for (const se of p.services.edges || []) {
      services.push({ projectId: p.id, environmentId: env.id, envName: env.name, serviceId: se.node.id, name: se.node.name });
    }
  }
  topoCache = { at: Date.now(), services };
  return services;
}

function findService(services, target) {
  const cands = SERVICE_NAMES[String(target).toUpperCase()] || [];
  for (const c of cands) {
    const hit = services.find(s => s.name.toLowerCase() === c) ||
                services.find(s => s.name.toLowerCase().includes(c));
    if (hit) return hit;
  }
  return null;
}

/**
 * Apply a task's ENV_VAR remedy for real. Returns { ok, note, applied? }.
 * Never throws.
 */
async function applyRemedy(task, fetchFn) {
  try {
    const v = validate(task);
    if (!v.ok) return v;
    const services = await discover(fetchFn);
    const svc = findService(services, v.target);
    if (!svc) return { ok: false, note: `Railway service not found for ${v.target} (have: ${services.map(s => s.name).join(', ').slice(0, 120)})` };
    await gql(fetchFn, `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`, {
      input: { projectId: svc.projectId, environmentId: svc.environmentId, serviceId: svc.serviceId, name: v.name, value: v.value },
    });
    try {
      await gql(fetchFn, `mutation($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }`,
        { environmentId: svc.environmentId, serviceId: svc.serviceId });
    } catch (e) {
      return { ok: true, note: `${v.name}=${v.value} set on ${svc.name}, but redeploy call failed (${e.message.slice(0, 80)}) — variable takes effect on next deploy`, applied: { name: v.name, value: v.value, service: svc.name } };
    }
    return { ok: true, note: `${v.name}=${v.value} applied to ${svc.name} and service redeployed`, applied: { name: v.name, value: v.value, service: svc.name } };
  } catch (e) {
    return { ok: false, note: `executor error: ${String(e.message).slice(0, 140)}` };
  }
}

const enabled = () => !!RAILWAY_API_TOKEN;

module.exports = { applyRemedy, validate, parseRemedy, discover, enabled, TUNABLE_VARS, SERVICE_NAMES };
