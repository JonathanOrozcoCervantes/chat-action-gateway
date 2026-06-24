const actionRepository = require('../repositories/actionRepository');
const oauthRepository = require('../repositories/oauthRepository');
const AppError = require('../utils/AppError');
const {
  createPkceChallenge,
  hashValue,
  randomToken,
  safeHashPrefix
} = require('../utils/security');

const DEFAULT_SCOPE = 'expenses:write';
const AUTH_CODE_TTL_SECONDS = 10 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const trimText = (value) => String(value || '').trim();

const addSeconds = (seconds) => new Date(Date.now() + seconds * 1000);

const getDateValue = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value.toDate === 'function') {
    return value.toDate();
  }

  return new Date(value);
};

const isExpired = (value) => {
  const date = getDateValue(value);
  return !date || date.getTime() <= Date.now();
};

const normalizeScope = (scope) => {
  const scopes = trimText(scope || DEFAULT_SCOPE)
    .split(/[\s,]+/)
    .filter(Boolean);

  return Array.from(new Set(scopes.length ? scopes : [DEFAULT_SCOPE])).join(' ');
};

const hasScope = (grantedScope, requiredScope) => {
  if (!requiredScope) {
    return true;
  }

  return normalizeScope(grantedScope).split(' ').includes(requiredScope);
};

const createOAuthError = ({ statusCode = 400, code = 'invalid_request', message }) => new AppError({
  statusCode,
  code,
  message
});

const isAllowedRedirectUri = (redirectUri) => {
  try {
    const url = new URL(redirectUri);

    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') {
      return false;
    }

    return url.pathname.startsWith('/connector/oauth/')
      || url.pathname === '/connector_platform_oauth_redirect';
  } catch (error) {
    return false;
  }
};

const validatePkce = (authCode, codeVerifier) => {
  if (!authCode.codeChallenge) {
    return;
  }

  if (!codeVerifier) {
    throw createOAuthError({
      code: 'invalid_grant',
      message: 'Missing PKCE code_verifier.'
    });
  }

  const verifierChallenge = createPkceChallenge(codeVerifier);

  if (verifierChallenge !== authCode.codeChallenge) {
    throw createOAuthError({
      code: 'invalid_grant',
      message: 'Invalid PKCE code_verifier.'
    });
  }
};

class OAuthService {
  async registerClient(payload) {
    const redirectUris = Array.isArray(payload.redirect_uris)
      ? payload.redirect_uris
      : [];

    if (!redirectUris.length || redirectUris.some((redirectUri) => !isAllowedRedirectUri(redirectUri))) {
      throw createOAuthError({
        code: 'invalid_redirect_uri',
        message: 'At least one ChatGPT redirect URI is required.'
      });
    }

    const clientId = `chatgpt_${randomToken(24)}`;
    const scope = normalizeScope(payload.scope || DEFAULT_SCOPE);

    await oauthRepository.createClient({
      clientId,
      clientName: trimText(payload.client_name || 'ChatGPT Connector'),
      redirectUris,
      scope
    });

    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope,
      token_endpoint_auth_method: 'none'
    };
  }

  async createAuthorizationCode({ payload, personalToken, expectedResource }) {
    const responseType = trimText(payload.response_type);
    const clientId = trimText(payload.client_id);
    const redirectUri = trimText(payload.redirect_uri);
    const codeChallenge = trimText(payload.code_challenge);
    const codeChallengeMethod = trimText(payload.code_challenge_method || 'S256');
    const scope = normalizeScope(payload.scope || DEFAULT_SCOPE);
    const resource = trimText(payload.resource || expectedResource);

    if (responseType !== 'code') {
      throw createOAuthError({
        code: 'unsupported_response_type',
        message: 'Only authorization code flow is supported.'
      });
    }

    if (!clientId) {
      throw createOAuthError({
        code: 'invalid_client',
        message: 'Missing client_id.'
      });
    }

    if (!isAllowedRedirectUri(redirectUri)) {
      throw createOAuthError({
        code: 'invalid_redirect_uri',
        message: 'Invalid ChatGPT redirect URI.'
      });
    }

    if (!resource || resource !== expectedResource) {
      throw createOAuthError({
        code: 'invalid_target',
        message: 'Invalid MCP resource.'
      });
    }

    if (codeChallengeMethod !== 'S256') {
      throw createOAuthError({
        code: 'invalid_request',
        message: 'Only S256 PKCE is supported.'
      });
    }

    const registeredClient = await oauthRepository.getClient(clientId);

    if (registeredClient && !registeredClient.redirectUris.includes(redirectUri)) {
      throw createOAuthError({
        code: 'invalid_redirect_uri',
        message: 'Redirect URI is not registered for this client.'
      });
    }

    const actionTokenHash = hashValue(personalToken);
    const actionToken = await actionRepository.getActiveToken(actionTokenHash);

    if (!actionToken) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_token',
        message: 'Invalid or inactive personal token.'
      });
    }

    const code = randomToken(32);

    await oauthRepository.createAuthorizationCode({
      codeHash: hashValue(code),
      userId: actionToken.userId,
      actionTokenHash,
      clientId,
      redirectUri,
      scope,
      resource,
      codeChallenge,
      codeChallengeMethod,
      expiresAt: addSeconds(AUTH_CODE_TTL_SECONDS)
    });

    return {
      code,
      redirectUri,
      state: trimText(payload.state)
    };
  }

  async exchangeToken(payload) {
    const grantType = trimText(payload.grant_type);

    if (grantType === 'authorization_code') {
      return this.exchangeAuthorizationCode(payload);
    }

    if (grantType === 'refresh_token') {
      return this.exchangeRefreshToken(payload);
    }

    throw createOAuthError({
      code: 'unsupported_grant_type',
      message: 'Unsupported OAuth grant type.'
    });
  }

  async exchangeAuthorizationCode(payload) {
    const code = trimText(payload.code);
    const clientId = trimText(payload.client_id);
    const redirectUri = trimText(payload.redirect_uri);
    const resource = trimText(payload.resource);
    const codeVerifier = trimText(payload.code_verifier);

    if (!code || !clientId) {
      throw createOAuthError({
        code: 'invalid_request',
        message: 'Missing authorization code or client_id.'
      });
    }

    const authCode = await oauthRepository.getAuthorizationCode(hashValue(code));

    if (!authCode || authCode.used || isExpired(authCode.expiresAt)) {
      throw createOAuthError({
        code: 'invalid_grant',
        message: 'Invalid or expired authorization code.'
      });
    }

    if (authCode.clientId !== clientId) {
      throw createOAuthError({
        code: 'invalid_client',
        message: 'Authorization code was not issued to this client.'
      });
    }

    if (redirectUri && authCode.redirectUri !== redirectUri) {
      throw createOAuthError({
        code: 'invalid_grant',
        message: 'Redirect URI does not match the authorization request.'
      });
    }

    if (resource && authCode.resource !== resource) {
      throw createOAuthError({
        code: 'invalid_target',
        message: 'Resource does not match the authorization request.'
      });
    }

    validatePkce(authCode, codeVerifier);
    await oauthRepository.markAuthorizationCodeUsed(authCode.id);

    return this.issueTokens({
      userId: authCode.userId,
      actionTokenHash: authCode.actionTokenHash,
      clientId: authCode.clientId,
      scope: authCode.scope,
      resource: authCode.resource,
      includeRefreshToken: true
    });
  }

  async exchangeRefreshToken(payload) {
    const refreshToken = trimText(payload.refresh_token);
    const clientId = trimText(payload.client_id);
    const resource = trimText(payload.resource);

    if (!refreshToken) {
      throw createOAuthError({
        code: 'invalid_request',
        message: 'Missing refresh_token.'
      });
    }

    const storedToken = await oauthRepository.getRefreshToken(hashValue(refreshToken));

    if (!storedToken || !storedToken.active) {
      throw createOAuthError({
        code: 'invalid_grant',
        message: 'Invalid refresh token.'
      });
    }

    if (clientId && storedToken.clientId !== clientId) {
      throw createOAuthError({
        code: 'invalid_client',
        message: 'Refresh token was not issued to this client.'
      });
    }

    if (resource && storedToken.resource !== resource) {
      throw createOAuthError({
        code: 'invalid_target',
        message: 'Resource does not match the refresh token.'
      });
    }

    return this.issueTokens({
      userId: storedToken.userId,
      actionTokenHash: storedToken.actionTokenHash,
      clientId: storedToken.clientId,
      scope: storedToken.scope,
      resource: storedToken.resource,
      includeRefreshToken: false
    });
  }

  async issueTokens({
    userId,
    actionTokenHash,
    clientId,
    scope,
    resource,
    includeRefreshToken
  }) {
    const accessToken = randomToken(40);
    const expiresAt = addSeconds(ACCESS_TOKEN_TTL_SECONDS);

    await oauthRepository.createAccessToken({
      accessTokenHash: hashValue(accessToken),
      userId,
      actionTokenHash,
      clientId,
      scope,
      resource,
      expiresAt
    });

    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: normalizeScope(scope)
    };

    if (includeRefreshToken) {
      const refreshToken = randomToken(40);

      await oauthRepository.createRefreshToken({
        refreshTokenHash: hashValue(refreshToken),
        userId,
        actionTokenHash,
        clientId,
        scope,
        resource
      });

      tokenResponse.refresh_token = refreshToken;
    }

    return tokenResponse;
  }

  async verifyAccessToken(rawAccessToken, { requiredScope, resource }) {
    const accessToken = trimText(rawAccessToken);

    if (!accessToken) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_token',
        message: 'Missing access token.'
      });
    }

    const storedToken = await oauthRepository.getAccessToken(hashValue(accessToken));

    if (!storedToken || !storedToken.active || isExpired(storedToken.expiresAt)) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_token',
        message: 'Invalid or expired access token.'
      });
    }

    if (resource && storedToken.resource !== resource) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_token',
        message: 'Access token was issued for a different MCP resource.'
      });
    }

    if (!hasScope(storedToken.scope, requiredScope)) {
      throw createOAuthError({
        statusCode: 403,
        code: 'insufficient_scope',
        message: 'Access token does not include the required scope.'
      });
    }

    return {
      userId: storedToken.userId,
      actionTokenHash: storedToken.actionTokenHash,
      actionTokenHashPrefix: safeHashPrefix(storedToken.actionTokenHash),
      clientId: storedToken.clientId,
      scope: normalizeScope(storedToken.scope),
      resource: storedToken.resource
    };
  }
}

module.exports = new OAuthService();
