#!/usr/bin/env node

const path = require('path');
const { config: dotenv } = require('dotenv');
const { createConnection: mysql } = require('mysql2/promise');
const Parser = require('./parser');

dotenv({ path: path.resolve(__dirname, '.env') });
const { env } = process;
let mysqlConnection = null;

/**
 * lock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
async function lockSite(siteId) {
  return mysqlConnection.execute(
    'UPDATE source SET is_locked = 1 WHERE id = ?',
    [siteId],
  );
}

/**
 * unlock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
async function unlockSite(siteId) {
  return mysqlConnection.execute(
    'UPDATE source SET is_locked = 0 WHERE id = ?',
    [siteId],
  );
}

/**
 * fetches last post date
 * @param siteId
 * @returns {*|PromiseLike<T>|Promise<T>}
 */
async function getLastPostDate(siteId) {
  const [source] = await mysqlConnection.execute(
    'SELECT * FROM source WHERE id = ?',
    [siteId],
  );
  const lastPostDate = (source ? (source.last_post_date || 0) : 0);

  return new Date(lastPostDate);
}

async function updateLastPostDate(siteId) {
  const lastPostDate = await getLastPostDate(siteId);

  return mysqlConnection.execute(
    'UPDATE source SET last_post_date = ? WHERE id = ?',
    [lastPostDate, siteId],
  );
}

async function main() {
  mysqlConnection = await mysql({
    host: env.MYSQL_HOST,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  });
  const sources = await mysqlConnection.execute('SELECT * FROM source WHERE is_locked = 0');
  if (!sources || !sources[0]) {
    throw new Error('empty result set');
  }

  return Promise.all(
    sources.map(source => lockSite(source.id)
      .then(() => getLastPostDate(source.id))
      .then((lastPostDate) => {
        const settings = JSON.parse(source.settings);
        const parser = new Parser(
          source.id,
          settings,
          mysqlConnection,
          lastPostDate,
        );

        return parser.parse();
      })
      .then(() => updateLastPostDate(source.id))
      .then(() => unlockSite(source.id))
      .catch((err) => {
        unlockSite(source.id);

        throw err;
      })),
  ).then(() => mysqlConnection.close());
}

main().catch((err) => {
  console.log(err);
  process.exit(1);
});
