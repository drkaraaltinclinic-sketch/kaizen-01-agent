'use strict';

/**
 * kaizen-brain.js — KAIZEN-01 autonomy layer
 * v1.0
 *
 * Adds four things KAIZEN-01 currently lacks:
 *   1. PERSISTENCE      — tasks survive restarts (today they do not)
 *   2. REJECTION LEDGER — rejected proposals are remembered and never re-proposed
 *   3. OUTCOME CONTEXT  — pulls SUPREME-LEADER's weekly report so proposals are
 *                         grounded in trading results, not just bus alert counts
 *   4. TIERED DECISIONS — auto-reject freely; auto-apply only ENV_VAR changes to
 *                         unlocked variables, under hard rate limits; everything
 *                         touching risk or code is refused by the classifier
 *
 * Wire into src/agent.js — see mountKaizenBrain() at the bottom.
 */

const fs = require('fs');
const path = require('path');

// ── Tier C: constitutional. Never auto-applied, whatever any model proposes. ──
const LOCKED_VARS = new Set([
  'RISK_PCT', 'MAX_LEV', 'START_BUDGET', 'NET_DELTA_CAP', 'MAX_POSITIONS',
  'MAX_NEW_PER_DAY', 'MAX_HOLD_H', 'FEE_BPS', 'SLIP_BPS',
  'ANTHROPIC_API_KEY', 'GMAIL_APP_PASSWORD', 'EMAIL_TO', 'EMAIL_FROM',
  'GECKO_URL', 'HL_API', 'STATE_DIR', 'PORT',
]);

// Rate limits — a runaway propose→apply→measure loop is the main failure mode.
const MAX_AUTO_APPLY_PER_DAY = 2;
const MAX_AUTO_REJECT_PER_CYCLE = 6;
const MIN_HOURS_BETWEEN_APPLIES = 8;

// ── helpers ──────────────────────────────────────────────────────────────────
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Stable fingerprint for duplicate detection.
 * Deliberately coarse: target + category + the identifiers inside the remedy.
 * Two proposals that tune the same env var on the same agent collide even when
 * their prose differs, which is exactly how task #7 kept coming back.
 */
function fingerprint(task) {
  const t = obj(task);
  const envVars = String(t.remedy || '').match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || [];
  const key = envVars.length ? envVars.sort().join(',') : norm(t.title).split(' ').slice(0, 4).join(' ');
  return `${norm(t.target)}|${norm(t.category)}|${key}`.slice(0, 200);
}

/** Every fingerprint the network has already ruled on, with why. */
function buildLedger(tasks) {
  const led = new Map();
  for (const t of arr(tasks)) {
    const fp = fingerprint(t);
    const prev = led.get(fp);
    // A rejection is stickier than a proposal — keep the strongest verdict seen.
    const rank = { REJECTED: 3, MEASURED: 2, DEPLOYED: 2, ACCEPTED: 1, PROPOSED: 0 };
    if (!prev || (rank[t.status] ?? 0) >= (rank[prev.status] ?? 0)) {
      led.set(fp, { fingerprint: fp, status: t.status, id: t.id, title: t.title, target: t.target, at: t.createdAt });
    }
  }
  return led;
}

function isBlockedByLedger(task, ledger) {
  const hit = ledger.get(fingerprint(task));
  if (!hit) return null;
  if (hit.status === 'REJECTED') return { reason: 'previously rejected', ref: hit };
  if (hit.status === 'DEPLOYED' || hit.status === 'MEASURED') return { reason: 'already deployed', ref: hit };
  if (hit.status === 'PROPOSED' || hit.status === 'ACCEPTED') return { reason: 'already open', ref: hit };
  return null;
}

/**
 * Tier classification.
 *   C — touches a locked variable, or proposes code. Never auto-applied.
 *   A — ENV_VAR remedy naming only unlocked variables. Auto-applicable.
 *   B — everything else. Auto-reject allowed; auto-apply is not.
 */
function classifyTier(task) {
  const t = obj(task);
  const vars = String(t.remedy || '').match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || [];
  const locked = vars.filter((v) => LOCKED_VARS.has(v));
  if (locked.length) return { tier: 'C', reason: `touches locked variable(s): ${locked.join(', ')}`, vars };
  if (t.effort === 'ENV_VAR' && vars.length) return { tier: 'A', reason: 'env-var change to unlocked variable', vars };
  if (t.effort === 'NEW_MODULE' || t.effort === 'SMALL_PATCH') return { tier: 'B', reason: 'code change — shadow or review required', vars };
  return { tier: 'B', reason: 'unclassified remedy', vars };
}

/** Has the auto-apply budget been spent? */
function applyBudget(tasks, now = Date.now()) {
  const applied = arr(tasks)
    .filter((t) => t.autoAppliedAt)
    .map((t) => new Date(t.autoAppliedAt).getTime())
    .filter((n) => Number.isFinite(n));
  const last24 = applied.filter((ts) => now - ts < 86400000);
  const mostRecent = applied.length ? Math.max(...applied) : null;
  const hoursSince = mostRecent ? (now - mostRecent) / 3600000 : Infinity;
  return {
    usedToday: last24.length,
    remaining: Math.max(0, MAX_AUTO_APPLY_PER_DAY - last24.length),
    hoursSinceLast: hoursSince,
    cooldownOk: hoursSince >= MIN_HOURS_BETWEEN_APPLIES,
    ok: last24.length < MAX_AUTO_APPLY_PER_DAY && hoursSince >= MIN_HOURS_BETWEEN_APPLIES,
  };
}

/**
 * The decision. Pure function — no side effects, so it is testable and so the
 * same inputs always produce the same verdict.
 */
function decide(task, { ledger, tasks, now = Date.now() } = {}) {
  const dup = isBlockedByLedger(task, ledger || new Map());
  if (dup) return { verdict: 'AUTO_REJECT', tier: null, reason: `duplicate — ${dup.reason} (task #${dup.ref.id})`, ref: dup.ref };

  const cls = classifyTier(task);
  if (cls.tier === 'C') return { verdict: 'AUTO_REJECT', tier: 'C', reason: `constitutional — ${cls.reason}` };
  if (cls.tier === 'B') return { verdict: 'HOLD_FOR_REVIEW', tier: 'B', reason: cls.reason };

  const budget = applyBudget(tasks, now);
  if (!budget.ok) {
    return {
      verdict: 'HOLD_FOR_REVIEW', tier: 'A',
      reason: budget.remaining === 0
        ? `auto-apply budget spent (${budget.usedToday}/${MAX_AUTO_APPLY_PER_DAY} today)`
        : `cooldown — ${budget.hoursSinceLast.toFixed(1)}h since last apply, need ${MIN_HOURS_BETWEEN_APPLIES}h`,
    };
  }
  return { verdict: 'AUTO_APPLY', tier: 'A', reason: cls.reason, vars: cls.vars };
}

/** Run a whole proposal batch through decide(), respecting the per-cycle reject cap. */
function decideBatch(proposals, existingTasks, now = Date.now()) {
  const ledger = buildLedger(existingTasks);
  const results = [];
  let rejects = 0;
  const working = arr(existingTasks).slice();

  for (const p of arr(proposals)) {
    let d = decide(p, { ledger, tasks: working, now });
    if (d.verdict === 'AUTO_REJECT') {
      if (rejects >= MAX_AUTO_REJECT_PER_CYCLE) d = { verdict: 'HOLD_FOR_REVIEW', tier: d.tier, reason: 'per-cycle reject cap reached' };
      else rejects++;
    }
    if (d.verdict === 'AUTO_APPLY') working.push({ ...p, autoAppliedAt: new Date(now).toISOString() });
    results.push({ task: p, decision: d });
    ledger.set(fingerprint(p), { fingerprint: fingerprint(p), status: d.verdict === 'AUTO_REJECT' ? 'REJECTED' : 'PROPOSED', id: p.id ?? null, title: p.title, target: p.target });
  }
  return results;
}

// ── persistence ──────────────────────────────────────────────────────────────
function makeStore(dir) {
  const file = path.join(dir, 'kaizen.json');
  return {
    file,
    load() {
      try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { return null; }
    },
    save(snap) {
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(snap));
        return true;
      } catch { return false; }
    },
  };
}

// ── outcome context ──────────────────────────────────────────────────────────
/**
 * Pull SUPREME-LEADER's weekly report and reduce it to the handful of numbers a
 * proposal engine actually needs. Returns null on any failure so the caller can
 * degrade rather than fail the cycle.
 */
async function fetchOutcomes(fetchFn, url) {
  try {
    const res = await fetchFn(url, { timeout: 15000 });
    if (!res.ok) return null;
    const r = await res.json();
    return {
      equity: r.performance?.equity,
      profitFactor: r.allTime?.profitFactor,
      winRatePct: r.allTime?.winRate,
      trades: r.allTime?.trades,
      last7d: { trades: r.thisWeek?.trades, profitFactor: r.thisWeek?.profitFactor },
      exitReasons: arr(r.exitReasons).map((e) => ({ reason: e.reason, count: e.count, avgR: e.avgR, pnl: e.pnl })),
      vetoTally: arr(r.decisionAnalysis?.vetoCountsAllTime),
      liquidity: {
        passing: r.liquidity?.passing, universe: r.liquidity?.universeSize,
        failVolOnly: r.liquidity?.failingOnVolOnly, failOiOnly: r.liquidity?.failingOnOiOnly,
      },
      capacityFull: r.capacity?.full,
      config: r.config,
    };
  } catch { return null; }
}

// ── prompt fragment ──────────────────────────────────────────────────────────
/** Text to splice into KAIZEN's existing prompt so it stops re-proposing rejects. */
function ledgerPromptBlock(tasks) {
  const rejected = arr(tasks).filter((t) => t.status === 'REJECTED')
    .map((t) => ({ id: t.id, target: t.target, title: t.title, whyRejected: t.rejectReason || 'rejected' }));
  const deployed = arr(tasks).filter((t) => t.status === 'DEPLOYED' || t.status === 'MEASURED')
    .map((t) => ({ id: t.id, target: t.target, title: t.title }));
  return `
ALREADY REJECTED — these were considered and refused. Do NOT propose them again in any rewording:
${JSON.stringify(rejected, null, 1)}

ALREADY DEPLOYED — do NOT re-propose:
${JSON.stringify(deployed, null, 1)}
`;
}

function outcomesPromptBlock(outcomes) {
  if (!outcomes) return '\nTRADING OUTCOMES: unavailable this cycle — do not speculate about trading performance.\n';
  return `
TRADING OUTCOMES (SUPREME-LEADER, authoritative — ground every trading proposal in these numbers):
${JSON.stringify(outcomes, null, 1)}
`;
}

// ── mount ────────────────────────────────────────────────────────────────────
/**
 * Usage in KAIZEN's src/agent.js:
 *
 *   const { mountKaizenBrain } = require('./kaizen-brain');
 *   const brain = mountKaizenBrain(app, {
 *     getState: () => state,
 *     setTaskStatus,
 *     emit,
 *     fetchFn: fetch,
 *     stateDir: process.env.STATE_DIR || (require('fs').existsSync('/data') ? '/data' : './data'),
 *     reportUrl: process.env.SUPREME_REPORT_URL ||
 *       'https://supreme-leader-production-5890.up.railway.app/api/report/weekly.json',
 *   });
 *   brain.restore();          // right after, so the backlog survives restarts
 */
function mountKaizenBrain(app, opts = {}) {
  const { getState, setTaskStatus, emit, fetchFn, stateDir = './data', reportUrl } = opts;
  if (typeof getState !== 'function') throw new Error('mountKaizenBrain: getState required');
  const store = makeStore(stateDir);
  const log = (t, d) => { try { if (typeof emit === 'function') emit('SYS', t, d); } catch {} };

  const persist = () => {
    const s = getState();
    return store.save({ tasks: arr(s.tasks), taskSeq: s.taskSeq, savedAt: new Date().toISOString() });
  };

  const restore = () => {
    const snap = store.load();
    if (!snap) return false;
    const s = getState();
    if (Array.isArray(snap.tasks)) s.tasks = snap.tasks;
    if (Number.isFinite(snap.taskSeq)) s.taskSeq = Math.max(snap.taskSeq, s.taskSeq || 0);
    log('kaizen.restored', { tasks: s.tasks.length, taskSeq: s.taskSeq });
    return true;
  };

  setInterval(persist, 60000).unref?.();

  app.get('/brain/ledger', (_req, res) => {
    const tasks = arr(getState().tasks);
    res.json({
      total: tasks.length,
      byStatus: tasks.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] || 0) + 1 }), {}),
      budget: applyBudget(tasks),
      lockedVars: [...LOCKED_VARS],
      limits: { MAX_AUTO_APPLY_PER_DAY, MAX_AUTO_REJECT_PER_CYCLE, MIN_HOURS_BETWEEN_APPLIES },
      ledger: [...buildLedger(tasks).values()],
    });
  });

  /** Dry run — shows what the decision layer WOULD do. No writes. */
  app.post('/brain/dryrun', (req, res) => {
    const proposals = arr(req.body?.tasks);
    res.json({ results: decideBatch(proposals, arr(getState().tasks)) });
  });

  app.get('/brain/outcomes', async (_req, res) => {
    if (!fetchFn || !reportUrl) return res.status(501).json({ error: 'fetchFn/reportUrl not configured' });
    const o = await fetchOutcomes(fetchFn, reportUrl);
    res.json(o || { error: 'unavailable' });
  });

  console.log('[kaizen-brain] mounted — /brain/ledger /brain/dryrun /brain/outcomes');

  return {
    persist, restore, decide, decideBatch, buildLedger, fingerprint, classifyTier, applyBudget,
    fetchOutcomes: () => fetchOutcomes(fetchFn, reportUrl),
    ledgerPromptBlock: () => ledgerPromptBlock(arr(getState().tasks)),
    outcomesPromptBlock,
  };
}

module.exports = {
  mountKaizenBrain, fingerprint, buildLedger, isBlockedByLedger, classifyTier,
  applyBudget, decide, decideBatch, fetchOutcomes, ledgerPromptBlock, outcomesPromptBlock,
  LOCKED_VARS, MAX_AUTO_APPLY_PER_DAY, MAX_AUTO_REJECT_PER_CYCLE, MIN_HOURS_BETWEEN_APPLIES,
};
