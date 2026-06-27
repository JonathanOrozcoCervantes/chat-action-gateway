const path = require('path');
const dotenv = require('dotenv');

const isCloudRuntime = Boolean(
  process.env.K_SERVICE
  || process.env.FUNCTION_TARGET
  || process.env.FUNCTION_NAME
);

if (!isCloudRuntime) {
  const projectRoot = path.resolve(__dirname, '..', '..');

  dotenv.config({ path: path.join(projectRoot, '.env.local'), quiet: true });
}

const getSecretConfig = () => {
  if (!isCloudRuntime || !process.env.CONFIGS_FUNCTIONS) {
    return {};
  }

  try {
    return JSON.parse(process.env.CONFIGS_FUNCTIONS).config || {};
  } catch (error) {
    console.error('Error parsing CONFIGS_FUNCTIONS:', error);
    return {};
  }
};

const secretConfig = getSecretConfig();

const getConfigValue = (key) => {
  if (process.env[key] !== undefined) {
    return process.env[key];
  }

  return secretConfig[key];
};

const getBooleanConfigValue = (key, fallback) => {
  const value = getConfigValue(key);

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  return fallback;
};

const FIREBASE_PROJECT_ID = getConfigValue('FIREBASE_PROJECT_ID');
const FUNCTION_REGION = getConfigValue('FUNCTION_REGION');
const APP_CHECK_ENFORCEMENT = getBooleanConfigValue('APP_CHECK_ENFORCEMENT', isCloudRuntime ? true : undefined);
const OAUTH_ACCESS_TOKEN_SECRET = getConfigValue('OAUTH_ACCESS_TOKEN_SECRET');

module.exports = {
  FIREBASE_PROJECT_ID,
  FUNCTION_REGION,
  APP_CHECK_ENFORCEMENT,
  OAUTH_ACCESS_TOKEN_SECRET
};
