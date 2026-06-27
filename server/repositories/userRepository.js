const { db, admin } = require('../firebaseAdmin');

const cleanData = (data) => Object.fromEntries(
  Object.entries(data).filter(([, value]) => value !== undefined)
);

class UserRepository {
  async upsertGoogleUser({
    uid,
    email,
    displayName,
    photoURL,
    emailVerified,
    provider,
    providerUid
  }) {
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(userRef);
      const now = admin.firestore.FieldValue.serverTimestamp();
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
          ...userData
        }), { merge: true });
        return;
      }

      transaction.set(userRef, {
        ...userData,
        oauthTokenVersion: 0,
        createdAt: now
      });
    });

    return {
      userId: uid
    };
  }

  async getUserAuthState(userId) {
    const snapshot = await db.collection('users').doc(userId).get();

    if (!snapshot.exists) {
      return null;
    }

    const user = snapshot.data();

    return {
      userId: snapshot.id,
      oauthTokenVersion: Number.isInteger(user.oauthTokenVersion) ? user.oauthTokenVersion : 0
    };
  }

  async incrementOAuthTokenVersion(userId) {
    const userRef = db.collection('users').doc(userId);

    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(userRef);

      if (!snapshot.exists) {
        throw new Error(`User ${userId} does not exist.`);
      }

      const user = snapshot.data();
      const currentVersion = Number.isInteger(user.oauthTokenVersion) ? user.oauthTokenVersion : 0;
      const nextVersion = currentVersion + 1;

      transaction.set(userRef, {
        oauthTokenVersion: nextVersion,
        oauthTokenVersionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return nextVersion;
    });
  }
}

module.exports = new UserRepository();
