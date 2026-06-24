const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const app = require('./app');
const { FUNCTION_REGION } = require('./config/settings');

const configsSecret = defineSecret('CONFIGS_FUNCTIONS');

// Keep the config secret mounted in Cloud Functions runtime.
exports.apiV2 = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    secrets: [configsSecret]
  },
  app
);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Node server running on port ${port}`);
  });
}
