const apiRepository = require('../repositories/apiRepository');

class ApiService {
  async getPing() {
    return apiRepository.getPing();
  }
}

module.exports = new ApiService();
