#!/usr/bin/env node
'use strict';

const dotenv = require('dotenv').config();
const mysql = require('mysql2');
const feedparser = require('feedparser');
const jsdom = require('jsdom');
const {JSDOM} = jsdom;
const sanitizeHTML = require('sanitize-html');
const moment = require('moment');
const Promise = require('bluebird');
const rp = require('request-promise');
const request = require('request');
Promise.promisifyAll(require('mysql2/lib/connection').prototype);

const env = process.env;
const mysqlConnection = mysql.createConnection({
  host: env.MYSQL_HOST,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE
});

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
    // runScripts: 'dangerously',
    // pretendToBeVisual: true,
    // resources: 'usable'
  };
}

/**
 * write errors to mysql
 * @param error
 * @param siteId
 * @returns {*|Promise<T>}
 */
function siteError (error, siteId) {
  console.log(error, `site id = ${siteId}`);
  // language=MySQL
  return mysqlConnection.executeAsync(
    'INSERT INTO site_errors (site_id, error, created_at) VALUES (?, ?, ?)',
    [siteId, error, moment().format(env.MYSQL_DATETIME_FORMAT)]
  );
}

function lockSite (siteId) {
  // language=MySQL
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 1 WHERE ID = ?', [siteId]);
}

function unlockSite (siteId) {
  // language=MySQL
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 0 WHERE ID = ?', [siteId]);
}

function cleanHtml (dirtyHtml) {
  return sanitizeHTML(dirtyHtml, {
    allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'img'],
    allowedAttributes: {
      'a': ['href'],
      'img': ['src', 'alt', 'title']
    }
  });
}

/**
 * saves post
 * @param post
 * @returns {*|Promise<T>}
 */
function savePost (post) {
  console.log(`saving: ${post.title} for site id = ${post.siteId}`);
  let title = cleanHtml(post.title);
  let content = cleanHtml(post.content);
  let description = cleanHtml(post.description);
  // language=MySQL
  return mysqlConnection.queryAsync(
    'INSERT INTO posts (website_id, post_URL, post_name, post_image, post_description, post_image_internal, post_content, datetime, lastcheck) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      post.siteId,
      post.url,
      title,
      post.image || '',
      description,
      post.imageInt || '',
      content,
      post.pubdate,
      new Date()
    ]
  ).then(res => {
    console.log(`saved: ${post.title} for site id = ${post.siteId}, post id = ${res.insertId}`);
  }).catch(err => {
    siteError(err, post.siteId);
  });
}

/**
 * parse rss-enabled site
 * @param settings
 * @param siteId
 */
function parseRss (settings, siteId) {
  console.log(`parsing rss-powered site id = ${siteId}`);

  let req = request(settings.rssUrl);
  let feed = new feedparser({resume_saxerror: true});

  req.on('error', err => {
    throw err;
  });
  req.on('response', function (res) {
    if (res.statusCode !== 200) {
      throw `server response !== 200; url = ${settings.rssUrl}`;
    }

    let stream = this;
    stream.pipe(feed);
  });

  feed.on('error', err => {
    throw err;
  });
  feed.on('readable', function () {
    let stream = this;
    let item;

    while (item = stream.read()) {
      let currentDate = new Date(item.pubdate);
      let link = item.origlink || item.link;
      let currentItem = item;

      if (settings.lastPostDate) {
        let lastPostDate = new Date(settings.lastPostDate);

        if (lastPostDate >= currentDate) {
          continue;
        }
      }

      rp({
        uri: link,
        transform: itemBody => {
          let options = jsdomOptions(link);
          return new JSDOM(itemBody, options);
        }
      }).then(dom => {
        let content = dom.window.document.querySelector(settings.contentSelector).innerHTML;

        return savePost({
          siteId: siteId,
          url: link,
          title: currentItem.title,
          image: currentItem.image ? currentItem.image.url : null,
          description: currentItem.summary || null,
          imageInt: null,
          content: content,
          pubdate: currentDate
        });
      }).catch(err => {
        siteError(err, siteId);
      });
    }

    unlockSite(siteId);
  });
}

/**
 * parse site without rss, using css-selectors
 * @param settings
 * @param siteId
 */
function parseDom (settings, siteId) {
  console.log(`parsing css-powered site id = ${siteId}`);
  rp({
    uri: settings.mainUrl,
    transform: body => {
      let options = jsdomOptions(settings.mainUrl);
      return new JSDOM(body, options);
    }
  }).then(dom => {
    let titles = dom.window.document.querySelectorAll(settings.titlesSelector) || [];
    let dates = dom.window.document.querySelectorAll(settings.datesSelector) || [];
    let links = dom.window.document.querySelectorAll(settings.linksSelector) || [];
    let previews = settings.previewSelector
      ? (dom.window.document.querySelectorAll(settings.previewSelector) || [])
      : [];
    let descriptions = settings.descriptionSelector
      ? (dom.window.document.querySelectorAll(settings.descriptionSelector) || [])
      : [];

    if (titles.length === dates.length === links.length) {
      let articles = [];
      for (let i = 0; i < titles.length; i++) {
        articles.push({
          title: titles[i],
          url: links[i],
          pubdate: (new Date(dates[i])),
          preview: previews[i] || null,
          description: descriptions[i] || null
        });
      }

      articles.forEach(article => {
        if (settings.lastPostDate) {
          let lastPostDate = moment(settings.lastPostDate);
          let currentDate = moment(article.pubdate);

          if (lastPostDate >= currentDate) {
            return;
          }
        }

        rp({
          uri: article.url,
          transform: articleBody => {
            let options = jsdomOptions(article.url);
            return new JSDOM(articleBody, options);
          }
        }).then(dom => {
          let image = settings.imageSelector
            ? dom.window.document.querySelector(settings.imageSelector) || null
            : null;
          let content = dom.window.document.querySelector(settings.contentSelector).innerHTML;
          return savePost({
            siteId: siteId,
            url: article.url,
            title: article.title,
            image: article.preview,
            description: article.description,
            imageInt: image,
            content: content,
            pubdate: new Date(article.date)
          });
        }).catch(err => {
          siteError(err, siteId);
        });
      });
    }
  }).then(() => {
    return unlockSite(siteId);
  }).catch(err => {
    siteError(err, siteId);
    unlockSite(siteId);
  });
}

mysqlConnection.executeAsync(
  'SELECT sites.*, site_settings.settings FROM sites JOIN site_settings ON sites.ID = site_settings.site_id WHERE Status = 0')
  .then(sites => {
    if (!sites || !sites[0]) {
      throw 'empty result set';
    }

    sites.forEach(site => {
      lockSite(site['ID']).then(() => {
        const settings = JSON.parse(site['settings']);
        if (settings.rssUrl) {
          try {
            parseRss(settings, site['ID']);
          } catch (err) {
            siteError(err, site['ID']);
            unlockSite(site['ID']);
          }
        } else {
          parseDom(settings, site['ID']);
        }
      }).catch(err => {
        siteError(err, site['ID']);
        unlockSite(site['ID']);
      });
    });
  })
  .catch(err => {
    console.log(err);
    process.exit(1);
  });
