// Correctness gate for S7: does a built app actually boot in a browser?
//
// Serves the build directory over HTTP, opens it in headless Chrome, and passes when the root
// component rendered its feature links, the first lazy route rendered its page heading, and the
// page logged no errors and threw no exceptions. Run against both `ng build` and ngp's bundle.
//
// Usage: node harness/boot-check.mjs <dist-dir> [--features <n>]
// Chrome comes from $CHROME_PATH, or the usual install location on macOS and Linux.

import {existsSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
import puppeteer from 'puppeteer-core';

const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {features: {type: 'string'}},
});
// `ng build` writes the app under browser/; ngp-bundle.mjs writes it directly.
let dist = path.resolve(positionals[0]);
if (existsSync(path.join(dist, 'browser', 'index.html'))) dist = path.join(dist, 'browser');

const chrome =
  process.env['CHROME_PATH'] ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
if (!chrome) throw new Error('No Chrome found; set CHROME_PATH');

const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json'};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !existsSync(file) || (await fs.stat(file)).isDirectory()) {
    file = path.join(dist, 'index.html'); // SPA fallback for router paths
  }
  res.writeHead(200, {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream'});
  res.end(await fs.readFile(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const problems = [];
const browser = await puppeteer.launch({executablePath: chrome, headless: true, args: ['--no-sandbox']});
try {
  const page = await browser.newPage();
  page.on('console', (msg) => msg.type() === 'error' && problems.push(`console: ${msg.text()}`));
  page.on('pageerror', (err) => problems.push(`exception: ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`request failed: ${req.url()}`));
  await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle0', timeout: 60000});
  await page.waitForSelector('app-root nav a', {timeout: 30000});
  await page.waitForSelector('app-root h3', {timeout: 30000});
  const links = await page.$$eval('app-root nav a', (as) => as.length);
  const heading = await page.$eval('app-root h3', (h) => h.textContent.trim());
  if (args.features && links !== Number(args.features)) {
    problems.push(`expected ${args.features} feature links, found ${links}`);
  }
  console.log(`booted: ${links} feature links, first heading "${heading}"`);
} catch (e) {
  problems.push(`boot: ${e.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length > 0) {
  console.error(problems.slice(0, 10).join('\n'));
  process.exit(1);
}
