const fs = require('fs');
const path = require('path');
const logPath = path.join(__dirname, '../logs/error.log');

function logError(message) {
  const timestamp = new Date().toISOString();
  fs.appendFile(logPath, `[${timestamp}] ${message}\n`, err => {
    if (err) console.error('Failed to write to log file:', err);
  });
}

module.exports = { logError };
// Test log entry to verify logger works
logError('Logger test: If you see this, logging is working.');