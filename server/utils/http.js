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

const getMcpProfileIdFromPath = (path) => {
  try {
    const url = new URL(String(path || ''), 'https://placeholder.local');
    const match = url.pathname.match(/^\/mcp\/([^/]+)(?:\/|$)/);

    return match ? match[1] : '';
  } catch (error) {
    return '';
  }
};

const getMcpProfileIdFromRequest = (req) => getMcpProfileIdFromPath(req.originalUrl || req.path);

const getMcpResourceUrlForProfile = (req, profileId) => `${getPublicBaseUrl(req)}/mcp/${profileId}`;

const getMcpResourceUrl = (req) => {
  const profileId = getMcpProfileIdFromRequest(req);

  return profileId ? getMcpResourceUrlForProfile(req, profileId) : '';
};

const getMcpProfileIdFromResource = (req, resource) => {
  if (!resource) {
    return '';
  }

  try {
    const resourceUrl = new URL(resource);
    const baseUrl = new URL(getPublicBaseUrl(req));

    if (resourceUrl.origin !== baseUrl.origin) {
      return '';
    }

    return getMcpProfileIdFromPath(resourceUrl.pathname);
  } catch (error) {
    return '';
  }
};

module.exports = {
  getPublicBaseUrl,
  getMcpProfileIdFromPath,
  getMcpProfileIdFromRequest,
  getMcpProfileIdFromResource,
  getMcpResourceUrl,
  getMcpResourceUrlForProfile
};
