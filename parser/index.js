const feedparser = require('feedparser-promised');
const moment = require('moment');
const { JSDOM } = require('jsdom');
const sanitizeHTML = require('sanitize-html');
const { html: beautify } = require('js-beautify');
const axios = require('axios');

const { env } = process;

const TYPE_DOM = 1;
const TYPE_RSS = 2;
const TYPE_YOUTUBE = 3;

class SiteParser {
  constructor(siteId, settings, mysqlConnection, lastPostDate) {
    this.siteId = siteId;
    this.isApproved = !!settings.isApproved;
    this.settings = settings;
    this.lastPostDate = lastPostDate || new Date(0);
    this.mysqlConnection = mysqlConnection;
    this.tagsWhitelist = this.settings.tagsWhitelist || JSON.parse(env.TAGS_WHITELIST);
    this.contentRegexps = this.settings.contentRegexps || JSON.parse(env.GLOBAL_CONTENT_REGEXP);
  }

  async parse() {
    // eslint-disable-next-line default-case
    switch (this.settings.type) {
      case TYPE_DOM:
        return this.parseDom();

      case TYPE_RSS:
        return this.parseRss();

      case TYPE_YOUTUBE:
        return this.parseYoutube();
    }

    throw new Error('unknow or missed site type');
  }

  async parseYoutube() {
    console.log(`parsing youtube site id = ${this.siteId}`);

    const apiKey = env.GAPI_KEY;
    const response = await axios(
      `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${
        this.settings.url
      }&part=snippet,id&order=date&maxResults=50`,
    );
    const { items } = JSON.parse(response);
    [].filter
      .call(items || [], video => new Date(video.snippet.publishedAt) >= this.lastPostDate)
      .map(async (video) => {
        await this.savePost({
          url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          title: video.snippet.title,
          description: video.snippet.description,
          content: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          pubdate: new Date(video.snippet.publishedAt),
        });
      });
  }

  async parseRss() {
    console.log(`parsing rss-powered site id = ${this.siteId}`);

    const items = await feedparser.parse(this.settings.url);
    const maxItems = this.settings.limitMax || items.length;
    const articles = [].slice
      .call(items || [], 0, maxItems)
      .filter(item => !this.lastPostDate || new Date(item.pubdate) >= this.lastPostDate)
      .map((item) => {
        const article = {
          title: item.title,
          url: item.origlink || item.link,
          pubdate: item.pubdate,
          description: item.summary || null,
        };

        return article;
      });

    return this.parseArticles(articles);
  }

  async parseDom(url) {
    console.log(`parsing css-powered site id = ${this.siteId}`);

    const mainUrl = url || this.settings.url;

    const dom = await JSDOM.fromURL(mainUrl, {
      referer: 'https://yandex.ru',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
    });

    const titles = dom.window.document.querySelectorAll(this.settings.titlesSelector) || [];
    const rawDates = dom.window.document.querySelectorAll(this.settings.datesSelector) || [];
    const dates = [].map.call(rawDates, (date) => {
      const args = [sanitizeHTML(date.innerHTML)];
      if (this.settings.dateFormat) {
        args.push(this.settings.dateFormat);

        if (this.settings.dateLocale) {
          args.push(this.settings.dateLocale);
        }
      }

      return moment(...args).toDate();
    });

    const rawLinks = dom.window.document.querySelectorAll(this.settings.linksSelector) || [];
    const links = [].map.call(rawLinks, link => link.href);

    const descriptions = this.settings.descriptionSelector
      ? dom.window.document.querySelectorAll(this.settings.descriptionSelector) || []
      : [];

    if (titles.length !== links.length) {
      throw new Error(`titles (${titles.length}) and links (${links.length}) doesnt match`);
    }

    let articles = [];
    let skipped = false;
    titles.forEach((title, index) => {
      if (new Date(dates[index]) <= this.lastPostDate) {
        skipped = true;

        return;
      }

      articles.push({
        title: sanitizeHTML(title.innerHTML),
        url: links[index],
        pubdate: dates[index],
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
  }

  parseArticles(articles) {
    [].filter.call(articles || [], article => !!article)
      .forEach(async (article) => {
        const content = await this.getPage(article.url);
        await this.savePost({
          url: article.url,
          title: article.title,
          description: article.description,
          content,
          pubdate: new Date(article.pubdate),
        });
      });
  }

  async getPage(url, contentAdd) {
    const dom = await JSDOM.fromURL(url, {
      referer: 'https://yandex.ru',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
    });

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

          return this.getPage(nextPageUrl, content);
        }
      }
    } else if (contentAdd) {
      content = contentAdd;
    }

    if (!content) {
      throw new Error(`no content found at url: ${url}`);
    }

    return content;
  }

  async savePost(post) {
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

    try {
      const res = await this.mysqlConnection.query(
        `INSERT INTO ${
          this.isApproved ? 'post' : 'source_post_preview'
        } (source_id, title, announce, \`text\`, created_at) VALUES (?, ?, ?, ?, ?)`,
        [this.siteId, title, description, content, post.pubdate],
      );

      console.log(
        `saved: ${title} for site id = ${this.siteId}, post id = ${res.insertId}, post pubdate = ${
          post.pubdate
        }`,
      );
    } catch (err) {
      this.siteError(err);
    }
  }

  siteError(error) {
    console.log(error, `site id = ${this.siteId}`);
  }
}

module.exports = SiteParser;
