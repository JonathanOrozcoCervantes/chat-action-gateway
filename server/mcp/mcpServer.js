const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { registerFinanceTools } = require('./financeTools');

const createMcpServer = ({ authContext }) => {
  const server = new McpServer({
    name: 'chat-action-gateway',
    version: '0.2.0'
  });

  registerFinanceTools(server, { authContext });

  return server;
};

module.exports = {
  createMcpServer
};
