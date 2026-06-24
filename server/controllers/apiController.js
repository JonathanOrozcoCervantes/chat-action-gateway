const apiUseCase = require('../useCases/apiUseCase');

const getPing = async (req, res) => {
  try {
    const data = await apiUseCase.getPing();

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Error in apiController.getPing:', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'api_ping_failed',
        message: 'Could not execute API ping.'
      }
    });
  }
};

module.exports = {
  getPing
};
