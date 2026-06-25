const { db, admin } = require('../firebaseAdmin');

const cleanData = (data) => Object.fromEntries(
  Object.entries(data).filter(([, value]) => value !== undefined)
);

const normalizeGrantedScopes = (scopes) => {
  if (!Array.isArray(scopes)) {
    return [];
  }

  return Array.from(new Set(
    scopes
      .map((scope) => String(scope || '').trim())
      .filter(Boolean)
  ));
};

class UserRepository {
  async upsertGoogleUser({
    uid,
    email,
    displayName,
    photoURL,
    emailVerified,
    provider,
    providerUid,
    defaultGrantedScopes = []
  }) {
    const userRef = db.collection('users').doc(uid);
    let grantedScopes = normalizeGrantedScopes(defaultGrantedScopes);

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(userRef);
      const now = admin.firestore.FieldValue.serverTimestamp();
      const existingGrantedScopes = snapshot.exists
        ? normalizeGrantedScopes(snapshot.get('grantedScopes'))
        : [];
      const shouldInitializeGrantedScopes = !snapshot.exists
        || !Array.isArray(snapshot.get('grantedScopes'));

      grantedScopes = shouldInitializeGrantedScopes
        ? normalizeGrantedScopes(defaultGrantedScopes)
        : existingGrantedScopes;

      const userData = cleanData({
        email,
        displayName,
        photoURL,
        emailVerified,
        provider,
        providerUid,
        updatedAt: now,
        lastLoginAt: now
      });

      if (snapshot.exists) {
        transaction.set(userRef, cleanData({
          ...userData,
          grantedScopes: shouldInitializeGrantedScopes ? grantedScopes : undefined
        }), { merge: true });
        return;
      }

      transaction.set(userRef, {
        ...userData,
        grantedScopes,
        createdAt: now
      });
    });

    return {
      userId: uid,
      grantedScopes
    };
  }

  async getGrantedScopes(uid) {
    const snapshot = await db.collection('users').doc(uid).get();

    if (!snapshot.exists) {
      return [];
    }

    return normalizeGrantedScopes(snapshot.get('grantedScopes'));
  }
}

module.exports = new UserRepository();
