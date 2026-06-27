const { DEFAULT_OAUTH_SCOPE, FINANCE_SCOPES } = require('./scopes');
const { registerFinanceTools } = require('../../tools/financeTools');

const financeProfile = {
  id: 'finance',
  name: 'chat-action-gateway-finance',
  version: '0.1.0',
  defaultScope: DEFAULT_OAUTH_SCOPE,
  scopes: FINANCE_SCOPES,
  registerTools: registerFinanceTools
};

module.exports = financeProfile;
