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
        transaction.set(userRef, userData, { merge: true });
        return;
      }

      transaction.set(userRef, {
        ...userData,
        createdAt: now
      });
    });

    return {
      userId: uid
    };
  }
}

module.exports = new UserRepository();
