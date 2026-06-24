const { db, admin } = require('../firebaseAdmin');
const AppError = require('../utils/AppError');

class ActionRepository {
  async createExpenseWithIdempotency({
    userId,
    idempotencyKey,
    idempotencyHash,
    expense,
    source = 'chat-action-gateway-mcp',
    authType = 'firebase-google'
  }) {
    const userRef = db.collection('users').doc(userId);
    const idempotencyRef = userRef.collection('idempotencyKeys').doc(idempotencyHash);
    const expenseRef = userRef.collection('expenses').doc();

    return db.runTransaction(async (transaction) => {
      const idempotencySnapshot = await transaction.get(idempotencyRef);

      if (idempotencySnapshot.exists) {
        const idempotencyData = idempotencySnapshot.data();
        throw new AppError({
          statusCode: 409,
          code: 'duplicate_action',
          message: 'A record with this idempotencyKey already exists.',
          details: {
            documentId: idempotencyData.documentId || null
          }
        });
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const expenseDocument = {
        ...expense,
        idempotencyKey,
        idempotencyHash,
        source,
        authType,
        createdAt: now,
        updatedAt: now
      };

      transaction.set(expenseRef, expenseDocument);
      transaction.set(idempotencyRef, {
        action: 'post/expense',
        documentId: expenseRef.id,
        idempotencyKey,
        source,
        authType,
        createdAt: now
      });

      return {
        documentId: expenseRef.id
      };
    });
  }

  async createActionLog(logData) {
    const logRef = db.collection('actionLogs').doc();
    await logRef.set({
      ...logData,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      id: logRef.id
    };
  }
}

module.exports = new ActionRepository();
