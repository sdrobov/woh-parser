#!/usr/bin/env node

const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const Parser = require('./parser');

dotenv.config();
const { env } = process;
const mysqlConnection = mysql.createConnection({
  host: env.MYSQL_HOST,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
});

/**
 * lock site for processing
 * @param {number} siteId
 * @returns {Promise<Array>}
 */
function lockSite(siteId) {
  return mysqlConnection.execute('UPDATE source SET is_locked = 1 WHERE id = ?', [siteId]);
}

/**
 * unlock site for processing
 * @param {number} siteId
 * @returns {Promise<Array>}
 */
function unlockSite(siteId) {
  return mysqlConnection.execute('UPDATE source SET is_locked = 0 WHERE id = ?', [siteId]);
}

/**
 * @param {number} siteId
 * @returns {Promise<Date>}
 */
async function getLastPostDate(siteId) {
  const [[source]] = await mysqlConnection.execute('SELECT * FROM source WHERE id = ?', [siteId]);
  return (source
    ? Promise.resolve(new Date(source.last_post_date || 0))
    : Promise.resolve(new Date(0)));
}

/**
 * @param {number} siteId
 */
async function updateLastPostDate(siteId) {
  const lastPostDate = await getLastPostDate(siteId);
  mysqlConnection.execute('UPDATE source SET last_post_date = ? WHERE id = ?', [
    lastPostDate,
    siteId,
  ]);
}

mysqlConnection
  .execute('SELECT * FROM source WHERE is_locked = 0')
  .then((sources) => {
    if (!sources || !sources[0]) {
      throw new Error('empty result set');
    }

    return Promise.all(
      sources.map(source => lockSite(source.id)
        .then(() => getLastPostDate(source.id))
        .then((lastPostDate) => {
          const settings = JSON.parse(source.settings);
          const parser = new Parser(source.id, settings, mysqlConnection, lastPostDate);

          return parser.parse();
        })
        .then(() => updateLastPostDate(source.id))
        .then(() => unlockSite(source.id))
        .catch((err) => {
          unlockSite(source.id);

          throw err;
        })),
    );
  })
  .then(() => {
    mysqlConnection.close();
    process.exit();
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
