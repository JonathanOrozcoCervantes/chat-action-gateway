const oauthService = require('../services/oauthService');
const { getMcpResourceUrl, getPublicBaseUrl } = require('../utils/http');
const { DEFAULT_OAUTH_SCOPE, FINANCE_SCOPES } = require('../mcp/scopes');

const AUTHORIZE_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'resource'
];

const pickAuthorizeParams = (source) => AUTHORIZE_FIELDS.reduce((params, field) => {
  if (source[field] !== undefined) {
    params[field] = source[field];
  }

  return params;
}, {});

const getOAuthLoginUrl = (req, params, errorMessage = '') => {
  const loginUrl = new URL('/oauth-login', getPublicBaseUrl(req));

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      loginUrl.searchParams.set(key, value);
    }
  });

  if (errorMessage) {
    loginUrl.searchParams.set('error', errorMessage);
  }

  return loginUrl.toString();
};

const sendOAuthError = (res, error) => {
  const isAppError = error.name === 'AppError';
  const statusCode = isAppError ? error.statusCode : 500;

  return res.status(statusCode).json({
    error: isAppError ? error.code : 'server_error',
    error_description: isAppError ? error.message : 'OAuth server error.'
  });
};

const getProtectedResourceMetadata = (req, res) => {
  const baseUrl = getPublicBaseUrl(req);

  res.status(200).json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: FINANCE_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: `${baseUrl}/`
  });
};

const getAuthorizationServerMetadata = (req, res) => {
  const baseUrl = getPublicBaseUrl(req);

  res.status(200).json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: FINANCE_SCOPES,
    resource_parameter_supported: true
  });
};

const getAuthorizePage = (req, res) => {
  const params = {
    scope: DEFAULT_OAUTH_SCOPE,
    resource: getMcpResourceUrl(req),
    ...pickAuthorizeParams(req.query)
  };

  res.redirect(302, getOAuthLoginUrl(req, params));
};

const authorize = async (req, res) => {
  const params = pickAuthorizeParams(req.body);

  try {
    const result = await oauthService.createAuthorizationCode({
      payload: {
        scope: DEFAULT_OAUTH_SCOPE,
        resource: getMcpResourceUrl(req),
        ...params
      },
      firebaseIdToken: req.body.firebaseIdToken,
      expectedResource: getMcpResourceUrl(req)
    });

    const redirectUrl = new URL(result.redirectUri);
    redirectUrl.searchParams.set('code', result.code);

    if (result.state) {
      redirectUrl.searchParams.set('state', result.state);
    }

    return res.redirect(302, redirectUrl.toString());
  } catch (error) {
    const isAppError = error.name === 'AppError';
    const errorMessage = isAppError ? error.message : 'No se pudo conectar con Google.';

    return res.redirect(303, getOAuthLoginUrl(req, params, errorMessage));
  }
};

const parseBasicAuthClient = (req) => {
  const authorization = req.get('authorization') || '';

  if (!authorization.toLowerCase().startsWith('basic ')) {
    return {};
  }

  try {
    const decoded = Buffer
      .from(authorization.slice(6), 'base64')
      .toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex < 0) {
      return {};
    }

    return {
      client_id: decoded.slice(0, separatorIndex),
      client_secret: decoded.slice(separatorIndex + 1)
    };
  } catch (error) {
    return {};
  }
};

const token = async (req, res) => {
  try {
    const basicClient = parseBasicAuthClient(req);
    const result = await oauthService.exchangeToken({
      ...basicClient,
      ...req.body
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendOAuthError(res, error);
  }
};

const registerClient = async (req, res) => {
  try {
    const result = await oauthService.registerClient(req.body || {});
    return res.status(201).json(result);
  } catch (error) {
    return sendOAuthError(res, error);
  }
};

module.exports = {
  authorize,
  getAuthorizationServerMetadata,
  getAuthorizePage,
  getProtectedResourceMetadata,
  registerClient,
  token
};
