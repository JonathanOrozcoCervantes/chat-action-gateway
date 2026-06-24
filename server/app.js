const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const apiRoutes = require('./routes/apiRoutes');
const oauthRoutes = require('./oauth/oauthRoutes');
const oauthController = require('./oauth/oauthController');
const { handleMcpRequest } = require('./mcp/mcpHandler');

const app = express();

app.set('trust proxy', true);
app.use(cors({ origin: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/ping', (req, res) => {
  res.status(200).json({ message: "I'm alive..." });
});

app.get('/.well-known/oauth-protected-resource', oauthController.getProtectedResourceMetadata);
app.get('/.well-known/oauth-authorization-server', oauthController.getAuthorizationServerMetadata);
app.get('/.well-known/openid-configuration', oauthController.getAuthorizationServerMetadata);
app.get('/mcp/.well-known/oauth-protected-resource', oauthController.getProtectedResourceMetadata);
app.use('/oauth', oauthRoutes);
app.all('/mcp', handleMcpRequest);
app.all('/mcp/*', handleMcpRequest);

app.use('/api', apiRoutes);

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
