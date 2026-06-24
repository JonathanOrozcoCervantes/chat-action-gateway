const actionRepository = require('../repositories/actionRepository');
const { validateExpenseForUserPayload } = require('../validators/expenseValidator');
const AppError = require('../utils/AppError');
const { hashValue } = require('../utils/security');

class ExpenseService {
  async createExpenseForUser({
    userId,
    payload,
    metadata = {},
    source = 'chat-action-gateway-mcp',
    authType = 'firebase-google'
  }) {
    if (!userId) {
      throw new AppError({
        statusCode: 401,
        code: 'missing_user',
        message: 'A valid user is required to create an expense.'
      });
    }

    const normalizedPayload = validateExpenseForUserPayload(payload);
    const idempotencyHash = hashValue(normalizedPayload.idempotencyKey);
    const logBase = {
      action: 'post/expense',
      idempotencyHash,
      request: normalizedPayload.safeLogPayload,
      metadata: {
        ...metadata,
        source,
        authType
      }
    };

    try {
      const result = await actionRepository.createExpenseWithIdempotency({
        userId,
        idempotencyKey: normalizedPayload.idempotencyKey,
        idempotencyHash,
        expense: normalizedPayload.expense,
        source,
        authType
      });

      await actionRepository.createActionLog({
        ...logBase,
        status: 'success',
        userId,
        documentId: result.documentId
      });

      return {
        action: 'post/expense',
        userId,
        documentId: result.documentId,
        idempotencyKey: normalizedPayload.idempotencyKey
      };
    } catch (error) {
      await this.tryLogFailure({
        ...logBase,
        status: 'error',
        userId,
        errorCode: error.code || 'expense_failed',
        errorMessage: error.message || 'Could not create expense.'
      });

      throw error;
    }
  }

  async tryLogFailure(logData) {
    try {
      await actionRepository.createActionLog(logData);
    } catch (logError) {
      console.error('Error writing expense failure log:', logError);
    }
  }
}

module.exports = new ExpenseService();
