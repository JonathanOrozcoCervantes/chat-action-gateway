const FINANCE_SCOPES = [
  'workspaces:read',
  'workspaces:write',
  'members:read',
  'members:write',
  'categories:read',
  'categories:write',
  'accounts:read',
  'accounts:write',
  'payment_methods:read',
  'payment_methods:write',
  'credits:read',
  'credits:write',
  'movements:read',
  'expenses:write',
  'income:write',
  'transfers:write'
];

const READ_SCOPES = [
  'workspaces:read',
  'members:read',
  'categories:read',
  'accounts:read',
  'payment_methods:read',
  'credits:read',
  'movements:read'
];

const WRITE_SCOPES = [
  'accounts:write',
  'categories:write',
  'payment_methods:write',
  'credits:write',
  'expenses:write',
  'income:write',
  'transfers:write'
];

const DEFAULT_OAUTH_SCOPE = FINANCE_SCOPES.join(' ');

module.exports = {
  DEFAULT_OAUTH_SCOPE,
  FINANCE_SCOPES,
  READ_SCOPES,
  WRITE_SCOPES
};
