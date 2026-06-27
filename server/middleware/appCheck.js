const { admin } = require('../firebaseAdmin');
const { APP_CHECK_ENFORCEMENT } = require('../config/settings');

const appCheckVerification = async (req, res, next) => {
  if (APP_CHECK_ENFORCEMENT === false) {
    return next();
  }

  const appCheckToken = req.header('X-Firebase-AppCheck');

  if (!appCheckToken) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'app_check_missing',
        message: 'Unauthorized request.'
      }
    });
  }

  try {
    await admin.appCheck().verifyToken(appCheckToken);
    return next();
  } catch (error) {
    console.error('Error validating App Check token:', error);
    return res.status(401).json({
      success: false,
      error: {
        code: 'app_check_invalid',
        message: 'Unauthorized request.'
      }
    });
  }
};

module.exports = appCheckVerification;
