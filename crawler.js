#!/usr/bin/env node
'use strict';

const dotenv = require('dotenv').config();
const mysql = require('mysql2');
const feedparser = require('feedparser');
const jsdom = require('jsdom');
const {JSDOM} = jsdom;
const sanitizeHTML = require('sanitize-html');
const Promise = require('bluebird');
const rp = require('request-promise');
const request = require('request');
const moment = require('moment');
Promise.promisifyAll(require('mysql2/lib/connection').prototype);

const env = process.env;
const mysqlConnection = mysql.createConnection({
  host: env.MYSQL_HOST,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE
});

let postsProcessed = 0;
let sitesLocked = [];

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
    includeNodeLocations: true
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
    [siteId, error, new Date()]
  );
}

/**
 * lock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
function lockSite (siteId) {
  if (sitesLocked.indexOf(siteId) < 0) {
    sitesLocked.push(siteId);
  }

  // language=MySQL
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 1 WHERE ID = ?', [siteId]);
}

/**
 * unlock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
function unlockSite (siteId) {
  let idx = sitesLocked.indexOf(siteId);
  if (idx < 0) {
    return;
  }

  sitesLocked.splice(idx, 1);
  // language=MySQL
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 0 WHERE ID = ?', [siteId]);
}

/**
 * fetches last post date
 * @param siteId
 * @returns {*|PromiseLike<T>|Promise<T>}
 */
function getLastPostDate (siteId) {
  // language=MySQL
  return mysqlConnection.executeAsync(
    'SELECT * FROM posts WHERE website_id = ? AND datetime IS NOT NULL ORDER BY datetime DESC LIMIT 1',
    [siteId]
  ).then(post => {
    if (post && post[0]) {
      return new Promise(resolve => {
        resolve(new Date(post[0].datetime));
      });
    }

    return new Promise(resolve => {
      resolve(new Date(0));
    });
  });
}

/**
 * saves post
 * @param post
 * @returns {*|Promise<T>}
 */
function savePost (post) {
  console.log(`saving: ${post.title} for site id = ${post.siteId}`);

  let title = sanitizeHTML(post.title);
  let content = sanitizeHTML(post.content, {
    allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'img'],
    allowedAttributes: {
      'a': ['href'],
      'img': ['src', 'alt', 'title']
    }
  });
  let description = sanitizeHTML(post.description);

  // language=MySQL
  return mysqlConnection.queryAsync(
    'INSERT INTO posts (website_id, post_URL, post_name, post_image, post_description, post_image_internal, post_content, `datetime`, lastcheck) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    console.log(`saved: ${post.title} for site id = ${post.siteId}, post id = ${res.insertId}`, post.pubdate);
    postsProcessed -= 1;
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

  getLastPostDate(siteId).then(lastPostDate => {
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

        if (lastPostDate >= currentDate) {
          continue;
        }

        rp({
          uri: link,
          transform: itemBody => {
            let options = jsdomOptions(link);

            return new JSDOM(itemBody, options);
          }
        }).then(dom => {
          postsProcessed += 1;
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
  });
}

/**
 * parse site without rss, using css-selectors
 * @param settings
 * @param siteId
 */
function parseDom (settings, siteId) {
  console.log(`parsing css-powered site id = ${siteId}`);

  let lastPostDate;
  getLastPostDate(siteId).then(lpd => {
    lastPostDate = lpd;

    return rp({
      uri: settings.mainUrl,
      transform: body => {
        let options = jsdomOptions(settings.mainUrl);

        return new JSDOM(body, options);
      }
    });
  }).then(dom => {
    let titles = dom.window.document.querySelectorAll(settings.titlesSelector) || [];
    let dates = [].map.call(dom.window.document.querySelectorAll(settings.datesSelector) || [], date => {
      if (settings.dateFormat) {
        if (settings.dateLocale) {
          return moment(sanitizeHTML(date.innerHTML), settings.dateFormat, settings.dateLocale);
        }

        return moment(sanitizeHTML(date.innerHTML), settings.dateFormat);
      }

      return moment(sanitizeHTML(date.innerHTML));
    });
    let links = [].map.call(dom.window.document.querySelectorAll(settings.linksSelector) || [], link => {
      return link.href;
    });
    let previews = [].map.call(settings.previewSelector
      ? (dom.window.document.querySelectorAll(settings.previewSelector) || [])
      : [], preview => {
      return preview.src;
    });
    let descriptions = settings.descriptionSelector
      ? (dom.window.document.querySelectorAll(settings.descriptionSelector) || [])
      : [];

    if (titles.length !== dates.length || titles.length !== links.length || dates.length !== links.length) {
      throw `titles (${titles.length}), dates (${dates.length}) and links (${links.length}) doesnt match`;
    }

    let articles = [];
    for (let i = 0; i < titles.length; i++) {
      articles.push({
        title: titles[i].innerHTML,
        url: links[i],
        pubdate: dates[i],
        preview: previews[i] || '',
        description: descriptions[i] ? descriptions[i].innerHTML : ''
      });
    }

    postsProcessed += articles.length;

    articles.forEach(article => {
      let currentDate = new Date(article.pubdate);
      if (lastPostDate >= currentDate) {
        return;
      }

      rp({
        uri: article.url,
        transform: articleBody => {
          let options = jsdomOptions(article.url);

          return new JSDOM(articleBody, options);
        }
      }).then(dom => {
        let image = settings.imageSelector
          ? dom.window.document.querySelector(settings.imageSelector) || ''
          : '';
        if (image) {
          image = image.src;
        }
        let content = dom.window.document.querySelector(settings.contentSelector).innerHTML;

        return savePost({
          siteId: siteId,
          url: article.url,
          title: article.title,
          image: article.preview,
          description: article.description,
          imageInt: image,
          content: content,
          pubdate: currentDate
        });
      }).catch(err => {
        siteError(err, siteId);
      });
    });

    unlockSite(siteId);
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

    setInterval(() => {
      if (postsProcessed <= 0) {
        if (sitesLocked.length > 0) {
          sitesLocked.forEach(siteId => {
            unlockSite(siteId);
          });
        }

        mysqlConnection.close();
        process.exit();
      }
    }, 1000);
  })
  .catch(err => {
    console.log(err);
    process.exit(1);
  });
