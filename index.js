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
 * @param {number} siteId
 * @returns {Promise<Array>}
 */
async function lockSite(siteId) {
  return mysqlConnection.execute(
    'UPDATE source SET is_locked = 1 WHERE id = ?',
    [siteId],
  );
}

/**
 * unlock site for processing
 * @param {number} siteId
 * @returns {Promise<Array>}
 */
async function unlockSite(siteId) {
  return mysqlConnection.execute(
    'UPDATE source SET is_locked = 0 WHERE id = ?',
    [siteId],
  );
}

/**
 * @param {number} siteId
 * @returns {Promise<Date>}
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
  if (!mysqlConnection) {
    mysqlConnection = await mysql({
      host: env.MYSQL_HOST,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
    });
  }

  setInterval(main, 60000);

  const [sources] = await mysqlConnection.execute('SELECT * FROM source WHERE is_locked = 0');

  [].forEach.call(sources || [], async (source) => {
    try {
      await lockSite(source.id);

      const lastPostDate = await getLastPostDate(source.id);
      const settings = JSON.parse(source.settings);
      const parser = new Parser(
        source.id,
        settings,
        mysqlConnection,
        lastPostDate,
      );

      await parser.parse();
      await updateLastPostDate(source.id);
      await unlockSite(source.id);
    } catch (e) {
      console.error(e);

      await unlockSite(source.id);
    }
  });
}

main();
