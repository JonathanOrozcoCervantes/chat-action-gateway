const crypto = require('crypto');

const base64UrlEncodeJson = (value) => Buffer
  .from(JSON.stringify(value))
  .toString('base64url');

const sign = (message, secret) => crypto
  .createHmac('sha256', secret)
  .update(message)
  .digest('base64url');

const assertSafeEqual = (actual, expected) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
};

const signJwt = (payload, secret, expiresInSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };
  const body = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds
  };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedBody = base64UrlEncodeJson(body);
  const message = `${encodedHeader}.${encodedBody}`;

  return `${message}.${sign(message, secret)}`;
};

const verifyJwt = (token, secret) => {
  const parts = String(token || '').split('.');

  if (parts.length !== 3) {
    throw new Error('Invalid token format.');
  }

  const [encodedHeader, encodedBody, signature] = parts;
  const message = `${encodedHeader}.${encodedBody}`;
  const expectedSignature = sign(message, secret);

  if (!assertSafeEqual(signature, expectedSignature)) {
    throw new Error('Invalid token signature.');
  }

  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  if (header.alg !== 'HS256') {
    throw new Error('Unsupported token algorithm.');
  }

  const payload = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);

  if (!payload.exp || payload.exp <= now) {
    throw new Error('Expired token.');
  }

  return payload;
};

module.exports = {
  signJwt,
  verifyJwt
};
