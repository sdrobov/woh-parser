const { env } = process;

/* eslint-disable class-methods-use-this */
class AbstractParser {
  constructor(settings) {
    this.settings = settings;
    this.lastPostDate = settings.lastPostDate || new Date(0);
    this.tagsWhitelist = this.settings.tagsWhitelist || JSON.parse(env.TAGS_WHITELIST);
    this.contentRegexps = this.settings.contentRegexps || JSON.parse(env.GLOBAL_CONTENT_REGEXP);
    this.reallyParse = (!settings.isApproved && settings.manual) || !!settings.isApproved;
  }

  async parse() {
    console.error('This is AbstractParser::parse method, you should not call it');
  }
}

module.exports = AbstractParser;
