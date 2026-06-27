let localSettings = null;
let secretConfigCache;
const isCloudRuntime = Boolean(
  process.env.K_SERVICE
  || process.env.FUNCTION_TARGET
  || process.env.FUNCTION_NAME
);

if (!isCloudRuntime) {
  try {
    localSettings = require('./settingsLocal');
    console.log('Using local settings');
  } catch (e) {
    console.log('Using Firebase secret CONFIGS_FUNCTIONS');
  }
} else {
  console.log('Using Firebase secret CONFIGS_FUNCTIONS');
}

const getSecretConfig = () => {
  if (secretConfigCache !== undefined) {
    return secretConfigCache;
  }

  const secretValue = process.env.CONFIGS_FUNCTIONS;

  if (!secretValue) {
    secretConfigCache = {};
    return secretConfigCache;
  }

  try {
    secretConfigCache = JSON.parse(secretValue).config || {};
    return secretConfigCache;
  } catch (error) {
    console.error('Error parsing CONFIGS_FUNCTIONS:', error);
    secretConfigCache = {};
    return secretConfigCache;
  }
};

const getConfigValue = (key) => {
  const secretConfig = getSecretConfig();
  if (secretConfig[key] !== undefined) {
    return secretConfig[key];
  }

  if (!isCloudRuntime && localSettings && localSettings[key] !== undefined) {
    return localSettings[key];
  }

  return undefined;
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
