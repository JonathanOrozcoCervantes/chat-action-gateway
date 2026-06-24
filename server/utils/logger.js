const serializeError = (error) => ({
  name: error?.name || 'Error',
  code: error?.code || 'unknown_error',
  statusCode: error?.statusCode || 500,
  message: error?.message || 'Unknown error'
});

const writeLog = (level, event, data = {}) => {
  const entry = {
    severity: level,
    event,
    ...data
  };

  const message = JSON.stringify(entry);

  if (level === 'ERROR') {
    console.error(message);
    return;
  }

  if (level === 'WARNING') {
    console.warn(message);
    return;
  }

  console.info(message);
};

const logInfo = (event, data) => writeLog('INFO', event, data);
const logWarning = (event, data) => writeLog('WARNING', event, data);
const logError = (event, error, data = {}) => writeLog('ERROR', event, {
  ...data,
  error: serializeError(error)
});

module.exports = {
  logError,
  logInfo,
  logWarning,
  serializeError
};
