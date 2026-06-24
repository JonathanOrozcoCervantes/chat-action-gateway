const { db, admin } = require('../firebaseAdmin');

const toTimestamp = (date) => admin.firestore.Timestamp.fromDate(date);

const cleanData = (data) => Object.fromEntries(
  Object.entries(data).filter(([, value]) => value !== undefined)
);

class OAuthRepository {
  async createClient({ clientId, clientName, redirectUris, scope }) {
    await db.collection('oauthClients').doc(clientId).set(cleanData({
      clientName,
      redirectUris,
      scope,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }));

    return {
      clientId
    };
  }

  async getClient(clientId) {
    if (!clientId) {
      return null;
    }

    const snapshot = await db.collection('oauthClients').doc(clientId).get();

    if (!snapshot.exists) {
      return null;
    }

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async createAuthorizationCode({
    codeHash,
    userId,
    actionTokenHash,
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
      actionTokenHash,
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

  async createAccessToken({
    accessTokenHash,
    userId,
    actionTokenHash,
    clientId,
    scope,
    resource,
    expiresAt
  }) {
    await db.collection('oauthAccessTokens').doc(accessTokenHash).set(cleanData({
      userId,
      actionTokenHash,
      clientId,
      scope,
      resource,
      active: true,
      expiresAt: toTimestamp(expiresAt),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }));
  }

  async getAccessToken(accessTokenHash) {
    const snapshot = await db.collection('oauthAccessTokens').doc(accessTokenHash).get();

    if (!snapshot.exists) {
      return null;
    }

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async createRefreshToken({
    refreshTokenHash,
    userId,
    actionTokenHash,
    clientId,
    scope,
    resource
  }) {
    await db.collection('oauthRefreshTokens').doc(refreshTokenHash).set(cleanData({
      userId,
      actionTokenHash,
      clientId,
      scope,
      resource,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }));
  }

  async getRefreshToken(refreshTokenHash) {
    const snapshot = await db.collection('oauthRefreshTokens').doc(refreshTokenHash).get();

    if (!snapshot.exists) {
      return null;
    }

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }
}

module.exports = new OAuthRepository();
