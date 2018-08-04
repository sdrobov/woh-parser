#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const mysql = require('mysql2');
const Promise = require('bluebird');
const Parser = require('./parser');
Promise.promisifyAll(require('mysql2/lib/connection').prototype);

const { env } = process;
const mysqlConnection = mysql.createConnection({
  host: env.MYSQL_HOST,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
});

/**
 * lock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
function lockSite(siteId) {
  // language=MySQL
  return mysqlConnection.executeAsync(
    'UPDATE source SET is_locked = 1 WHERE id = ?',
    [siteId],
  );
}

/**
 * unlock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
function unlockSite(siteId) {
  // language=MySQL
  return mysqlConnection.executeAsync(
    'UPDATE source SET is_locked = 0 WHERE id = ?',
    [siteId],
  );
}

/**
 * fetches last post date
 * @param siteId
 * @returns {*|PromiseLike<T>|Promise<T>}
 */
function getLastPostDate(siteId) {
  // language=MySQL
  return mysqlConnection
    .executeAsync('SELECT * FROM source WHERE id = ?', [siteId])
    .then((source) => {
      if (source && source[0]) {
        return new Promise((resolve) => {
          resolve(new Date(source[0].last_post_date || 0));
        });
      }

      return new Promise((resolve) => {
        resolve(new Date(0));
      });
    });
}

function updateLastPostDate(siteId) {
  return mysqlConnection
    .executeAsync(
      'SELECT * FROM post WHERE source_id = ? ORDER BY created_at DESC LIMIT 1',
      [siteId],
    )
    .then((lastPost) => {
      if (!lastPost || !lastPost[0]) {
        return Promise.resolve();
      }

      return Promise.resolve(new Date(lastPost[0].created_at || 0));
    });
}

mysqlConnection
  .executeAsync('SELECT * FROM source WHERE is_locked = 0')
  .then((sources) => {
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
        .catch(() => unlockSite(source.id))),
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
