const gmail = require('./gmail.provider')
const outlook = require('./outlook.provider')

const REGISTRY = { gmail, outlook }

function getProvider(name) {
  const p = REGISTRY[name]
  if (!p) throw new Error(`Unknown connected email provider: ${name}`)
  return p
}

module.exports = { getProvider, REGISTRY }
