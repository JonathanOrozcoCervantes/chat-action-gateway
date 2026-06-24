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

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

module.exports = {
  getPublicBaseUrl,
  getMcpResourceUrl,
  escapeHtml
};
