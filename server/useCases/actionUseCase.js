const actionService = require('../services/actionService');
const AppError = require('../utils/AppError');

class ActionUseCase {
  async executeAction({ method, type, payload, metadata }) {
    if (method !== 'post' || type !== 'expense') {
      throw new AppError({
        statusCode: 404,
        code: 'unsupported_action',
        message: `Unsupported action: ${method}/${type}.`
      });
    }

    return actionService.createExpense(payload, metadata);
  }
}

module.exports = new ActionUseCase();
