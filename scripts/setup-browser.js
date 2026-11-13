'use strict';
// Downloads Playwright's Chromium (about 150 MB) so the agent's browser tool works without Chrome/Edge installed.
const { installChromium } = require('../src/tools/browser');
console.log('Installing Chromium for Freehand...');
installChromium();
console.log('Done. If the browser tool still fails, install Google Chrome or Microsoft Edge.');
