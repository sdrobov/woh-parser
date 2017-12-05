#!/usr/bin/env node
'use strict';

const dotenv = require('dotenv').config();
const mysql = require('mysql2');
const feedparser = require('feedparser-promised');
const jsdom = require('jsdom');
const {JSDOM} = jsdom;
const sanitizeHTML = require('sanitize-html');
const Promise = require('bluebird');
const request = require('request-promise');
const moment = require('moment');
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
  // language=MySQL
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 1 WHERE ID = ?', [siteId]);
}

/**
 * unlock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
function unlockSite (siteId) {
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
  let title = sanitizeHTML(post.title).toString().trim();
  let content = sanitizeHTML(post.content, {
    allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'img'],
    allowedAttributes: {
      'a': ['href'],
      'img': ['src', 'alt', 'title']
    }
  }).toString().trim();
  let description = sanitizeHTML(post.description).toString().trim();

  console.log(`saving: ${title} for site id = ${post.siteId}`);

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
    console.log(`saved: ${title} for site id = ${post.siteId}, post id = ${res.insertId}, post pubdate = ${post.pubdate}`);
  }).catch(err => {
    siteError(err, post.siteId);
  });
}

function parseArticles (articles, settings, siteId) {
  return Promise.all(articles.map(article => {
    if (!article) {
      return Promise.resolve();
    }

    let currentDate = new Date(article.pubdate);

    return request({
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
  }));
}

/**
 * parse rss-enabled site
 * @param settings
 * @param siteId
 */
function parseRss (settings, siteId) {
  console.log(`parsing rss-powered site id = ${siteId}`);

  let lastPostDate;
  return getLastPostDate(siteId).then(lpd => {
    lastPostDate = lpd;

    return feedparser.parse(settings.rssUrl);
  }).then(items => {
    let articles = items.map(item => {
      let currentDate = new Date(item.pubdate);
      if (lastPostDate >= currentDate) {
        return;
      }

      return {
        title: item.title,
        url: item.origlink || item.link,
        pubdate: item.pubdate,
        preview: item.image ? item.image.url : '',
        description: item.summary || null
      };
    });

    return parseArticles(articles, settings, siteId);
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
  return getLastPostDate(siteId).then(lpd => {
    lastPostDate = lpd;

    return request({
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
    let skipped = false;
    for (let i = 0; i < titles.length; i++) {
      if (new Date(dates[i]) <= lastPostDate) {
        skipped = true;
        continue;
      }

      articles.push({
        title: titles[i].innerHTML,
        url: links[i],
        pubdate: dates[i],
        preview: previews[i] || '',
        description: descriptions[i] ? descriptions[i].innerHTML : ''
      });
    }

    if (!skipped && settings.nextSelector) {
      let newSettings = settings;
      let nextUrl = dom.window.document.querySelector(settings.nextSelector);
      if (nextUrl && nextUrl.href) {
        newSettings.mainUrl = nextUrl.href;

        return parseDom(newSettings, siteId)
          .then(() => {
            return parseArticles(articles, newSettings, siteId);
          }).catch(err => {
            siteError(err, siteId);

            return parseArticles(articles, newSettings, siteId);
          });
      }
    }

    return parseArticles(articles, settings, siteId);
  });
}

mysqlConnection.executeAsync(
  'SELECT sites.*, site_settings.settings FROM sites JOIN site_settings ON sites.ID = site_settings.site_id WHERE Status = 0')
  .then(sites => {
    if (!sites || !sites[0]) {
      throw 'empty result set';
    }

    return Promise.all(sites.map(site => {
      return lockSite(site['ID']).then(() => {
        const settings = JSON.parse(site['settings']);
        if (settings.rssUrl) {
          return parseRss(settings, site['ID']);
        } else {
          return parseDom(settings, site['ID']);
        }
      }).then(() => {
        return unlockSite(site['ID']);
      }).catch(err => {
        siteError(err, site['ID']);

        return unlockSite(site['ID']);
      });
    }));
  })
  .then(() => {
    mysqlConnection.close();
    process.exit();
  })
  .catch(err => {
    console.log(err);
    process.exit(1);
  });
