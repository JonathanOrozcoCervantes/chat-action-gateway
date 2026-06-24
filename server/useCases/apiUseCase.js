const apiService = require('../services/apiService');

class ApiUseCase {
  async getPing() {
    return apiService.getPing();
  }
}

module.exports = new ApiUseCase();
