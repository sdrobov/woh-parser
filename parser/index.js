const sanitizeHTML = require('sanitize-html');
const { html: beautify } = require('js-beautify');
const YouTubeParser = require('./youtube');
const DomParser = require('./dom');
const RssParser = require('./rss');
const AbstractParser = require('./abstract_parser');

const TYPE_DOM = 1;
const TYPE_RSS = 2;
const TYPE_YOUTUBE = 3;

class Parser extends AbstractParser {
  async parse() {
    if (!this.reallyParse) {
      return [];
    }

    let parser;
    switch (this.settings.type) {
      case TYPE_DOM:
        parser = new DomParser(this.settings);

        break;

      case TYPE_RSS:
        parser = new RssParser(this.settings);

        break;

      case TYPE_YOUTUBE:
        parser = new YouTubeParser(this.settings);

        break;

      default:
        console.error(`unknow or missed site type: ${this.settings.type}; site id: ${this.settings.siteId}`);

        break;
    }

    const result = await parser.parse();

    return [].map.call(result || [], post => this.preparePost(post));
  }

  preparePost(post) {
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

    [].forEach.call(this.contentRegexps || [], ({ search, replace }) => {
      const re = new RegExp(search);
      if (re.test(content)) {
        content = content.replace(re, replace);
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

    return {
      isApproved: this.settings.isApproved,
      siteId: this.settings.siteId,
      title,
      description,
      content,
      pubdate: post.pubdate,
    };
  }
}

module.exports = Parser;
