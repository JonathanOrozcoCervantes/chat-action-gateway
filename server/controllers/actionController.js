const actionUseCase = require('../useCases/actionUseCase');

const executeAction = async (req, res) => {
  try {
    const { method, type } = req.params;
    const payload = {
      ...req.query,
      ...req.body
    };

    const result = await actionUseCase.executeAction({
      method,
      type,
      payload,
      metadata: {
        ip: req.ip,
        origin: req.get('origin') || '',
        referer: req.get('referer') || '',
        userAgent: req.get('user-agent') || ''
      }
    });

    return res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;

    if (statusCode >= 500) {
      console.error('Error in actionController.executeAction:', error);
    }

    return res.status(statusCode).json({
      success: false,
      error: {
        code: error.code || 'action_failed',
        message: error.message || 'Could not execute action.',
        details: error.details || null
      }
    });
  }
};

module.exports = {
  executeAction
};
