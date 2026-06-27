const financeProfile = require('./finance');

const DEFAULT_MCP_PROFILE_ID = 'finance';
const profiles = new Map([
  [financeProfile.id, financeProfile]
]);

const getMcpProfile = (profileId) => profiles.get(profileId) || null;

const getDefaultMcpProfile = () => getMcpProfile(DEFAULT_MCP_PROFILE_ID);

const getSupportedMcpScopes = () => Array.from(new Set(
  Array.from(profiles.values()).flatMap((profile) => profile.scopes)
));

module.exports = {
  DEFAULT_MCP_PROFILE_ID,
  getDefaultMcpProfile,
  getMcpProfile,
  getSupportedMcpScopes
};
