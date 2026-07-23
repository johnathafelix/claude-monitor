'use strict';

// The non-transcript sources, ingested every cycle with the same state
// machinery: stats-cache.json (CC's own aggregates — the only usage history
// predating the ~30-day transcript retention), history.jsonl (prompt history),
// and metrics/events/*.jsonl (tool/agent/session event log).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { coll } = require('./db');

// stats-cache mixes date-suffixed ids (claude-opus-4-5-20251101) with bare
// ones (claude-opus-4-8); metrics events add a context suffix ([1m]).
function normalizeModelId(id) {
  return id.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
}

function statFile(abs) {
  try {
    const stat = fs.statSync(abs);

    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function flushOps(name, ops) {
  if (ops.length) {
    await coll(name).bulkWrite(ops, { ordered: false });
    ops.length = 0;
  }
}

// stats-cache.json is a snapshot file: whole-document re-ingest on any change.
async function ingestStatsCache(ctx) {
  const rel = 'stats-cache.json';
  const abs = path.join(config.claudeDir, rel);
  const stat = statFile(abs);

  if (!stat) {
    return;
  }

  ctx.seenRels.add(rel);

  const state = ctx.stateMap.get(rel);

  if (state && state.size === stat.size && state.mtimeMs === stat.mtimeMs) {
    return;
  }

  let raw;

  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    console.error('unreadable stats-cache.json:', err.message);

    return;
  }

  await coll('statsCache').replaceOne(
    { _id: 'latest' },
    { raw, size: stat.size, mtimeMs: stat.mtimeMs, ingestedAt: new Date() },
    { upsert: true },
  );

  const byDate = new Map();
  const dayDoc = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, { models: [], activity: null });
    }

    return byDate.get(date);
  };

  for (const entry of raw.dailyModelTokens || []) {
    if (!entry || !entry.date) {
      continue;
    }

    for (const [model, tokens] of Object.entries(entry.tokensByModel || {})) {
      dayDoc(entry.date).models.push({ model, normalized: normalizeModelId(model), tokens });
    }
  }

  for (const entry of raw.dailyActivity || []) {
    if (entry && entry.date) {
      dayDoc(entry.date).activity = entry;
    }
  }

  const dailyOps = [...byDate.entries()].map(([date, doc]) => ({
    replaceOne: { filter: { _id: date }, replacement: doc, upsert: true },
  }));

  await flushOps('statsDaily', dailyOps);

  const modelOps = Object.entries(raw.modelUsage || {}).map(([model, usage]) => ({
    replaceOne: {
      filter: { _id: model },
      replacement: { normalized: normalizeModelId(model), usage },
      upsert: true,
    },
  }));

  await flushOps('statsModels', modelOps);

  await ctx.setState(rel, { kind: 'stats-cache', size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, line: 0, deletedAt: null });
}

// Shared offset-tracked ingestion for the two append-only JSONL sources.
async function ingestAppendOnly(ctx, rel, kind, buildOp) {
  const abs = path.join(config.claudeDir, rel);
  const stat = statFile(abs);

  if (!stat) {
    return;
  }

  ctx.seenRels.add(rel);

  const state = ctx.stateMap.get(rel);
  let offset = state ? state.offset : 0;
  let lineNo = state ? state.line : 0;

  if (state && stat.size < state.offset) {
    offset = 0;
    lineNo = 0;
  }

  if (stat.size <= offset) {
    return;
  }

  const buf = await ctx.readSlice(abs, offset, stat.size);
  const ops = [];
  const collName = kind === 'history' ? 'prompts' : 'ccEvents';

  const consumed = ctx.consumeLines(buf, offset, stat.mtimeMs, (line) => {
    lineNo += 1;

    let entry;

    try {
      entry = JSON.parse(line.text);
    } catch {
      ctx.stats.parseErrors += 1;

      return;
    }

    const op = buildOp(entry, line);

    if (op) {
      ops.push(op);
    }
  });

  for (let i = 0; i < ops.length; i += 500) {
    await coll(collName).bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }

  await ctx.setState(rel, { kind, size: stat.size, mtimeMs: stat.mtimeMs, offset: consumed, line: lineNo, deletedAt: null });
}

async function ingestHistory(ctx) {
  // Content-hashed _id: history.jsonl could get rewritten by CC (dedup/trim),
  // and hashing makes a from-zero re-ingest converge instead of duplicating.
  await ingestAppendOnly(ctx, 'history.jsonl', 'history', (entry, line) => ({
    updateOne: {
      filter: { _id: crypto.createHash('sha1').update(line.text).digest('hex') },
      update: {
        $setOnInsert: {
          display: entry.display || null,
          project: entry.project || null,
          sessionId: entry.sessionId || null,
          ts: Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null,
          raw: entry,
        },
      },
      upsert: true,
    },
  }));
}

async function ingestMetricsEvents(ctx) {
  const dir = path.join(config.claudeDir, 'metrics', 'events');
  let names;

  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return;
  }

  for (const name of names) {
    const rel = path.join('metrics', 'events', name);

    await ingestAppendOnly(ctx, rel, 'metrics', (entry, line) => ({
      updateOne: {
        filter: { _id: `${rel}#${line.offset}` },
        update: {
          $setOnInsert: {
            ts: entry.ts ? new Date(entry.ts) : null,
            event: entry.event || null,
            session: entry.session || null,
            tool: entry.tool || null,
            user: entry.user || null,
            model: entry.model || null,
            modelNormalized: entry.model ? normalizeModelId(entry.model) : null,
            raw: entry,
          },
        },
        upsert: true,
      },
    }));
  }
}

async function run(ctx) {
  await ingestStatsCache(ctx);
  await ingestHistory(ctx);
  await ingestMetricsEvents(ctx);
}

module.exports = { run };
