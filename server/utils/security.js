const crypto = require('crypto');

const hashValue = (value) => crypto
  .createHash('sha256')
  .update(String(value))
  .digest('hex');

const safeHashPrefix = (hash) => hash.slice(0, 12);

module.exports = {
  hashValue,
  safeHashPrefix
};
