const getForwardedValue = (value) => {
  if (!value) {
    return '';
  }

  return String(value).split(',')[0].trim();
};

const getPublicBaseUrl = (req) => {
  const protocol = getForwardedValue(req.get('x-forwarded-proto')) || req.protocol || 'https';
  const host = getForwardedValue(req.get('x-forwarded-host')) || req.get('host');

  return `${protocol}://${host}`;
};

const getMcpResourceUrl = (req) => `${getPublicBaseUrl(req)}/mcp`;

module.exports = {
  getPublicBaseUrl,
  getMcpResourceUrl
};
