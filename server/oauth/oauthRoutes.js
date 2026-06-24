const express = require('express');
const oauthController = require('./oauthController');

const router = express.Router();

router.get('/authorize', oauthController.getAuthorizePage);
router.post('/authorize', oauthController.authorize);
router.post('/token', oauthController.token);
router.post('/register', oauthController.registerClient);

module.exports = router;
