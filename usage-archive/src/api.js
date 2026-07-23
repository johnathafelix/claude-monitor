'use strict';

// Grafana-facing JSON API, served exclusively from Mongo. Response shapes for
// /summary, /types, /models, /model-names, /timeseries, /blocks-series and
// /burnrate mirror ccusage-http so panels port across unchanged. Time params:
// from/to as epoch ms (Grafana ${__from}/${__to}) take precedence; since/until
// as YYYYMMDD are accepted for parity with the existing bridge.

const http = require('node:http');
const { URL } = require('node:url');

const config = require('./config');
const { coll } = require('./db');
const ingest = require('./ingest');
const pricing = require('./pricing');

const CACHE_TTL_MS = 10 * 1000;
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

const NO_FILTER_MODELS = new Set(['', 'all', 'All', '$__all']);

const SUMS = {
  input: { $sum: '$usage.input' },
  output: { $sum: '$usage.output' },
  cacheCreation: { $sum: '$usage.cacheCreation' },
  cacheRead: { $sum: '$usage.cacheRead' },
  cost: { $sum: { $ifNull: ['$cost.usd', 0] } },
};

function totalOf(row) {
  return row.input + row.output + row.cacheCreation + row.cacheRead;
}

function sanitizeDate(value) {
  if (!value) {
    return null;
  }

  const match = String(value).match(/^(\d{4})-?(\d{2})-?(\d{2})/);

  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

// UTC offset of BUCKET_TZ at a given instant, so YYYYMMDD windows line up with
// the same day boundaries the daily bucketing uses.
function tzOffsetMs(atMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.bucketTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(dtf.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, Number(parts.hour) % 24, parts.minute, parts.second);

  return asUtc - atMs;
}

function zonedDayStartMs(dateStr) {
  const guess = Date.parse(`${dateStr}T00:00:00Z`);

  return guess - tzOffsetMs(guess - tzOffsetMs(guess));
}

function parseWindow(url) {
  const fromParam = Number(url.searchParams.get('from'));
  const toParam = Number(url.searchParams.get('to'));
  const since = sanitizeDate(url.searchParams.get('since'));
  const until = sanitizeDate(url.searchParams.get('until'));

  let from = Number.isFinite(fromParam) && fromParam > 0 ? fromParam : null;
  let to = Number.isFinite(toParam) && toParam > 0 ? toParam : null;

  if (from === null && since) {
    from = zonedDayStartMs(since);
  }

  if (to === null && until) {
    to = zonedDayStartMs(until) + 24 * 60 * 60 * 1000;
  }

  return { from: from === null ? 0 : from, to: to === null ? Date.now() : to };
}

// The block/throughput panels default to the last DEFAULT_WINDOW_MS rather than
// all history, so they parse their window separately from parseWindow.
function parseBlockWindow(url) {
  const to = Number(url.searchParams.get('to')) || Date.now();
  const from = Number(url.searchParams.get('from')) || to - DEFAULT_WINDOW_MS;

  return { from, to };
}

function matchStage(url, window) {
  const match = { ts: { $gte: new Date(window.from), $lt: new Date(window.to) } };
  const model = url.searchParams.get('model');

  if (model && !NO_FILTER_MODELS.has(model)) {
    match.model = model;
  } else {
    match.model = { $ne: '<synthetic>' };
  }

  const source = url.searchParams.get('source');

  if (source === 'main' || source === 'subagent') {
    match['agent.isSubagent'] = source === 'subagent';
  }

  const agentType = url.searchParams.get('agentType');

  if (agentType) {
    match['agent.agentType'] = agentType;
  }

  return match;
}

async function sumWindow(url, window) {
  const rows = await coll('events')
    .aggregate([{ $match: matchStage(url, window) }, { $group: { _id: null, ...SUMS } }])
    .toArray();

  return rows[0] || { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 };
}

function seriesBucketMs(window) {
  const span = Math.max(0, window.to - window.from);
  let bucketMs = 60 * 1000;

  if (span / bucketMs > config.maxSeriesPoints) {
    bucketMs = Math.ceil(span / config.maxSeriesPoints / 60000) * 60000;
  }

  return bucketMs;
}

async function bucketedSeries(url, window, groupByModel) {
  const bucketMs = seriesBucketMs(window);
  const groupId = {
    bucket: { $dateTrunc: { date: '$ts', unit: 'minute', binSize: bucketMs / 60000 } },
  };

  if (groupByModel) {
    groupId.model = '$model';
  }

  const rows = await coll('events')
    .aggregate([{ $match: matchStage(url, window) }, { $group: { _id: groupId, ...SUMS } }])
    .toArray();

  return { bucketMs, rows };
}

function* bucketRange(window, bucketMs) {
  const start = Math.floor(window.from / bucketMs) * bucketMs;

  for (let bucket = start; bucket <= window.to; bucket += bucketMs) {
    yield bucket;
  }
}

const handlers = {
  async '/summary'(url) {
    const row = await sumWindow(url, parseWindow(url));

    return {
      inputTokens: row.input,
      outputTokens: row.output,
      cacheCreationTokens: row.cacheCreation,
      cacheReadTokens: row.cacheRead,
      totalTokens: totalOf(row),
      totalCost: row.cost,
    };
  },

  async '/types'(url) {
    const row = await sumWindow(url, parseWindow(url));

    return [
      { type: 'input', tokens: row.input },
      { type: 'output', tokens: row.output },
      { type: 'cacheCreation', tokens: row.cacheCreation },
      { type: 'cacheRead', tokens: row.cacheRead },
    ];
  },

  async '/models'(url) {
    const rows = await coll('events')
      .aggregate([{ $match: matchStage(url, parseWindow(url)) }, { $group: { _id: '$model', ...SUMS } }])
      .toArray();

    return rows
      .map((row) => ({
        model: row._id,
        inputTokens: row.input,
        outputTokens: row.output,
        cacheCreationTokens: row.cacheCreation,
        cacheReadTokens: row.cacheRead,
        totalTokens: totalOf(row),
        cost: row.cost,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  },

  async '/model-names'() {
    const rows = await coll('events')
      .aggregate([
        { $match: { model: { $ne: '<synthetic>' } } },
        { $group: { _id: '$model', tokens: { $sum: { $add: ['$usage.input', '$usage.output', '$usage.cacheCreation', '$usage.cacheRead'] } } } },
        { $sort: { tokens: -1 } },
      ])
      .toArray();

    return rows.map((row) => row._id);
  },

  async '/timeseries'(url) {
    const rows = await coll('events')
      .aggregate([
        { $match: matchStage(url, parseWindow(url)) },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: config.bucketTz } },
            ...SUMS,
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    return rows.map((row) => ({
      time: row._id,
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheCreation: row.cacheCreation,
      totalTokens: totalOf(row),
      cost: row.cost,
    }));
  },

  async '/blocks-series'(url) {
    const window = parseBlockWindow(url);
    const { bucketMs, rows } = await bucketedSeries(url, window, false);
    const byBucket = new Map(rows.map((row) => [row._id.bucket.getTime(), row]));

    return [...bucketRange(window, bucketMs)].map((bucket) => {
      const row = byBucket.get(bucket) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

      return {
        time: new Date(bucket).toISOString(),
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheCreation: row.cacheCreation,
        totalTokens: totalOf(row),
      };
    });
  },

  // Long-format per-minute rates for the two throughput panels; Grafana's
  // partition-by-values transform splits on `group`.
  async '/throughput'(url) {
    const window = parseBlockWindow(url);
    const byModel = url.searchParams.get('groupBy') === 'model';
    const { bucketMs, rows } = await bucketedSeries(url, window, byModel);
    const perMin = bucketMs / 60000;
    const out = [];

    if (byModel) {
      const models = [...new Set(rows.map((row) => row._id.model))].sort();
      const byKey = new Map(rows.map((row) => [`${row._id.bucket.getTime()}:${row._id.model}`, row]));

      for (const bucket of bucketRange(window, bucketMs)) {
        const time = new Date(bucket).toISOString();

        for (const model of models) {
          const row = byKey.get(`${bucket}:${model}`);

          out.push({ time, group: model, tokensPerMin: row ? totalOf(row) / perMin : 0 });
        }
      }
    } else {
      const byBucket = new Map(rows.map((row) => [row._id.bucket.getTime(), row]));

      for (const bucket of bucketRange(window, bucketMs)) {
        const time = new Date(bucket).toISOString();
        const row = byBucket.get(bucket) || { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

        for (const type of ['input', 'output', 'cacheCreation', 'cacheRead']) {
          out.push({ time, group: type, tokensPerMin: row[type] / perMin });
        }
      }
    }

    return out;
  },

  // Rolling last-hour rate, independent of the dashboard range — mirrors the
  // OTel dashboard's increase(...[1h]) gauges.
  async '/burnrate'(url) {
    const now = Date.now();
    const row = await sumWindow(url, { from: now - 60 * 60 * 1000, to: now });
    const recent = await coll('events').findOne(
      matchStage(url, { from: now - 5 * 60 * 1000, to: now }),
      { projection: { _id: 1 } },
    );

    return {
      tokensPerMinute: totalOf(row) / 60,
      tokensPerMinuteForIndicator: (row.input + row.output) / 60,
      costPerHour: row.cost,
      active: Boolean(recent),
    };
  },

  async '/sources'(url) {
    const rows = await coll('events')
      .aggregate([
        { $match: matchStage(url, parseWindow(url)) },
        { $group: { _id: '$agent.isSubagent', ...SUMS } },
      ])
      .toArray();

    return rows
      .map((row) => ({ source: row._id ? 'subagent' : 'main', tokens: totalOf(row), cost: row.cost }))
      .sort((a, b) => b.tokens - a.tokens);
  },

  async '/agent-types'(url) {
    const match = matchStage(url, parseWindow(url));

    match['agent.isSubagent'] = true;

    const rows = await coll('events')
      .aggregate([
        { $match: match },
        { $group: { _id: { $ifNull: ['$agent.agentType', 'unknown'] }, events: { $sum: 1 }, ...SUMS } },
      ])
      .toArray();

    return rows
      .map((row) => ({ agentType: row._id, events: row.events, tokens: totalOf(row), cost: row.cost }))
      .sort((a, b) => b.tokens - a.tokens);
  },

  async '/pricing'() {
    return pricing.latestTable();
  },

  async '/entry-types'() {
    const rows = await coll('raw')
      .aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
      .toArray();

    return rows.map((row) => ({ type: row._id, count: row.count }));
  },

  async '/stats-daily'() {
    const rows = await coll('statsDaily').find({}).sort({ _id: 1 }).toArray();

    return rows.map((row) => ({ date: row._id, models: row.models, activity: row.activity }));
  },

  async '/health'() {
    const [rawEntries, usageEvents, unpricedEvents] = await Promise.all([
      coll('raw').estimatedDocumentCount(),
      coll('events').estimatedDocumentCount(),
      coll('events').countDocuments({ 'cost.priced': false }),
    ]);

    return {
      status: 'ok',
      ingest: ingest.stats,
      rawEntries,
      usageEvents,
      unpricedEvents,
      pricing: pricing.status(),
    };
  },
};

handlers['/'] = handlers['/health'];

const cache = new Map();
const inflight = new Map();

// One dashboard refresh fires ~16 panel queries, several of them identical;
// coalesce and briefly cache like ccusage-http does.
function cached(key, fn) {
  const hit = cache.get(key);

  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.data;
  }

  let pending = inflight.get(key);

  if (!pending) {
    pending = Promise.resolve()
      .then(fn)
      .then((data) => {
        cache.set(key, { at: Date.now(), data });

        if (cache.size > 500) {
          cache.clear();
        }

        return data;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, pending);
  }

  return pending;
}

function start() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.replace(/\/+$/, '') || '/';
      const handler = handlers[route];

      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));

        return;
      }

      const skipCache = route === '/' || route === '/health';
      const body = skipCache ? await handler(url) : await cached(req.url, () => handler(url));

      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    }
  });

  server.listen(config.port, () => {
    console.log(`usage-archive listening on :${config.port} (scan every ${config.scanIntervalMs / 1000}s, bucketTz=${config.bucketTz})`);
  });

  return server;
}

module.exports = { start };
