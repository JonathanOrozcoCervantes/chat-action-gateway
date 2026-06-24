const express = require('express');
const apiController = require('../controllers/apiController');
const appCheckVerification = require('../middleware/appCheck');

const router = express.Router();

router.use(appCheckVerification);
router.get('/ping', apiController.getPing);

module.exports = router;
