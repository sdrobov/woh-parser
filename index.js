#!/usr/bin/env node

const path = require('path');
const { config: dotenv } = require('dotenv');
const { createConnection: mysql } = require('mysql2/promise');
const express = require('express');
const Parser = require('./parser');
const consolePolyfill = require('./console');

dotenv({ path: path.resolve(__dirname, '.env') });

consolePolyfill();

const { env } = process;
let mysqlConnection = null;
const app = express();
let loopTimeout = null;
let httpServer = null;

/**
 * lock site for processing
 * @param {number} siteId
 * @returns {Promise<Array>}
 */
async function lockSite(siteId) {
  return mysqlConnection.execute('UPDATE source SET is_locked = 1 WHERE id = ?', [siteId]);
}

/**
 * unlock site for processing
 * @param {number} siteId
 * @param {boolean} success
 * @returns {Promise<Array>}
 */
async function unlockSite(siteId) {
  return mysqlConnection.execute('UPDATE source SET is_locked = 0 WHERE id = ?', [siteId]);
}

async function updateLastPostDate(siteId, lastPostDate) {
  return mysqlConnection.execute('UPDATE source SET last_post_date = ? WHERE id = ?', [
    lastPostDate,
    siteId,
  ]);
}

async function savePost(post) {
  try {
    const [res] = await mysqlConnection.query(
      `INSERT INTO ${
        post.isApproved ? 'post' : 'source_post_preview'
      } (source_id, title, announce, \`text\`, created_at) VALUES (?, ?, ?, ?, ?)`,
      [post.siteId, post.title, post.description, post.content, post.pubdate],
    );

    console.info(`saved: post id = ${res.insertId}; site id: ${post.siteId}, post pubdate: ${post.pubdate.toISOString()}`);
  } catch (e) {
    console.error(e);
    console.error(post);
  }
}

/**
 * @param {number} sourceId
 * @param {Date} begin
 * @param {Date} end
 * @param {number} parsed
 * @param {boolean} isSuccess
 * @param {string} error
 */
async function writeSourceStats(sourceId, begin, end, parsed, isSuccess, error) {
  return mysqlConnection.execute('INSERT INTO source_stat VALUES(?, ?, ?, ?, ?, ?)', [sourceId, begin, end, parsed, isSuccess, error]);
}

async function parseSource(source) {
  const begin = new Date();

  try {
    await lockSite(source.id);

    const settings = JSON.parse(source.settings);
    settings.manual = source.manual || false;
    settings.siteId = source.id;
    settings.lastPostDate = source.last_post_date;

    const parser = new Parser(settings);

    const posts = await parser.parse();
    const lastPostDate = [].reduce.call(
      posts || [],
      (last, post) => (post.pubdate > last ? post.pubdate : last),
      settings.lastPostDate,
    ) || settings.lastPostDate;
    [].forEach.call(posts || [], savePost);

    await updateLastPostDate(source.id, lastPostDate);
    await unlockSite(source.id);

    const end = new Date();
    await writeSourceStats(source.id, begin, end, (posts || []).length, true, null);
  } catch (e) {
    console.error(e);

    await unlockSite(source.id);

    const end = new Date();
    await writeSourceStats(source.id, begin, end, null, false, e);
  }
}

async function connectToMysql() {
  if (!mysqlConnection) {
    mysqlConnection = await mysql({
      host: env.MYSQL_HOST,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
    });
  }
}

app.get('/', async (req, res) => {
  const { sourceId } = req.query;
  if (!sourceId) {
    res.status(400)
      .json({ error: 'source id is required' });

    return;
  }

  await connectToMysql();

  const [[source]] = await mysqlConnection.execute(
    'SELECT * FROM source WHERE is_locked = 0 AND id = ?',
    [sourceId],
  );
  if (!source) {
    res.status(404)
      .json({ error: 'source not found' });

    return;
  }

  source.manual = true;
  parseSource(source);

  res.status(200)
    .json({ status: 'source is parsing' });
});

async function parserLoop() {
  await connectToMysql();

  loopTimeout = setTimeout(parserLoop, 60000);

  const [sources] = await mysqlConnection.execute('SELECT * FROM source WHERE is_locked = 0 AND is_enabled = 1');

  [].forEach.call(sources || [], parseSource);
}

async function unlockAllSources() {
  await connectToMysql();

  await mysqlConnection.execute('UPDATE source SET is_locked = 0 WHERE is_enabled = 1');
}

async function main() {
  httpServer = app.listen(env.PORT || 8080);

  if (process.send) {
    process.send('ready');
  }

  await unlockAllSources();
  await parserLoop();
}

process.on('SIGINT', () => {
  httpServer.close(async (err) => {
    clearTimeout(loopTimeout);

    await unlockAllSources();
    await mysqlConnection.end();

    if (err) {
      console.error(err);

      process.exit(1);
    }

    process.exit(0);
  });
});

main()
  .catch((err) => {
    console.error(err);

    process.exit(1);
  });
