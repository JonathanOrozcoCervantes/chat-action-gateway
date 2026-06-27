const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpServer } = require('./mcpServer');
const { getMcpProfile } = require('./profiles');
const oauthService = require('../services/oauthService');
const {
  getMcpProfileIdFromRequest,
  getMcpResourceUrlForProfile
} = require('../utils/http');
const { logError, logInfo, logWarning } = require('../utils/logger');

const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);

const setMcpCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
};

const getBearerToken = (req) => {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : '';
};

const summarizeMcpBody = (body) => {
  const message = Array.isArray(body) ? body[0] : body;

  if (!message || typeof message !== 'object') {
    return {
      mcpMethod: '',
      toolName: '',
      messageId: ''
    };
  }

  return {
    mcpMethod: message.method || '',
    toolName: message.params?.name || '',
    messageId: message.id === undefined ? '' : String(message.id),
    batchSize: Array.isArray(body) ? body.length : 1
  };
};

const sendAuthChallenge = (req, res, error, profile) => {
  const isAppError = error.name === 'AppError';
  const resourceUrl = getMcpResourceUrlForProfile(req, profile.id);
  const statusCode = isAppError ? error.statusCode : 500;

  if (statusCode === 401 || statusCode === 403) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource", scope="${profile.defaultScope}"`
    );
  }

  return res.status(statusCode).json({
    error: isAppError ? error.code : 'server_error',
    error_description: isAppError ? error.message : 'MCP authentication server error.'
  });
};

const handleMcpRequest = async (req, res) => {
  setMcpCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (!MCP_METHODS.has(req.method)) {
    logWarning('mcp.request.method_not_allowed', {
      httpMethod: req.method,
      path: req.originalUrl
    });

    return res.status(405).json({
      error: 'method_not_allowed'
    });
  }

  const profileId = getMcpProfileIdFromRequest(req);
  const profile = getMcpProfile(profileId);

  if (!profile) {
    logWarning('mcp.request.profile_not_found', {
      httpMethod: req.method,
      path: req.originalUrl,
      profileId
    });

    return res.status(404).json({
      error: 'mcp_profile_not_found',
      error_description: 'Unknown MCP profile. Use /mcp/finance for finance tools.'
    });
  }

  const resourceUrl = getMcpResourceUrlForProfile(req, profile.id);
  let authContext;

  try {
    authContext = await oauthService.verifyAccessToken(getBearerToken(req), {
      resource: resourceUrl
    });
  } catch (error) {
    logWarning('mcp.request.auth_failed', {
      httpMethod: req.method,
      path: req.originalUrl,
      userAgent: req.get('user-agent') || '',
      errorCode: error.code || 'auth_failed',
      errorMessage: error.message || 'Authentication failed.'
    });

    return sendAuthChallenge(req, res, error, profile);
  }

  logInfo('mcp.request.authenticated', {
    httpMethod: req.method,
    path: req.originalUrl,
    userAgent: req.get('user-agent') || '',
    userId: authContext.userId,
    clientId: authContext.clientId,
    resource: authContext.resource,
    profileId: profile.id,
    ...summarizeMcpBody(req.body)
  });

  const server = createMcpServer({ authContext, profile });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logError('mcp.request.error', error, {
      httpMethod: req.method,
      path: req.originalUrl,
      userId: authContext.userId,
      clientId: authContext.clientId,
      profileId: profile.id,
      ...summarizeMcpBody(req.body)
    });

    if (!res.headersSent) {
      res.status(500).json({
        error: 'internal_error',
        error_description: 'Internal MCP server error.'
      });
    }
  }
};

module.exports = {
  handleMcpRequest
};
