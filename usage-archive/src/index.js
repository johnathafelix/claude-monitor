'use strict';

const db = require('./db');
const pricing = require('./pricing');
const ingest = require('./ingest');
const api = require('./api');

async function main() {
  await db.connect();
  await pricing.init();

  api.start();
  ingest.start();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
