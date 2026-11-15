'use strict';
const fs = require('fs');
const os = require('os');

/*
 * How much memory the system can still give out. On a PC with 11 GB shared by the local model,
 * the test browser and the app, running out kills Ollama's model runner mid-task.
 */

const LOW_MB = 900;

/** Available memory in MB: MemAvailable on Linux (counts reclaimable cache), free memory elsewhere. */
function availableMB() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch { /* not Linux */ }
  return Math.round(os.freemem() / 1048576);
}

const isLow = () => availableMB() < LOW_MB;

/** Waits until memory is no longer low, up to maxMs. Returns true if it recovered. */
async function waitForMemory(maxMs = 60000, signal) {
  const end = Date.now() + maxMs;
  while (isLow() && Date.now() < end) {
    if (signal && signal.aborted) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return !isLow();
}

module.exports = { availableMB, isLow, waitForMemory, LOW_MB };
