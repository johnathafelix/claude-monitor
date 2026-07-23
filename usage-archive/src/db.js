'use strict';

const { MongoClient } = require('mongodb');
const config = require('./config');

let db = null;

// Collection names, kept in one place so ingest/api/pricing agree.
const COLLECTIONS = {
  raw: 'raw_entries',
  events: 'usage_events',
  files: 'files',
  pricing: 'pricing_snapshots',
  pricingMeta: 'pricing_meta',
  subagentMeta: 'subagent_meta',
  statsCache: 'stats_cache',
  statsDaily: 'stats_daily',
  statsModels: 'stats_models',
  prompts: 'prompt_history',
  ccEvents: 'cc_events',
};

// The atlas-local container can take a while on first boot (replica-set init),
// so retry until it answers instead of crash-looping the whole service.
async function connect() {
  for (;;) {
    const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 5000 });

    try {
      await client.connect();
      await client.db().command({ ping: 1 });
      db = client.db();
      break;
    } catch (err) {
      console.error('mongo connect failed, retrying in 5s:', err.message);
      await client.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  await ensureIndexes();

  return db;
}

async function ensureIndexes() {
  await db.collection(COLLECTIONS.raw).createIndexes([
    { key: { type: 1, ts: 1 } },
    { key: { sessionId: 1 } },
    { key: { file: 1, offset: 1 } },
  ]);

  await db.collection(COLLECTIONS.events).createIndexes([
    { key: { ts: 1 } },
    { key: { model: 1, ts: 1 } },
    { key: { sessionId: 1 } },
    { key: { 'agent.agentType': 1, ts: 1 } },
    { key: { cwd: 1, ts: 1 } },
    { key: { sourceFile: 1 } },
    {
      key: { 'cost.priced': 1 },
      partialFilterExpression: { 'cost.priced': false },
    },
  ]);

  await db.collection(COLLECTIONS.subagentMeta).createIndexes([
    { key: { sessionId: 1 } },
    { key: { agentHash: 1 } },
  ]);

  await db.collection(COLLECTIONS.prompts).createIndexes([{ key: { ts: 1 } }, { key: { project: 1, ts: 1 } }]);

  await db.collection(COLLECTIONS.ccEvents).createIndexes([{ key: { ts: 1 } }, { key: { event: 1, ts: 1 } }]);
}

function coll(name) {
  return db.collection(COLLECTIONS[name]);
}

module.exports = { connect, coll, COLLECTIONS };
