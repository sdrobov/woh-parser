const feedparser = require('feedparser-promised');
const moment = require('moment');
const jsdom = require('jsdom');

const { JSDOM } = jsdom;
const sanitizeHTML = require('sanitize-html');
const beautify = require('js-beautify').html;

const { env } = process;

class SiteParser {
  constructor(siteId, settings, mysqlConnection, lastPostDate) {
    this.siteId = siteId;
    this.settings = settings;
    this.lastPostDate = lastPostDate || new Date(0);
    this.mysqlConnection = mysqlConnection;
    this.tagsWhitelist = this.settings.tagsWhitelist || JSON.parse(env.TAGS_WHITELIST);
    this.contentRegexps = this.settings.contentRegexps || JSON.parse(env.GLOBAL_CONTENT_REGEXP);
  }

  parse() {
    if (this.settings.rssUrl) {
      return this.parseRss();
    }

    return this.parseDom();
  }

  parseRss() {
    console.log(`parsing rss-powered site id = ${this.siteId}`);
    return feedparser.parse(this.settings.rssUrl).then((items) => {
      const maxItems = this.settings.limitMax || items.length;

      const articles = items
        .slice(0, maxItems)
        .filter(item => new Date(item.pubdate) <= this.lastPostDate)
        .map((item) => {
          let preview = item.image;
          if (!preview || !preview.url) {
            if (item.enclosures && Array.isArray(item.enclosures)) {
              item.enclosures.some((enclosure) => {
                if (enclosure.url && /jpe?g|gif|png|svg/.test(enclosure.url)) {
                  preview = enclosure;

                  return true;
                }

                return false;
              });
            }
          }

          const article = {
            title: item.title,
            url: item.origlink || item.link,
            pubdate: item.pubdate,
            preview: preview.url || '',
            description: item.summary || null,
          };

          return article;
        });

      return this.parseArticles(articles);
    });
  }

  parseDom(url) {
    console.log(`parsing css-powered site id = ${this.siteId}`);

    const mainUrl = url || this.settings.mainUrl;
    return JSDOM.fromURL(mainUrl, {
      referer: 'https://yandex.ru',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
    }).then((dom) => {
      const titles = dom.window.document.querySelectorAll(this.settings.titlesSelector) || [];
      const dates = [].map.call(
        dom.window.document.querySelectorAll(this.settings.datesSelector) || [],
        (date) => {
          if (this.settings.dateFormat) {
            if (this.settings.dateLocale) {
              return moment(
                sanitizeHTML(date.innerHTML),
                this.settings.dateFormat,
                this.settings.dateLocale,
              ).toDate();
            }

            return moment(sanitizeHTML(date.innerHTML), this.settings.dateFormat).toDate();
          }

          return moment(sanitizeHTML(date.innerHTML)).toDate();
        },
      );
      const links = [].map.call(
        dom.window.document.querySelectorAll(this.settings.linksSelector) || [],
        link => link.href,
      );
      const previews = [].map.call(
        this.settings.previewSelector
          ? dom.window.document.querySelectorAll(this.settings.previewSelector) || []
          : [],
        preview => preview.src,
      );
      const descriptions = this.settings.descriptionSelector
        ? dom.window.document.querySelectorAll(this.settings.descriptionSelector) || []
        : [];

      if (
        titles.length !== dates.length
        || titles.length !== links.length
        || dates.length !== links.length
      ) {
        throw new Error(
          `titles (${titles.length}), dates (${dates.length}) and links (${
            links.length
          }) doesnt match`,
        );
      }

      let articles = [];
      let skipped = false;
      titles.forEach((title, index) => {
        if (new Date(dates[index]) <= this.lastPostDate) {
          skipped = true;
          return;
        }

        articles.push({
          title: title.innerHTML,
          url: links[index],
          pubdate: dates[index],
          preview: previews[index] || '',
          description: descriptions[index] ? descriptions[index].innerHTML : '',
        });
      });

      if (this.settings.limitMax) {
        if (articles.length > this.settings.limitMax) {
          articles = articles.slice(0, this.settings.limitMax);

          return this.parseArticles(articles);
        }
        this.settings.limitMax -= articles.length;
      }

      if (!skipped && this.settings.nextSelector) {
        if (this.settings.pagesMax) {
          this.settings.pagesMax -= 1;

          if (this.settings.pagesMax === 0) {
            return this.parseArticles(articles);
          }
        }

        const nextUrl = dom.window.document.querySelector(this.settings.nextSelector);
        if (nextUrl && nextUrl.href) {
          return this.parseDom(nextUrl.href)
            .then(() => this.parseArticles(articles))
            .catch((err) => {
              this.siteError(err);

              return this.parseArticles(articles);
            });
        }
      }

      return this.parseArticles(articles);
    });
  }

  parseArticles(articles) {
    return Promise.all(
      articles.map((article) => {
        if (!article) {
          return Promise.resolve();
        }

        const currentDate = new Date(article.pubdate);

        return this.getPage(article.url)
          .then(contentAndImage => this.savePost({
            url: article.url,
            title: article.title,
            preview: contentAndImage.preview || article.preview,
            description: article.description,
            image: contentAndImage.image,
            content: contentAndImage.content,
            pubdate: currentDate,
          }))
          .catch((err) => {
            this.siteError(err);
          });
      }),
    );
  }

  getPage(url, contentAdd, firstImage) {
    return JSDOM.fromURL(url, {
      referer: 'https://yandex.ru',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
    }).then((dom) => {
      let image;
      if (!firstImage) {
        image = this.settings.imageSelector
          ? dom.window.document.querySelector(this.settings.imageSelector) || ''
          : '';
        if (image) {
          image = image.src;
        }
      } else {
        image = firstImage;
      }

      let preview;
      if (this.settings.previewFromMeta) {
        preview = dom.window.document.querySelector('meta[property="og:image"]');
        if (preview) {
          preview = preview.content;
        }
      }

      let content = dom.window.document.querySelector(this.settings.contentSelector);
      if (content) {
        content = content.innerHTML;

        if (contentAdd) {
          content = contentAdd + content;
        }

        if (this.settings.nextContentSelector) {
          const nextPage = dom.window.document.querySelector(this.settings.nextContentSelector);
          if (nextPage) {
            const nextPageUrl = nextPage.href;
            return this.getPage(nextPageUrl, content, image);
          }
        }
      } else if (contentAdd) {
        content = contentAdd;
      }

      if (!content) {
        return Promise.reject(new Error(`no content found at url: ${url}`));
      }

      return Promise.resolve({
        content,
        image,
        preview,
      });
    });
  }

  savePost(post) {
    const title = sanitizeHTML(post.title, {
      allowedTags: [],
      allowedAttributes: [],
      allowedClasses: [],
    })
      .toString()
      .replace(/\n/g, ' ')
      .replace(/\s\s+/g, ' ')
      .trim();

    let content = sanitizeHTML(post.content, this.tagsWhitelist)
      .toString()
      .replace(/<[^/>]*>\s*<\/[^>]+>/gm, '')
      .trim();
    this.contentRegexps.forEach((regexp) => {
      const r = new RegExp(regexp.search);
      if (r.test(content)) {
        content = content.replace(r, regexp.replace);
      }
    });
    content = beautify(content, {
      preserve_newlines: false,
      max_preserve_newlines: 1,
      unescape_strings: true,
      html: {
        wrap_line_length: 0,
      },
    });

    const description = sanitizeHTML(post.description, {
      allowedTags: [],
      allowedAttributes: [],
      allowedClasses: [],
    })
      .toString()
      .replace(/\n/g, ' ')
      .replace(/\s\s+/g, ' ')
      .trim();

    console.log(`saving: ${title} for site id = ${this.siteId}`);

    // language=MySQL
    return this.mysqlConnection
      .queryAsync(
        'INSERT INTO post (source_id, source, title, announce, `text`, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          this.siteId,
          post.url,
          title,
          description,
          content,
          post.pubdate,
        ],
      )
      .then((res) => {
        console.log(
          `saved: ${title} for site id = ${this.siteId}, post id = ${
            res.insertId
          }, post pubdate = ${post.pubdate}`,
        );
      })
      .catch((err) => {
        this.siteError(err);
      });
  }

  siteError(error) {
    console.log(error, `site id = ${this.siteId}`);
  }
}

module.exports = SiteParser;
