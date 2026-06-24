const oauthService = require('../services/oauthService');
const { escapeHtml, getMcpResourceUrl, getPublicBaseUrl } = require('../utils/http');

const DEFAULT_SCOPE = 'expenses:write';

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

const renderHiddenInputs = (params) => Object.entries(params)
  .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
  .join('\n');

const renderAuthorizePage = ({ params, errorMessage = '', baseUrl }) => {
  const hiddenInputs = renderHiddenInputs(params);
  const errorBlock = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : '';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Conectar Chat Action Gateway</title>
    <style>
      :root { color-scheme: light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #181a1f; }
      main { width: min(440px, calc(100vw - 32px)); background: #fff; border: 1px solid #d8dce3; border-radius: 8px; padding: 28px; box-shadow: 0 16px 40px rgba(18, 24, 40, 0.08); }
      h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
      p { margin: 0 0 22px; color: #596070; line-height: 1.5; }
      label { display: block; margin-bottom: 8px; font-weight: 650; }
      input[type="password"] { box-sizing: border-box; width: 100%; height: 46px; padding: 0 12px; border: 1px solid #c9ced8; border-radius: 6px; font: inherit; }
      button { width: 100%; height: 46px; margin-top: 18px; border: 0; border-radius: 6px; background: #111827; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
      .error { margin: 0 0 16px; padding: 12px; border-radius: 6px; background: #fff0ed; color: #b42318; border: 1px solid #ffd0c7; }
      .meta { margin-top: 18px; font-size: 12px; color: #7a8291; }
    </style>
  </head>
  <body>
    <main>
      <h1>Conectar ChatGPT</h1>
      <p>Ingresa tu token personal para vincular este conector con tu cuenta de gastos.</p>
      ${errorBlock}
      <form method="post" action="${escapeHtml(baseUrl)}/oauth/authorize">
        ${hiddenInputs}
        <label for="personalToken">Token personal</label>
        <input id="personalToken" name="personalToken" type="password" autocomplete="off" required autofocus />
        <button type="submit">Conectar</button>
      </form>
      <p class="meta">El token no se guarda en texto plano. Se verifica con SHA-256 contra Firestore.</p>
    </main>
  </body>
</html>`;
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
    scopes_supported: [DEFAULT_SCOPE],
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
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [DEFAULT_SCOPE],
    resource_parameter_supported: true
  });
};

const getAuthorizePage = (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const params = {
    scope: DEFAULT_SCOPE,
    resource: getMcpResourceUrl(req),
    ...pickAuthorizeParams(req.query)
  };

  res.status(200).send(renderAuthorizePage({
    params,
    baseUrl
  }));
};

const authorize = async (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const params = pickAuthorizeParams(req.body);

  try {
    const result = await oauthService.createAuthorizationCode({
      payload: {
        scope: DEFAULT_SCOPE,
        resource: getMcpResourceUrl(req),
        ...params
      },
      personalToken: req.body.personalToken,
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
    const statusCode = isAppError ? error.statusCode : 500;

    return res.status(statusCode).send(renderAuthorizePage({
      params,
      errorMessage: isAppError ? error.message : 'No se pudo conectar el token.',
      baseUrl
    }));
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
