const { loghubLog } = require('@geos/loghub-client');

const SERVICE = 'service-flow-backend';
const APP = 'service-flow';
const ENV = process.env.NODE_ENV || 'prod';

function log(message, attrs) {
  console.log(message);
  loghubLog({ service: SERVICE, app: APP, env: ENV, level: 'info', message: String(message), ...(attrs && { attrs }) });
}

function warn(message, attrs) {
  console.warn(message);
  loghubLog({ service: SERVICE, app: APP, env: ENV, level: 'warn', message: String(message), ...(attrs && { attrs }) });
}

function error(message, attrs) {
  console.error(message);
  loghubLog({ service: SERVICE, app: APP, env: ENV, level: 'error', message: String(message), ...(attrs && { attrs }) });
}

function debug(message, attrs) {
  console.log(message);
  loghubLog({ service: SERVICE, app: APP, env: ENV, level: 'debug', message: String(message), ...(attrs && { attrs }) });
}

module.exports = { log, warn, error, debug };
