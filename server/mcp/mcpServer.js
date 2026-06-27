const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

const createMcpServer = ({ authContext, profile }) => {
  const server = new McpServer({
    name: profile.name,
    version: profile.version
  });

  profile.registerTools(server, { authContext });

  return server;
};

module.exports = {
  createMcpServer
};
