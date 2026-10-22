const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer so Render / CI bundles Chrome with the repo build
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
