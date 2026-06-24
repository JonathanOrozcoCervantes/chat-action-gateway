const express = require('express');
const actionController = require('../controllers/actionController');
const appCheckVerification = require('../middleware/appCheck');

const router = express.Router();

router.use(appCheckVerification);
router.post('/:method/:type', actionController.executeAction);

module.exports = router;
