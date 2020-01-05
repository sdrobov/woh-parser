/* eslint-disable no-param-reassign */
const { JSDOM, VirtualConsole } = require('jsdom');
const sanitizeHTML = require('sanitize-html');
const moment = require('moment');
const axios = require('axios');
const AbstractParser = require('./abstract_parser');

const { env } = process;

class DomParser extends AbstractParser {
  async parse() {
    console.info(`parsing dom-powered site id: ${this.settins.siteId}; lastPostDate: ${this.lastPostDate.toISOString()}`);

    const mainUrl = this.settings.url;

    const dom = await JSDOM.fromURL(mainUrl, {
      referer: env.UA_REFERER,
      userAgent: env.UA_STRING,
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
      console.error(`titles (${titles.length}) and links (${links.length}) doesnt match`);

      return [];
    }

    let articles = [];
    let skipped = false;
    titles.forEach((title, index) => {
      if (new Date(dates[index]) < this.settings.lastPostDate) {
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
        this.settings.url = nextUrl.href;

        try {
          await this.parse(this.settings);
        } catch (e) {
          console.error(e, `site id = ${this.settings.siteId}`);
        }
      }
    }

    return this.parseArticles(articles);
  }

  async parseArticles(articles) {
    return [].filter.call(articles || [], article => !!article)
      .map(async (article) => {
        const content = await this.getPage(article.url);

        return {
          url: article.url,
          title: article.title,
          description: article.description,
          content,
          pubdate: new Date(article.pubdate),
        };
      });
  }

  async getPage(url, contentAdd) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', () => { });
    virtualConsole.on('warn', () => { });
    virtualConsole.on('info', () => { });
    virtualConsole.on('dir', () => { });

    const dom = await JSDOM.fromURL(url, {
      referer: env.UA_REFERER,
      userAgent: env.UA_STRING,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
    }).catch((e) => { console.warn(e); });

    const html = dom.serialize();

    const article = await axios.post(`http://${env.PARSER_HOST}:${env.PARSER_PORT}/article`, {
      url,
      body: html,
    }).catch((e) => {
      console.error(e);
    });

    let content;
    if (article.data) {
      content = article.data.text;
    } else {
      content = dom.window.document.querySelector(this.settings.contentSelector);
      content = content ? content.innerHTML : content;
    }

    if (content) {
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
    } else {
      return '';
    }

    return content;
  }
}

module.exports = DomParser;
