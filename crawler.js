'use strict';

const dotenv = require('dotenv').config();
const mysql = require('mysql2');
const feedparser = require('feedparser');
const jsdom = require('jsdom');
const {JSDOM} = jsdom;
const http = require('http');

/**
 * returns config for jsdom
 * @param link
 * @returns {{url: *, referer: string, contentType: string, userAgent: string, includeNodeLocations: boolean, runScripts: string, pretendToBeVisual: boolean, resources: string}}
 */
function jsdomOptions (link) {
  return {
    url: link,
    referer: 'https://yandex.ru',
    contentType: 'text/html',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
    includeNodeLocations: true,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: 'usable'
  };
}

const env = process.env;
mysql.connect({
  host: env.MYSQL_HOST,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE
}).then(connection => {
  connection.execute('SELECT * FROM sites WHERE status = 0', (err, sites) => {
    if (err) {
      throw err;
    }

    if (!sites || !sites[0]) {
      throw 'empty result set';
    }

    sites.forEach(site => {
      connection.execute('UPDATE sites SET status = 1 WHERE id = ?', [site['id']], (err, result) => {
        if (err) {
          console.log(err);

          return;
        }

        const settings = JSON.parse(site['settings']);
        if (settings.rssUrl) {
          http.get(settings.rssUrl, res => {
            if (res.statusCode !== 200) {
              console.log(`server response !== 200; url = ${settings.rssUrl}`);

              return;
            }

            let feed = new feedparser();
            res.pipe(feed);

            feed.on('error', err => {
              console.log(err);
            });
            feed.on('readable', () => {
              let stream = this;
              let item;

              while (item = stream.read()) {
                if (settings.lastPostDate) {
                  let lastPostDate = new Date(settings.lastPostDate);
                  let currentDate = new Date(item.pubdate);

                  if (lastPostDate >= currentDate) {
                    continue;
                  }
                }

                let link = item.origlink || item.link;
                http.get(link, res => {
                  if (res.statusCode !== 200) {
                    console.log(`server response !== 200; url = ${link}`);

                    return;
                  }

                  let page;
                  res.on('error', err => {
                    console.log(err);
                  });
                  res.on('data', chunk => {
                    page += chunk;
                  });
                  res.on('end', () => {
                    let options = jsdomOptions(link);
                    let dom = new JSDOM(page, options);
                  });
                });
              }
            });
          });
        }
      });
    });
  });
}).catch(err => {
  console.log(err);
  process.exit(1);
});
