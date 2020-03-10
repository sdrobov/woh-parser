const axios = require('axios');
const Sentry = require('@sentry/node');
const AbstractParser = require('./abstract_parser');

const { env } = process;

class YouTubeParser extends AbstractParser {
  async parse() {
    console.info(`parsing youtube, site id: ${this.settings.siteId}; lastPostDate: ${this.lastPostDate.toISOString()}`);

    const isUser = /\/user\//.test(this.settings.url);
    const channelId = isUser
      ? /\/user\/([^/?]+)/.exec(this.settings.url)
      : /\/channel\/([^/?]+)/.exec(this.settings.url);

    if (!channelId) {
      Sentry.captureException(`cant parse channelId for source: ${this.settings.siteId}; url: ${this.settings.url}`);
      return [];
    }

    const apiKey = env.GAPI_KEY;
    const { data } = await axios('https://www.googleapis.com/youtube/v3/search'
      + `?key=${apiKey}`
      + `&${isUser ? 'userId' : 'channelId'}=${channelId[1]}`
      + '&part=snippet,id'
      + '&order=date'
      + '&maxResults=50') || {};

    return [].filter
      .call(data.items || [], video => new Date(video.snippet.publishedAt) > this.lastPostDate)
      .map(video => ({
        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
        title: video.snippet.title,
        description: video.snippet.description,
        content: `https://www.youtube.com/watch?v=${video.id.videoId}`,
        pubdate: new Date(video.snippet.publishedAt),
      }));
  }
}

module.exports = YouTubeParser;
