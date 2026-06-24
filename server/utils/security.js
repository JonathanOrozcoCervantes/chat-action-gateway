const crypto = require('crypto');

const hashValue = (value) => crypto
  .createHash('sha256')
  .update(String(value))
  .digest('hex');

const randomToken = (bytes = 32) => crypto
  .randomBytes(bytes)
  .toString('base64url');

const createPkceChallenge = (verifier) => crypto
  .createHash('sha256')
  .update(String(verifier))
  .digest('base64url');

module.exports = {
  hashValue,
  randomToken,
  createPkceChallenge
};
