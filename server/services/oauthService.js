const { admin } = require('../firebaseAdmin');
const oauthRepository = require('../repositories/oauthRepository');
const userRepository = require('../repositories/userRepository');
const { OAUTH_ACCESS_TOKEN_SECRET } = require('../config/settings');
const AppError = require('../utils/AppError');
const { createPkceChallenge, hashValue, randomToken } = require('../utils/security');
const { signJwt, verifyJwt } = require('../utils/jwt');

const DEFAULT_SCOPE = 'expenses:write';
const STATIC_CLIENT_ID = 'chat-action-gateway-chatgpt';
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

const getAccessTokenSecret = () => {
  if (!OAUTH_ACCESS_TOKEN_SECRET) {
    throw createOAuthError({
      statusCode: 500,
      code: 'missing_oauth_secret',
      message: 'OAUTH_ACCESS_TOKEN_SECRET is required to issue or verify OAuth access tokens.'
    });
  }

  return OAUTH_ACCESS_TOKEN_SECRET;
};

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

const getGoogleProviderUid = (decodedToken) => {
  const googleIdentities = decodedToken.firebase?.identities?.['google.com'];
  return Array.isArray(googleIdentities) ? googleIdentities[0] : undefined;
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

    const scope = normalizeScope(payload.scope || DEFAULT_SCOPE);

    return {
      client_id: `chatgpt_${randomToken(18)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope,
      token_endpoint_auth_method: 'none'
    };
  }

  async createAuthorizationCode({ payload, firebaseIdToken, expectedResource }) {
    const responseType = trimText(payload.response_type);
    const clientId = trimText(payload.client_id || STATIC_CLIENT_ID);
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

    if (!firebaseIdToken) {
      throw createOAuthError({
        statusCode: 401,
        code: 'missing_google_auth',
        message: 'Google authentication is required.'
      });
    }

    let decodedToken;

    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseIdToken);
    } catch (error) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_google_auth',
        message: 'Invalid or expired Google authentication.'
      });
    }

    await userRepository.upsertGoogleUser({
      uid: decodedToken.uid,
      email: decodedToken.email,
      displayName: decodedToken.name,
      photoURL: decodedToken.picture,
      emailVerified: decodedToken.email_verified,
      provider: decodedToken.firebase?.sign_in_provider || 'google.com',
      providerUid: getGoogleProviderUid(decodedToken)
    });

    const code = randomToken(32);

    await oauthRepository.createAuthorizationCode({
      codeHash: hashValue(code),
      userId: decodedToken.uid,
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

    throw createOAuthError({
      code: 'unsupported_grant_type',
      message: 'Only authorization_code grant type is supported.'
    });
  }

  async exchangeAuthorizationCode(payload) {
    const code = trimText(payload.code);
    const clientId = trimText(payload.client_id || STATIC_CLIENT_ID);
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
      clientId: authCode.clientId,
      scope: authCode.scope,
      resource: authCode.resource
    });
  }

  issueTokens({
    userId,
    clientId,
    scope,
    resource
  }) {
    const normalizedScope = normalizeScope(scope);
    const accessToken = signJwt({
      sub: userId,
      client_id: clientId,
      scope: normalizedScope,
      aud: resource,
      resource
    }, getAccessTokenSecret(), ACCESS_TOKEN_TTL_SECONDS);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: normalizedScope
    };
  }

  verifyAccessToken(rawAccessToken, { requiredScope, resource }) {
    const accessToken = trimText(rawAccessToken);

    if (!accessToken) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_token',
        message: 'Missing access token.'
      });
    }

    let tokenPayload;

    try {
      tokenPayload = verifyJwt(accessToken, getAccessTokenSecret());
    } catch (error) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_token',
        message: 'Invalid or expired access token.'
      });
    }

    if (resource && tokenPayload.resource !== resource && tokenPayload.aud !== resource) {
      throw createOAuthError({
        statusCode: 401,
        code: 'invalid_token',
        message: 'Access token was issued for a different MCP resource.'
      });
    }

    if (!hasScope(tokenPayload.scope, requiredScope)) {
      throw createOAuthError({
        statusCode: 403,
        code: 'insufficient_scope',
        message: 'Access token does not include the required scope.'
      });
    }

    return {
      userId: tokenPayload.sub,
      clientId: tokenPayload.client_id,
      scope: normalizeScope(tokenPayload.scope),
      resource: tokenPayload.resource || tokenPayload.aud
    };
  }
}

module.exports = new OAuthService();
