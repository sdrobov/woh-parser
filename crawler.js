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
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 0 WHERE ID = ?', [siteId]);
}

/**
 * unlock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
function unlockSite(siteId) {
  // language=MySQL
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 1 WHERE ID = ?', [siteId]);
}

/**
 * fetches last post date
 * @param siteId
 * @returns {*|PromiseLike<T>|Promise<T>}
 */
function getLastPostDate(siteId) {
  // language=MySQL
  return mysqlConnection
    .executeAsync(
      'SELECT * FROM posts WHERE website_id = ? AND datetime IS NOT NULL ORDER BY datetime DESC LIMIT 1',
      [siteId],
    )
    .then((post) => {
      if (post && post[0]) {
        return new Promise((resolve) => {
          resolve(new Date(post[0].datetime));
        });
      }

      return new Promise((resolve) => {
        resolve(new Date(0));
      });
    });
}

mysqlConnection
  .executeAsync(
    'SELECT sites.*, site_settings.settings FROM sites JOIN site_settings ON sites.ID = site_settings.site_id WHERE Status = 1',
  )
  .then((sites) => {
    if (!sites || !sites[0]) {
      throw new Error('empty result set');
    }

    return Promise.all(
      sites.map(site => lockSite(site.ID)
        .then(() => getLastPostDate(site.ID))
        .then((lastPostDate) => {
          const settings = JSON.parse(site.settings);
          const parser = new Parser(site.ID, settings, mysqlConnection, lastPostDate);

          return parser.parse();
        })
        .then(() => unlockSite(site.ID))
        .catch(() => unlockSite(site.ID))),
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
