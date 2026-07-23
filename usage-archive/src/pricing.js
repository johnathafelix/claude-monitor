'use strict';

// Dated pricing: every successful LiteLLM fetch is persisted as a per-day
// snapshot in Mongo, and an event's cost is always computed with the snapshot
// in effect at the event's timestamp. Once an event is priced it is never
// recomputed, so past usage cost stays stable when prices change. Events that
// couldn't be priced (unknown model, or a $0-rate entry like the stale
// claude-sonnet-5 snapshot ccusage shipped) stay `priced: false` and are
// healed by the sweep after a later fetch brings real rates.

const config = require('./config');
const { coll } = require('./db');

// Sorted by date ascending: [{ date: 'YYYY-MM-DD', fetchedAt, models: Map<litellmKey, rates> }]
let snapshots = [];
let lastFetchAt = 0;
let lastUnknownRefreshAt = 0;
let refreshing = null;

const UNKNOWN_REFRESH_THROTTLE_MS = 15 * 60 * 1000;

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function ratesFromLitellm(entry) {
  return {
    in: entry.input_cost_per_token || 0,
    out: entry.output_cost_per_token || 0,
    cacheWrite: entry.cache_creation_input_token_cost || 0,
    cacheWrite1h: entry.cache_creation_input_token_cost_above_1hr || 0,
    cacheRead: entry.cache_read_input_token_cost || 0,
  };
}

function toMemory(doc) {
  return {
    date: doc._id,
    fetchedAt: doc.fetchedAt,
    models: new Map(doc.models.map((m) => [m.key, m])),
  };
}

async function load() {
  const docs = await coll('pricing').find({}).sort({ _id: 1 }).toArray();

  snapshots = docs.map(toMemory);

  const meta = await coll('pricingMeta').findOne({ _id: '__meta__' });

  lastFetchAt = (meta && meta.fetchedAt && meta.fetchedAt.getTime()) || 0;
}

async function refreshUncoalesced() {
  const res = await fetch(config.pricingUrl, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`pricing fetch: HTTP ${res.status}`);
  }

  const table = await res.json();
  const models = [];

  for (const [key, entry] of Object.entries(table)) {
    if (!key.toLowerCase().includes('claude') || !entry || typeof entry !== 'object') {
      continue;
    }

    models.push({ key, ...ratesFromLitellm(entry), raw: entry });
  }

  if (!models.length) {
    throw new Error('pricing fetch: no claude models in table');
  }

  const now = new Date();
  const date = utcDate(now.getTime());

  await coll('pricing').updateOne(
    { _id: date },
    { $set: { fetchedAt: now, source: config.pricingUrl, models } },
    { upsert: true },
  );

  await coll('pricingMeta').updateOne(
    { _id: '__meta__' },
    { $set: { fetchedAt: now, sourceUrl: config.pricingUrl, modelCount: models.length, lastError: null } },
    { upsert: true },
  );

  const mem = toMemory({ _id: date, fetchedAt: now, models });
  const existing = snapshots.findIndex((s) => s.date === date);

  if (existing >= 0) {
    snapshots[existing] = mem;
  } else {
    snapshots.push(mem);
    snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  lastFetchAt = now.getTime();
  console.log(`pricing refreshed: ${models.length} claude models, snapshot ${date}`);
}

// A dashboard-triggered sweep and the interval timer may fire together; share
// one fetch. Failures keep the persisted snapshots authoritative.
async function refresh() {
  if (!refreshing) {
    refreshing = refreshUncoalesced()
      .then(() => true)
      .catch(async (err) => {
        console.error('pricing refresh failed (keeping persisted snapshots):', err.message);

        await coll('pricingMeta')
          .updateOne(
            { _id: '__meta__' },
            { $set: { lastError: err.message, lastErrorAt: new Date() } },
            { upsert: true },
          )
          .catch(() => {});

        return false;
      })
      .finally(() => {
        refreshing = null;
      });
  }

  return refreshing;
}

// Latest snapshot dated at or before the event's day; events older than the
// oldest snapshot fall back to the oldest one we have.
function snapshotFor(tsMs) {
  if (!snapshots.length) {
    return null;
  }

  const date = utcDate(tsMs);
  let found = null;

  for (const snap of snapshots) {
    if (snap.date <= date) {
      found = snap;
    } else {
      break;
    }
  }

  return found || snapshots[0];
}

// Transcripts log bare ids (claude-opus-4-8) while LiteLLM keys vary
// (anthropic/..., provider paths, -YYYYMMDD date suffixes).
function findRates(models, model) {
  const direct = models.get(model) || models.get(`anthropic/${model}`);

  if (direct) {
    return direct;
  }

  for (const [key, rates] of models) {
    const last = key.split('/').pop();

    if (last === model || last.replace(/-\d{8}$/, '') === model) {
      return rates;
    }
  }

  return null;
}

const UNPRICED = { usd: null, priced: false, snapshotDate: null, rates: null };

function priceEvent(model, usage, tsMs) {
  // Synthetic placeholder entries carry zero tokens; price them at zero so the
  // sweep never spins on them.
  if (model === '<synthetic>') {
    return { usd: 0, priced: true, snapshotDate: null, rates: null };
  }

  const snap = snapshotFor(tsMs);

  if (!snap) {
    return UNPRICED;
  }

  const rates = snap.models && findRates(snap.models, model);

  // No match, or a matched-but-zeroed entry: never record a silent $0.
  if (!rates || (!rates.in && !rates.out)) {
    return UNPRICED;
  }

  let usd = usage.input * rates.in + usage.output * rates.out + usage.cacheRead * rates.cacheRead;

  const split = usage.cacheCreation1h + usage.cacheCreation5m;

  if (config.price1hPremium && rates.cacheWrite1h && split === usage.cacheCreation && split > 0) {
    usd += usage.cacheCreation5m * rates.cacheWrite + usage.cacheCreation1h * rates.cacheWrite1h;
  } else {
    usd += usage.cacheCreation * rates.cacheWrite;
  }

  return {
    usd,
    priced: true,
    snapshotDate: snap.date,
    rates: {
      in: rates.in,
      out: rates.out,
      cacheWrite: rates.cacheWrite,
      cacheWrite1h: rates.cacheWrite1h,
      cacheRead: rates.cacheRead,
    },
  };
}

// Fill in cost for events that couldn't be priced at ingest. Only touches
// `priced: false` docs (partial index), so already-priced history is immutable.
async function repriceSweep() {
  const cursor = coll('events').find({ 'cost.priced': false });
  let ops = [];
  let repriced = 0;

  for await (const event of cursor) {
    const cost = priceEvent(event.model, event.usage, event.ts.getTime());

    if (!cost.priced) {
      continue;
    }

    ops.push({ updateOne: { filter: { _id: event._id }, update: { $set: { cost } } } });
    repriced += 1;

    if (ops.length >= 500) {
      await coll('events').bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }

  if (ops.length) {
    await coll('events').bulkWrite(ops, { ordered: false });
  }

  if (repriced) {
    console.log(`pricing sweep: repriced ${repriced} events`);
  }
}

// Ingest calls this when it sees a model no snapshot can price — a brand-new
// model usually shows up in LiteLLM within hours, so fetch eagerly (throttled).
async function maybeRefreshForUnknown(models) {
  if (!models.size || Date.now() - lastUnknownRefreshAt < UNKNOWN_REFRESH_THROTTLE_MS) {
    return;
  }

  lastUnknownRefreshAt = Date.now();
  console.log(`unknown model(s) [${[...models].join(', ')}], trying a pricing refresh`);

  if (await refresh()) {
    await repriceSweep();
  }
}

async function init() {
  await load();

  if (!snapshots.length || Date.now() - lastFetchAt > config.pricingRefreshMs) {
    await refresh();
  } else {
    const latest = snapshots[snapshots.length - 1];

    console.log(`pricing loaded from mongo: ${snapshots.length} snapshot(s), latest ${latest.date}`);
  }

  await repriceSweep();

  setInterval(async () => {
    if (await refresh()) {
      await repriceSweep();
    }
  }, config.pricingRefreshMs).unref();
}

function latestTable() {
  const latest = snapshots[snapshots.length - 1];

  if (!latest) {
    return [];
  }

  return [...latest.models.values()]
    .map((m) => ({
      model: m.key,
      inputPerMTok: m.in * 1e6,
      outputPerMTok: m.out * 1e6,
      cacheWritePerMTok: m.cacheWrite * 1e6,
      cacheWrite1hPerMTok: m.cacheWrite1h * 1e6,
      cacheReadPerMTok: m.cacheRead * 1e6,
      snapshotDate: latest.date,
      fetchedAt: latest.fetchedAt,
    }))
    .sort((a, b) => (a.model < b.model ? -1 : 1));
}

function status() {
  const latest = snapshots[snapshots.length - 1];

  return {
    snapshots: snapshots.length,
    models: latest ? latest.models.size : 0,
    latestDate: latest ? latest.date : null,
    fetchedAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
    stale: !lastFetchAt || Date.now() - lastFetchAt > 2 * config.pricingRefreshMs,
  };
}

module.exports = { init, refresh, priceEvent, repriceSweep, maybeRefreshForUnknown, latestTable, status };
