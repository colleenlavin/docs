var fs = require('fs');
var path = require('path');
var metalsmith = require('../scripts/metalsmith');
var Crawler = require('simplecrawler');
var cheerio = require('cheerio');
var url = require('url');
var util = require('util');
var chalk = require('chalk');
var _ = require('lodash');

// Ignore links to these hosts since they occasionally fail on Travis
// even though the links are valid. It's worth the risk of dead links to
// avoid flaky builds
var ignoreHosts = [
  'vimeo.com',
  'tools.usps.com',
  'www.microsoft.com',
  'www.mouser.com',
  'www.oracle.com',
  'datasheets.maximintegrated.com',
  // Broken webserver that returns 404 not found for regular pages
  'www.emaxmodel.com',
  'mingw.org', // seems to be a temporary server problem, will check back later
  'www.st.com', // randomly returns 403 errors
  '192.168.0.1',
];
var devices = ['photon', 'electron', 'argon', 'boron'];
var isPullRequest = process.env.TRAVIS_PULL_REQUEST && process.env.TRAVIS_PULL_REQUEST !== 'false';

var stats = {
  kept:0,     // urls kept in cache (not expired)
  removed:0,  // urls removed from cache (expired)
  inCache:0,  // urls found in cache and not checked
  fetchAttempt:0,  // urls checked
  crawled:0,  // urls crawled
  errors:0    // number of broken links
}

var crawlerConfigPath = path.join(__dirname, '../config/crawler.json'); 
console.log('crawlerConfigPath=' + crawlerConfigPath);
var crawlerData = {};
if (fs.existsSync(crawlerConfigPath)) {
    crawlerData = JSON.parse(fs.readFileSync(crawlerConfigPath));

    if (crawlerData['urls']) {
      // Remove URLs that have been read more than 7 days ago
      var oldest = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
      
      for (const url in crawlerData.urls) {
        if (crawlerData.urls[url].time < oldest) {
          delete crawlerData.urls[url];
          stats.removed++;
        }
        else {
          stats.kept++;
        }
      }
      console.log(stats.kept + " urls in cache, removed " + stats.removed + " expired");
    }
}
if (crawlerData['urls'] == undefined) {
  crawlerData.urls = {};
}

function classifyUrl(item) {
  var info = {
    external: item.host !== 'localhost',
    image: item.path.match(/\.[png|jpg|jpeg|bmp|gif]/i),
    autogeneratedApiLink: item.host === 'localhost' && item.path.indexOf('/reference/device-cloud/api/') === 0,
    isFirmwareReference: item.path.indexOf('/reference/device-os/firmware') === 0,
    isGithubReferrerLink: item.referrer && (item.referrer.indexOf('https://github.com') === 0)
  };
  return info;
}

function shouldCrawl(qurl) {
  if (qurl.indexOf('#') === 0) {
    return false;
  }
  return true;
}

function saveUrlToCrawlerData(url) {
  crawlerData.urls[url] = {
    url: url,
    time: Math.floor(Date.now() / 1000)
  }
}

describe('Crawler', function() {
  before(function(done) {
    this.timeout(240000);

    console.log('Building...');
    server = metalsmith.test(done);
  });

  after(function(done) {
    this.timeout(120000);

    server.shutdown(function(err) {
      if (err) {
        return done(err);
      }
      console.log('Compressing...');
      metalsmith.compress(done);
    });
  });

  it('should complete without error', function(done) {
    this.timeout(600000);

    if (process.env.TRAVIS_EVENT_TYPE && process.env.TRAVIS_EVENT_TYPE !== 'cron') {
      console.log('Skipping crawl, not a cron build');
      done();
      return;
    }

    var crawler = new Crawler('localhost', '/', 8081);
    crawler.maxConcurrency = 8;
    crawler.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.134 Safari/537.36';
    crawler.acceptCookies = false;
    crawler.timeout = 30000;
    crawler.filterByDomain = false;
    crawler.interval = 5;
    crawler.supportedMimeTypes = [/^text\//i];
    crawler.downloadUnsupported = false;

    crawler.addFetchCondition(function(parsedUrl) {
      return parsedUrl.protocol !== 'mailto';
    });
    crawler.addFetchCondition(function(parsedUrl) {
      return !(parsedUrl.host === 'localhost' && parsedUrl.port === 35729);
    });
    ignoreHosts.forEach(host => {
      crawler.addFetchCondition(function(parsedUrl) {
        return (parsedUrl.host !== host);
      });
    });

    crawler.addDownloadCondition(function(queueItem) {
      var uriis = classifyUrl(queueItem);
      if (uriis.external && queueItem.stateData.code === 200) {
        // If the URL was external, save it in the download state
        saveUrlToCrawlerData(queueItem.url);
      }

      // addDownloadCondition must return true to download the body or false to stop after the header
      // uriis.external is true if the URL is *not* a localhost URL
      // So !uriis.external downloads only our own URL on our local server (our pages) and does not crawl
      // external pages (as the body is never downloaded)
      return !uriis.external;
    });


    crawler.addDownloadCondition(function(queueItem) {
      if (queueItem.stateData && queueItem.stateData.contentType && queueItem.stateData.contentType !== 'text/html') {
        // console.log('canceling download of ' + queueItem.url);

        return false;
      }
      else {
        return true;
      }
    });


    crawler.discoverResources = function(buf, queueItem) {
      // discoverResources takes a Buffer containing the page, a queueItem with the page metadata (URL, etc.)
      // It could return the found resources, but we instead add them using crawler.queueURL.
      var urlis = classifyUrl(queueItem);
      if (urlis.external || urlis.image) {
        // This check should not be reached because we stop download of external resources and non-html files
        // using addDownloadCondition() so there's nothing in the content to discover
        return [];
      }

      stats.crawled++;

      var $ = cheerio.load(buf.toString(), {
        normalizeWhitespace: false,
        xmlMode: false,
        decodeEntities: true
      });

      var parsedUrl = url.parse(queueItem.url);
      // is this the redirector page? follow device tree from here
      // this might make the crawl take ALOT longer
      if ($('#device-redirector').length === 1) {
        // determine if fromUrl was device specific
        var selectDevice;
        var parsedFromUrl = url.parse(queueItem.referrer);
        var devicePath = _.intersection(parsedFromUrl.pathname.split('/'), devices);
        if (devicePath.length > 0) {
          selectDevice = devicePath[0];
        }

        $('ul.devices').find('a').each(function(index, a) {
          // if we come from a device-specific page, only choose that device link forward
          if (selectDevice && $(a).attr('id') !== (selectDevice + '-link')) {
            return [];
          }

          var toQueueUrl = $(a).attr('href');

          // include hash used to access redirector
          var absolutePath = url.resolve(queueItem.url, toQueueUrl) + (parsedUrl.hash || '');
          // preserve original fromUrl and content
          // c.queue([{
          //   uri: absolutePath,
          //   callback: crawlCallback.bind(null, fromUrl, absolutePath, content)
          // }]);
          if (!queueItem.meta) {
            console.log(queueItem);
          }
          crawler.queueURL(absolutePath, queueItem, { content: queueItem.meta.content });
        });
        return [];
      }

      // make sure the hash used is valid on this page
      if (parsedUrl.hash) {
        if (urlis.autogeneratedApiLink) {
  
          return [];
        }

        if ($(parsedUrl.hash).length === 0) {
          console.error(chalk.red(util.format('ERROR: 404 (missing hash) ON %s CONTENT %s LINKS TO %s', queueItem.referrer, queueItem.meta.content, queueItem.url)));
          stats.errors++;
        }
        // only check the hash here
        // let the non-hash version crawl the rest of the tree
        return [];
      }

      $('a').each(function(index, a) {
        var toQueueUrl = $(a).attr('href');
        var linkContent = $(a).text();
        if (!toQueueUrl) return;

        if (toQueueUrl.indexOf('#') === 0 && toQueueUrl.length > 1) {
          if (urlis.autogeneratedApiLink) {
            return [];
          }

          if ($(toQueueUrl).length === 0) {
            console.error(chalk.red(util.format('ERROR: 404 relative link ON %s CONTENT %s LINKS TO %s', queueItem.url, linkContent, toQueueUrl)));
            stats.errors++;
          }
        }

        if (!shouldCrawl(toQueueUrl)) {
          // shouldCrawl returns true if we should crawl to toQueueUrl
          // If the URL is a hash only (hash on the same page, begins with #) then we do not crawl to the page, since it's not a different page
          return [];
        }  

        if (toQueueUrl.indexOf('https://github.com/particle-iot/docs/tree/') === 0) {
          // Github edit links are not crawled because it's not possible to edit pages until the page has
          // been committed, but you can't commit the page until CI passes.
          return [];
        }

        var absolutePath = url.resolve(queueItem.url, toQueueUrl);
        // Remove hash
        absolutePath = absolutePath.replace(/#.*/, '');

        if (crawlerData.urls[absolutePath]) {
          // Cached, don't fetch again. Only external urls are added to the cache, so we will still retrieve
          // our own pages to crawl them.
          stats.inCache++;
          return [];
        }

        // Note queueURL is not called with the force parameter, so URLs that are already in the queue are not added more than once
        crawler.queueURL(absolutePath, queueItem, { content: linkContent });
      });

      $('img').each(function (index, img) {
        var toQueueUrl = $(img).attr('src');
        if (!toQueueUrl) return [];

        toQueueUrl = url.resolve(queueItem.url, toQueueUrl);

        if (crawlerData.urls[toQueueUrl]) {
          // Cached, no need to check again
          stats.inCache++;
          return [];
        }

        // Note queueURL is not called with the force parameter, so URLs that are already in the queue are not added more than once
        crawler.queueURL(toQueueUrl, queueItem, { content: 'image' });
      });

      return [];
    };

    crawler.on('fetchstart', function(queueItem) {
      // console.log('start', queueItem.url);
      stats.fetchAttempt++;
    });

    // crawler.on('fetchheaders', function(queueItem, response) {
    //   console.log('headers', queueItem.url, complete, len);
    // });

    // crawler.on('fetchcomplete', function(queueItem) {
    //   console.log('complete', queueItem.url);
    // });

    crawler.on('fetchtimeout', function (queueItem) {
      var msg = util.format('timeout ON %s CONTENT %s LINKS TO %s', queueItem.referrer, queueItem.meta.content, queueItem.url);
      var urlis = classifyUrl(queueItem);
      if (urlis.external || urlis.isFirmwareReference) {
        // Warn only for timeouts on external URLs and the firmware reference (because it's very large)ƒ
        console.log(chalk.yellow('WARN: ' + msg));
      } else {
        console.error(chalk.red('ERROR: ' + msg));
        stats.errors++;
      }
    });

    function fetchResultError(queueItem, response) {
      if (queueItem.stateData.code === 429) {
        return;
      }
      if (queueItem.stateData.code === 200) {
        return;
      }

      var urlis = classifyUrl(queueItem);
      if (urlis.autogeneratedApiLink && queueItem.stateData.code === 404) {
        return;
      }

      if (queueItem.stateData.code == 404) {
        delete crawlerData.urls[queueItem.url];
      }

      // allow 5XX status codes on external links
      var isWarning = (urlis.external && Math.floor(queueItem.stateData.code / 100) === 5);
      
      if (queueItem.stateData.code === 403 && urlis.isGithubReferrerLink) {
    	  // Github is randomly returning 403 errors for some reason when the link redirects to AWS. Treat as warning, not error.
    	  isWarning = true;
      }
      if (queueItem.stateData.code === 403 && queueItem.url.indexOf('dfu-util.sourceforge.net') >= 0) {
    	  // dfu-util.sourceforge.net is randomly returning 403 errors as well. Treat as warning, not error.
    	  isWarning = true;
      }
      if (queueItem.stateData.code === 403 && queueItem.url.indexOf('digikey.com') >= 0) {
    	  // DigiKey is randomly returning 403 errors as well. Treat as warning, not error.
    	  isWarning = true;
      }
      if (queueItem.stateData.code === 403 && queueItem.url.indexOf('adafruit.com') >= 0) {
    	  // DigiKey is randomly returning 403 errors as well. Treat as warning, not error.
    	  isWarning = true;
      }
      if (queueItem.stateData.code === 408 && queueItem.url.indexOf('papertrailapp.com') >= 0) {
    	  isWarning = true;
      }
      
      var msg = util.format('%s ON %s CONTENT %s LINKS TO %s', queueItem.stateData.code, queueItem.referrer, queueItem.meta.content, queueItem.url);
      if (isWarning) {
        console.log(chalk.yellow('WARN: ' + msg));
        return;
      }
      console.error(chalk.red('ERROR: ' + msg));
      stats.errors++;
    }

    crawler.on('fetch404', fetchResultError);
    crawler.on('fetcherror', fetchResultError);
    crawler.on('complete', function() {
      if (stats.errors > 0) {
        delete crawlerData.success; 
        crawlerData.error = Math.floor(Date.now() / 1000);
      }
      else {
        delete crawlerData.error;
        crawlerData.success = Math.floor(Date.now() / 1000);
      }

      crawlerData.stats = stats;
      fs.writeFileSync(crawlerConfigPath, JSON.stringify(crawlerData, null, 2));
  
      console.log(JSON.stringify(stats, null, 2));

      if (stats.errors > 0) {
        return done(new Error('There are ' + stats.errors + ' broken link(s)'));
      }
      return done();
    });
    crawler.start();
  });

});

