/**
 * Lookup Service
 * Delegates to the high-performance orchestration engine in lib/apiClients.js
 */

const { orchestrateLookup } = require('../../lib/apiClients');

async function performLookup(studentNumber) {
  return orchestrateLookup(studentNumber, process.env);
}

module.exports = {
  performLookup,
};
