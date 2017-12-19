#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({path: path.resolve(__dirname, '.env')});
const mysql = require('mysql2');
const feedparser = require('feedparser-promised');
const jsdom = require('jsdom');
const {JSDOM} = jsdom;
const sanitizeHTML = require('sanitize-html');
const Promise = require('bluebird');
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
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 0 WHERE ID = ?', [siteId]);
}

/**
 * unlock site for processing
 * @param siteId
 * @returns {*|Promise<T>}
 */
function unlockSite (siteId) {
  // language=MySQL
  return mysqlConnection.executeAsync('UPDATE sites SET Status = 1 WHERE ID = ?', [siteId]);
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
function savePost (post, settings) {
  let title = sanitizeHTML(post.title, { allowedTags: false, allowedAttributes: false }).toString().trim();
  let tagsWhitelist = settings.tagsWhitelist || JSON.parse(env.TAGS_WHITELIST);
  let content = sanitizeHTML(post.content, tagsWhitelist).toString().trim();
  let contentRegexps = settings.contentRegexps || JSON.parse(env.GLOBAL_CONTENT_REGEXP);
  contentRegexps.forEach(regexp => {
    let r = new RegExp(regexp.search);
    if (r.test(content)) {
      content = content.replace(r, regexp.replace);
    }
  });
  let description = sanitizeHTML(post.description, { allowedTags: false, allowedAttributes: false }).toString().trim();

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

function getPage (url, settings, contentAdd, firstImage) {
  return JSDOM.fromURL(url, {
    referer: 'https://yandex.ru',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36'
  }).then(dom => {
    let image;
    if (!firstImage) {
      image = settings.imageSelector
        ? dom.window.document.querySelector(settings.imageSelector) || ''
        : '';
      if (image) {
        image = image.src;
      }
    } else {
      image = firstImage;
    }

    let content = dom.window.document.querySelector(settings.contentSelector);
    if (content) {
      content = content.innerHTML;

      if (contentAdd) {
        content = contentAdd + content;
      }

      if (settings.nextContentSelector) {
        let nextPage = dom.window.document.querySelector(settings.nextContentSelector);
        if (nextPage) {
          let nextPageUrl = nextPage.href;
          return getPage(nextPageUrl, settings, content, image);
        }
      }
    } else if (contentAdd) {
      content = contentAdd;
    }

    if (!content) {
      return Promise.reject(new Error(`no content found at url: ${url}`));
    }

    return Promise.resolve({content: content, image: image});
  });
}

function parseArticles (articles, settings, siteId) {
  return Promise.all(articles.map(article => {
    if (!article) {
      return Promise.resolve();
    }

    let currentDate = new Date(article.pubdate);

    return getPage(article.url, settings).then(contentAndImage => {
      return savePost({
        siteId: siteId,
        url: article.url,
        title: article.title,
        image: article.preview,
        description: article.description,
        imageInt: contentAndImage.image,
        content: contentAndImage.content,
        pubdate: currentDate
      }, settings);
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
    let maxItems = settings.limitMax || items.length;

    let articles = items.slice(0, maxItems).map(item => {
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

    return JSDOM.fromURL(settings.mainUrl, {
      referer: 'https://yandex.ru',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36'
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

    if (settings.limitMax) {
      if (articles.length > settings.limitMax) {
        articles = articles.slice(0, settings.limitMax);

        return parseArticles(articles, settings, siteId);
      } else {
        settings.limitMax -= articles.length;
      }
    }

    if (!skipped && settings.nextSelector) {
      if (settings.pagesMax) {
        settings.pagesMax -= 1;

        if (settings.pagesMax === 0) {
          return parseArticles(articles, settings, siteId);
        }
      }

      let newSettings = settings;
      let nextUrl = dom.window.document.querySelector(settings.nextSelector);
      if (nextUrl && nextUrl.href) {
        newSettings.mainUrl = nextUrl.href;

        return parseDom(newSettings, siteId)
          .then(() => {
            return parseArticles(articles, settings, siteId);
          }).catch(err => {
            siteError(err, siteId);

            return parseArticles(articles, settings, siteId);
          });
      }
    }

    return parseArticles(articles, settings, siteId);
  });
}

mysqlConnection.executeAsync(
  'SELECT sites.*, site_settings.settings FROM sites JOIN site_settings ON sites.ID = site_settings.site_id WHERE Status = 1')
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
