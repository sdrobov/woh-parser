const feedparser = require('feedparser-promised');
const DomParser = require('./dom');

class RssParser extends DomParser {
  async parse() {
    console.log(`parsing rss-powered site id: ${this.settings.siteId}; lastPostDate: ${this.lastPostDate.toISOString()}`);

    const items = await feedparser.parse({ uri: this.settings.url, gzip: true });
    const maxItems = this.settings.limitMax || items.length;
    const articles = [].slice
      .call(items || [], 0, maxItems)
      .filter(item => !this.lastPostDate || new Date(item.pubdate) > this.lastPostDate)
      .map(item => ({
        title: item.title,
        url: item.origlink || item.link,
        pubdate: item.pubdate,
        description: item.summary || null,
      }));

    return this.parseArticles(articles);
  }
}

module.exports = RssParser;
