const { db, admin } = require('../firebaseAdmin');

const toTimestamp = (date) => admin.firestore.Timestamp.fromDate(date);

const cleanData = (data) => Object.fromEntries(
  Object.entries(data).filter(([, value]) => value !== undefined)
);

class OAuthRepository {
  async createAuthorizationCode({
    codeHash,
    userId,
    clientId,
    redirectUri,
    scope,
    resource,
    codeChallenge,
    codeChallengeMethod,
    expiresAt
  }) {
    await db.collection('oauthAuthorizationCodes').doc(codeHash).set(cleanData({
      userId,
      clientId,
      redirectUri,
      scope,
      resource,
      codeChallenge,
      codeChallengeMethod,
      used: false,
      expiresAt: toTimestamp(expiresAt),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }));
  }

  async getAuthorizationCode(codeHash) {
    const snapshot = await db.collection('oauthAuthorizationCodes').doc(codeHash).get();

    if (!snapshot.exists) {
      return null;
    }

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async markAuthorizationCodeUsed(codeHash) {
    await db.collection('oauthAuthorizationCodes').doc(codeHash).update({
      used: true,
      usedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
}

module.exports = new OAuthRepository();
