const fs = require('fs');
const path = require('path');

let localEnvConfigCache;
let secretConfigCache;
const isCloudRuntime = Boolean(
  process.env.K_SERVICE
  || process.env.FUNCTION_TARGET
  || process.env.FUNCTION_NAME
);

if (!isCloudRuntime) {
  console.log('Using local environment settings');
} else {
  console.log('Using Firebase secret CONFIGS_FUNCTIONS');
}

const parseEnvValue = (value) => {
  const trimmed = String(value || '').trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

const parseEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((config, line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        return config;
      }

      const separatorIndex = trimmed.indexOf('=');

      if (separatorIndex < 0) {
        return config;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1);

      if (key) {
        config[key] = parseEnvValue(value);
      }

      return config;
    }, {});
};

const getLocalEnvConfig = () => {
  if (localEnvConfigCache !== undefined) {
    return localEnvConfigCache;
  }

  if (isCloudRuntime) {
    localEnvConfigCache = {};
    return localEnvConfigCache;
  }

  const projectRoot = path.resolve(__dirname, '..', '..');
  localEnvConfigCache = {
    ...parseEnvFile(path.join(projectRoot, '.env')),
    ...parseEnvFile(path.join(projectRoot, '.env.local'))
  };

  return localEnvConfigCache;
};

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
  if (process.env[key] !== undefined) {
    return process.env[key];
  }

  const secretConfig = getSecretConfig();
  if (secretConfig[key] !== undefined) {
    return secretConfig[key];
  }

  const localEnvConfig = getLocalEnvConfig();
  if (localEnvConfig[key] !== undefined) {
    return localEnvConfig[key];
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
