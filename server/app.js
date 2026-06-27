const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const apiRoutes = require('./routes/apiRoutes');
const oauthRoutes = require('./oauth/oauthRoutes');
const oauthController = require('./oauth/oauthController');
const { handleMcpRequest } = require('./mcp/mcpHandler');
const { FIREBASE_PROJECT_ID } = require('./config/settings');

const app = express();

const apiCorsOrigins = FIREBASE_PROJECT_ID ? new Set([
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`
]) : new Set();

const apiCors = cors({
  origin: (origin, callback) => {
    if (!origin || apiCorsOrigins.has(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'],
  maxAge: 3600
});

app.set('trust proxy', true);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/.well-known/oauth-protected-resource', oauthController.getProtectedResourceMetadata);
app.get('/.well-known/oauth-authorization-server', oauthController.getAuthorizationServerMetadata);
app.get('/.well-known/openid-configuration', oauthController.getAuthorizationServerMetadata);
app.get('/mcp/.well-known/oauth-protected-resource', oauthController.getProtectedResourceMetadata);
app.use('/oauth', oauthRoutes);
app.all('/mcp', handleMcpRequest);
app.all('/mcp/*', handleMcpRequest);

app.use('/api', apiCors, apiRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'not_found',
      message: 'Route not found.'
    }
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({
    success: false,
    error: {
      code: 'internal_error',
      message: 'Unexpected server error.'
    }
  });
});

module.exports = app;
