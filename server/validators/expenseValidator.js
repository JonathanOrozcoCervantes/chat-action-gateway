const AppError = require('../utils/AppError');

const REQUIRED_FIELDS = [
  'amount',
  'merchant',
  'category',
  'date',
  'currency',
  'idempotencyKey',
  'token'
];

const MAX_TEXT_LENGTH = 500;

const trimText = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

const validateRequiredFields = (payload) => {
  const missingFields = REQUIRED_FIELDS.filter((field) => !trimText(payload[field]));

  if (missingFields.length) {
    throw new AppError({
      statusCode: 400,
      code: 'missing_fields',
      message: `Missing required fields: ${missingFields.join(', ')}.`,
      details: {
        missingFields
      }
    });
  }
};

const validateTextLength = (field, value, maxLength = MAX_TEXT_LENGTH) => {
  if (value.length > maxLength) {
    throw new AppError({
      statusCode: 400,
      code: 'invalid_field',
      message: `${field} is too long.`,
      details: {
        field,
        maxLength
      }
    });
  }
};

const validateExpensePayload = (payload) => {
  validateRequiredFields(payload);

  const amount = Number(trimText(payload.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError({
      statusCode: 400,
      code: 'invalid_amount',
      message: 'amount must be a positive number.'
    });
  }

  const date = trimText(payload.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError({
      statusCode: 400,
      code: 'invalid_date',
      message: 'date must use YYYY-MM-DD format.'
    });
  }

  const currency = trimText(payload.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError({
      statusCode: 400,
      code: 'invalid_currency',
      message: 'currency must use ISO 4217 format, like MXN or USD.'
    });
  }

  const merchant = trimText(payload.merchant);
  const category = trimText(payload.category);
  const description = trimText(payload.description);
  const paymentMethod = trimText(payload.paymentMethod);
  const notes = trimText(payload.notes);
  const idempotencyKey = trimText(payload.idempotencyKey);
  const token = trimText(payload.token);

  [
    ['merchant', merchant, 160],
    ['category', category, 80],
    ['description', description, 260],
    ['paymentMethod', paymentMethod, 80],
    ['notes', notes, 500],
    ['idempotencyKey', idempotencyKey, 260],
    ['token', token, 260]
  ].forEach(([field, value, maxLength]) => validateTextLength(field, value, maxLength));

  const expense = {
    amount,
    merchant,
    category,
    date,
    currency,
    description: description || '',
    paymentMethod: paymentMethod || '',
    notes: notes || ''
  };

  return {
    token,
    idempotencyKey,
    expense,
    safeLogPayload: {
      ...expense,
      idempotencyKey
    }
  };
};

module.exports = {
  validateExpensePayload
};
