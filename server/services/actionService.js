const actionRepository = require('../repositories/actionRepository');
const expenseService = require('./expenseService');
const { validateExpensePayload } = require('../validators/expenseValidator');
const AppError = require('../utils/AppError');
const { hashValue, safeHashPrefix } = require('../utils/security');

class ActionService {
  async createExpense(payload, metadata) {
    const normalizedPayload = validateExpensePayload(payload);
    const tokenHash = hashValue(normalizedPayload.token);
    const idempotencyHash = hashValue(normalizedPayload.idempotencyKey);
    const logBase = {
      action: 'post/expense',
      idempotencyHash,
      tokenHashPrefix: safeHashPrefix(tokenHash),
      request: normalizedPayload.safeLogPayload,
      metadata
    };

    try {
      const token = await actionRepository.getActiveToken(tokenHash);

      if (!token) {
        throw new AppError({
          statusCode: 401,
          code: 'invalid_token',
          message: 'Invalid or inactive token.'
        });
      }

      return expenseService.createExpenseForUser({
        userId: token.userId,
        tokenHash,
        payload: {
          ...normalizedPayload.expense,
          idempotencyKey: normalizedPayload.idempotencyKey
        },
        metadata,
        source: 'chat-action-gateway-api',
        authType: 'action-token'
      });
    } catch (error) {
      await this.tryLogFailure({
        ...logBase,
        status: 'error',
        errorCode: error.code || 'action_failed',
        errorMessage: error.message || 'Could not create expense.'
      });

      throw error;
    }
  }

  async tryLogFailure(logData) {
    try {
      await actionRepository.createActionLog(logData);
    } catch (logError) {
      console.error('Error writing action failure log:', logError);
    }
  }
}

module.exports = new ActionService();
