class ApiRepository {
  async getPing() {
    return {
      message: "I'm alive...",
      checkedAt: new Date().toISOString(),
      source: 'api-reference'
    };
  }
}

module.exports = new ApiRepository();
