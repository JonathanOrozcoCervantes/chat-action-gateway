const admin = require('firebase-admin');
const { FIREBASE_PROJECT_ID } = require('./config/settings');

if (!admin.apps.length) {
  admin.initializeApp(FIREBASE_PROJECT_ID ? {
    projectId: FIREBASE_PROJECT_ID
  } : undefined);
}

const db = admin.firestore();

module.exports = { admin, db };
