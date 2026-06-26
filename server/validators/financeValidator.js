const { createAgentError } = require('../utils/agentError');
const { FINANCE_SCOPES, READ_SCOPES, WRITE_SCOPES } = require('../mcp/scopes');

const MAX_TEXT_LENGTH = 500;
const DEFAULT_CURRENCY = 'MXN';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const ACCOUNT_TYPES = new Set([
  'bank',
  'cash',
  'wallet',
  'credit_card',
  'investment',
  'loan',
  'other'
]);

const PAYMENT_METHOD_TYPES = new Set([
  'debit_card',
  'credit_card',
  'cash',
  'bank_transfer',
  'spei',
  'wallet_balance',
  'other'
]);

const WORKSPACE_TYPES = new Set([
  'personal',
  'business'
]);

const MEMBER_ROLES = new Set([
  'viewer',
  'member',
  'admin'
]);

const MEMBER_ACCESS_LEVELS = new Set([
  'read',
  'write',
  'read_write',
  'custom'
]);

const MOVEMENT_TYPES = new Set([
  'expense',
  'income',
  'transfer',
  'balance_adjustment'
]);

const PERIODS = new Set([
  'today',
  'week',
  'month',
  'year',
  'custom'
]);

const trimText = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

const normalizeLookupName = (value) => trimText(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const normalizeOptionalText = (value, maxLength = MAX_TEXT_LENGTH, field = 'value') => {
  const text = trimText(value);

  if (text.length > maxLength) {
    throw createAgentError({
      code: 'invalid_field',
      message: `${field} is too long.`,
      agentAction: `Ask the user for a shorter ${field} and retry the tool.`,
      details: {
        field,
        maxLength
      }
    });
  }

  return text;
};

const requireText = (payload, field, {
  maxLength = MAX_TEXT_LENGTH,
  agentAction = `Ask the user for ${field} before retrying this tool.`
} = {}) => {
  const value = normalizeOptionalText(payload[field], maxLength, field);

  if (!value) {
    throw createAgentError({
      code: 'missing_fields',
      message: `${field} is required.`,
      agentAction,
      missingFields: [field]
    });
  }

  return value;
};

const normalizeEnum = (payload, field, allowedValues, fallback, agentAction) => {
  const value = trimText(payload[field] || fallback).toLowerCase();

  if (!allowedValues.has(value)) {
    throw createAgentError({
      code: 'invalid_field',
      message: `${field} must be one of: ${Array.from(allowedValues).join(', ')}.`,
      agentAction,
      details: {
        field,
        allowedValues: Array.from(allowedValues)
      }
    });
  }

  return value;
};

const normalizeCurrency = (value = DEFAULT_CURRENCY) => {
  const currency = trimText(value || DEFAULT_CURRENCY).toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw createAgentError({
      code: 'invalid_currency',
      message: 'currency must be an ISO 4217 code like MXN or USD.',
      agentAction: 'Ask the user for the currency, then retry with a 3-letter ISO 4217 code.',
      missingFields: ['currency']
    });
  }

  return currency;
};

const validateDateString = (value, field = 'date') => {
  const date = trimText(value);
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw createAgentError({
      code: 'invalid_date',
      message: `${field} must use YYYY-MM-DD format.`,
      agentAction: `Ask the user for ${field} in YYYY-MM-DD format before retrying.`,
      missingFields: [field]
    });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw createAgentError({
      code: 'invalid_date',
      message: `${field} is not a valid calendar date.`,
      agentAction: `Ask the user for a valid ${field} before retrying.`,
      missingFields: [field]
    });
  }

  return date;
};

const formatDate = (date) => date.toISOString().slice(0, 10);

const addDays = (date, days) => {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

const getUtcDate = (dateString) => {
  const date = validateDateString(dateString, 'referenceDate');
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const getDateRangeForPeriod = ({ period, referenceDate, startDate, endDate }) => {
  const normalizedPeriod = trimText(period || 'month').toLowerCase();

  if (!PERIODS.has(normalizedPeriod)) {
    throw createAgentError({
      code: 'invalid_period',
      message: 'period must be one of: today, week, month, year, custom.',
      agentAction: 'Use a supported period or provide custom startDate and endDate.',
      details: {
        allowedValues: Array.from(PERIODS)
      }
    });
  }

  if (normalizedPeriod === 'custom') {
    return {
      period: normalizedPeriod,
      startDate: validateDateString(startDate, 'startDate'),
      endDate: validateDateString(endDate, 'endDate')
    };
  }

  const reference = getUtcDate(referenceDate || formatDate(new Date()));
  let start;
  let end;

  if (normalizedPeriod === 'today') {
    start = reference;
    end = reference;
  }

  if (normalizedPeriod === 'week') {
    const dayOfWeek = reference.getUTCDay() || 7;
    start = addDays(reference, 1 - dayOfWeek);
    end = addDays(start, 6);
  }

  if (normalizedPeriod === 'month') {
    start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
    end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 0));
  }

  if (normalizedPeriod === 'year') {
    start = new Date(Date.UTC(reference.getUTCFullYear(), 0, 1));
    end = new Date(Date.UTC(reference.getUTCFullYear(), 11, 31));
  }

  return {
    period: normalizedPeriod,
    startDate: formatDate(start),
    endDate: formatDate(end)
  };
};

const validateDateRange = (range) => {
  if (range.startDate > range.endDate) {
    throw createAgentError({
      code: 'invalid_date_range',
      message: 'startDate must be before or equal to endDate.',
      agentAction: 'Ask the user for a valid date range before retrying.',
      missingFields: ['startDate', 'endDate']
    });
  }

  return range;
};

const toMinorUnits = (value, {
  field = 'amount',
  allowNegative = false,
  allowZero = false
} = {}) => {
  const text = trimText(value);
  const match = text.match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);

  if (!match) {
    throw createAgentError({
      code: 'invalid_amount',
      message: `${field} must be a number with up to 2 decimal places.`,
      agentAction: `Ask the user for a valid ${field} and retry the tool.`,
      missingFields: [field]
    });
  }

  const sign = match[1] ? -1 : 1;

  if (sign < 0 && !allowNegative) {
    throw createAgentError({
      code: 'invalid_amount',
      message: `${field} cannot be negative.`,
      agentAction: `Ask the user for a positive ${field} and retry the tool.`,
      missingFields: [field]
    });
  }

  const whole = Number(match[2]);
  const cents = Number((match[3] || '').padEnd(2, '0'));
  const minor = sign * ((whole * 100) + cents);

  if (!allowZero && minor === 0) {
    throw createAgentError({
      code: 'invalid_amount',
      message: `${field} must be greater than zero.`,
      agentAction: `Ask the user for a ${field} greater than zero and retry the tool.`,
      missingFields: [field]
    });
  }

  return minor;
};

const fromMinorUnits = (minor) => Number((Number(minor || 0) / 100).toFixed(2));

const normalizeWorkspaceId = (payload) => normalizeOptionalText(payload.workspaceId, 120, 'workspaceId');

const normalizeEmail = (value) => {
  const email = normalizeOptionalText(value, 320, 'memberEmail').toLowerCase();

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createAgentError({
      code: 'invalid_email',
      message: 'memberEmail must be a valid email address.',
      agentAction: 'Ask the user for the email address used by the member when they signed in with Google, then retry.',
      missingFields: ['memberEmail']
    });
  }

  return email;
};

const normalizeScopeList = (scopes) => {
  if (!Array.isArray(scopes)) {
    return [];
  }

  const allowedScopes = new Set(FINANCE_SCOPES);
  const normalizedScopes = Array.from(new Set(
    scopes
      .map((scope) => trimText(scope))
      .filter(Boolean)
  ));
  const invalidScopes = normalizedScopes.filter((scope) => !allowedScopes.has(scope));

  if (invalidScopes.length) {
    throw createAgentError({
      code: 'invalid_scope',
      message: `Unsupported workspace member scope(s): ${invalidScopes.join(', ')}.`,
      agentAction: 'Use only scopes returned in the tool description. If the user wants read/write access, use accessLevel instead of inventing scopes.',
      details: {
        invalidScopes,
        allowedScopes: FINANCE_SCOPES
      }
    });
  }

  return normalizedScopes;
};

const scopesForAccessLevel = (accessLevel) => {
  if (accessLevel === 'read') {
    return READ_SCOPES;
  }

  if (accessLevel === 'write') {
    return WRITE_SCOPES;
  }

  if (accessLevel === 'read_write') {
    return Array.from(new Set([...READ_SCOPES, ...WRITE_SCOPES]));
  }

  return [];
};

const normalizeAccountSelector = (payload, prefix = '') => {
  const idField = prefix ? `${prefix}AccountId` : 'accountId';
  const nameField = prefix ? `${prefix}AccountName` : 'accountName';

  return {
    accountId: normalizeOptionalText(payload[idField], 120, idField),
    accountName: normalizeOptionalText(payload[nameField], 160, nameField)
  };
};

const normalizePaymentMethodSelector = (payload) => ({
  paymentMethodId: normalizeOptionalText(payload.paymentMethodId, 120, 'paymentMethodId'),
  paymentMethodName: normalizeOptionalText(payload.paymentMethodName, 160, 'paymentMethodName')
});

const validateCreateWorkspacePayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 160,
    agentAction: 'Ask the user for the workspace name before creating it.'
  });

  return {
    name,
    normalizedName: normalizeLookupName(name),
    type: normalizeEnum(payload, 'type', WORKSPACE_TYPES, 'personal', 'Ask whether this workspace is personal or business.'),
    currency: normalizeCurrency(payload.currency || DEFAULT_CURRENCY),
    description: normalizeOptionalText(payload.description, 500, 'description')
  };
};

const validateAddWorkspaceMemberPayload = (payload = {}) => {
  const memberUserId = normalizeOptionalText(payload.memberUserId, 120, 'memberUserId');
  const memberEmail = normalizeEmail(payload.memberEmail);
  const accessLevel = normalizeEnum(
    payload,
    'accessLevel',
    MEMBER_ACCESS_LEVELS,
    'read_write',
    'Use accessLevel read, write, read_write, or custom. For custom, provide explicit scopes.'
  );
  const explicitScopes = normalizeScopeList(payload.scopes);
  const grantedScopes = explicitScopes.length
    ? explicitScopes
    : scopesForAccessLevel(accessLevel);

  if (!memberUserId && !memberEmail) {
    throw createAgentError({
      code: 'missing_member_identifier',
      message: 'memberUserId or memberEmail is required.',
      agentAction: 'Ask for the Google email used by the member when they created their MCP account, then retry with memberEmail.',
      missingFields: ['memberUserId', 'memberEmail']
    });
  }

  if (!grantedScopes.length) {
    throw createAgentError({
      code: 'missing_member_scopes',
      message: 'At least one workspace member scope is required.',
      agentAction: 'Ask whether the member should have read, write, or read/write access. For custom access, provide at least one scope.',
      missingFields: ['scopes']
    });
  }

  return {
    workspaceId: normalizeWorkspaceId(payload),
    memberUserId,
    memberEmail,
    role: normalizeEnum(payload, 'role', MEMBER_ROLES, 'member', 'Use role viewer, member, or admin. Permissions are still controlled by scopes.'),
    accessLevel,
    grantedScopes,
    notes: normalizeOptionalText(payload.notes, 500, 'notes')
  };
};

const validateListWorkspaceMembersPayload = (payload = {}) => ({
  workspaceId: normalizeWorkspaceId(payload),
  includeInactive: Boolean(payload.includeInactive)
});

const validateUpsertAccountPayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 160,
    agentAction: 'Ask the user for the account name before creating or updating it.'
  });
  const balanceValue = payload.balance === undefined || payload.balance === null || payload.balance === ''
    ? 0
    : payload.balance;
  const balanceWasProvided = !(payload.balance === undefined || payload.balance === null || payload.balance === '');
  const balanceMinor = toMinorUnits(balanceValue, {
    field: 'balance',
    allowNegative: true,
    allowZero: true
  });

  return {
    workspaceId: normalizeWorkspaceId(payload),
    accountId: normalizeOptionalText(payload.accountId, 120, 'accountId'),
    name,
    normalizedName: normalizeLookupName(name),
    type: normalizeEnum(payload, 'type', ACCOUNT_TYPES, 'bank', 'Ask the user what type of account this is.'),
    currency: normalizeCurrency(payload.currency || DEFAULT_CURRENCY),
    balanceMinor,
    balance: fromMinorUnits(balanceMinor),
    balanceWasProvided,
    institution: normalizeOptionalText(payload.institution, 160, 'institution'),
    description: normalizeOptionalText(payload.description, 500, 'description'),
    active: payload.active === undefined ? true : Boolean(payload.active)
  };
};

const validateUpsertPaymentMethodPayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 160,
    agentAction: 'Ask the user for the payment method name before creating or updating it.'
  });

  return {
    workspaceId: normalizeWorkspaceId(payload),
    accountId: normalizeOptionalText(payload.accountId, 120, 'accountId'),
    accountName: normalizeOptionalText(payload.accountName, 160, 'accountName'),
    paymentMethodId: normalizeOptionalText(payload.paymentMethodId, 120, 'paymentMethodId'),
    name,
    normalizedName: normalizeLookupName(name),
    type: normalizeEnum(payload, 'type', PAYMENT_METHOD_TYPES, 'debit_card', 'Ask the user what type of payment method this is.'),
    last4: normalizeOptionalText(payload.last4, 4, 'last4'),
    network: normalizeOptionalText(payload.network, 80, 'network'),
    description: normalizeOptionalText(payload.description, 500, 'description'),
    active: payload.active === undefined ? true : Boolean(payload.active)
  };
};

const normalizeMovementBase = (payload = {}, {
  defaultCategory = '',
  categoryRequired = true
} = {}) => {
  const category = categoryRequired
    ? requireText(payload, 'category', {
      maxLength: 80,
      agentAction: 'Ask the user for the category before retrying this tool.'
    })
    : normalizeOptionalText(payload.category || defaultCategory, 80, 'category');

  const amountMinor = toMinorUnits(payload.amount, { field: 'amount' });
  const currency = normalizeCurrency(payload.currency || DEFAULT_CURRENCY);

  return {
    workspaceId: normalizeWorkspaceId(payload),
    amountMinor,
    amount: fromMinorUnits(amountMinor),
    currency,
    date: validateDateString(payload.date, 'date'),
    category,
    description: normalizeOptionalText(payload.description, 260, 'description'),
    notes: normalizeOptionalText(payload.notes, 500, 'notes'),
    idempotencyKey: normalizeOptionalText(payload.idempotencyKey, 260, 'idempotencyKey')
  };
};

const validateCreateExpensePayload = (payload = {}) => ({
  ...normalizeMovementBase(payload),
  merchant: requireText(payload, 'merchant', {
    maxLength: 160,
    agentAction: 'Ask the user where the expense happened before retrying this tool.'
  }),
  ...normalizeAccountSelector(payload),
  ...normalizePaymentMethodSelector(payload)
});

const validateCreateIncomePayload = (payload = {}) => ({
  ...normalizeMovementBase(payload),
  sourceName: normalizeOptionalText(payload.sourceName, 160, 'sourceName'),
  ...normalizeAccountSelector(payload)
});

const validateCreateTransferPayload = (payload = {}) => ({
  ...normalizeMovementBase(payload, {
    defaultCategory: 'transfer',
    categoryRequired: false
  }),
  fromAccountId: normalizeOptionalText(payload.fromAccountId, 120, 'fromAccountId'),
  fromAccountName: normalizeOptionalText(payload.fromAccountName, 160, 'fromAccountName'),
  toAccountId: normalizeOptionalText(payload.toAccountId, 120, 'toAccountId'),
  toAccountName: normalizeOptionalText(payload.toAccountName, 160, 'toAccountName')
});

const validateSetAccountBalancePayload = (payload = {}) => {
  const balanceMinor = toMinorUnits(payload.balance, {
    field: 'balance',
    allowNegative: true,
    allowZero: true
  });

  return {
    workspaceId: normalizeWorkspaceId(payload),
    ...normalizeAccountSelector(payload),
    balanceMinor,
    balance: fromMinorUnits(balanceMinor),
    currency: payload.currency ? normalizeCurrency(payload.currency) : '',
    date: validateDateString(payload.date, 'date'),
    description: normalizeOptionalText(payload.description, 260, 'description'),
    notes: normalizeOptionalText(payload.notes, 500, 'notes'),
    idempotencyKey: normalizeOptionalText(payload.idempotencyKey, 260, 'idempotencyKey')
  };
};

const validateListMovementsPayload = (payload = {}) => {
  const range = validateDateRange(getDateRangeForPeriod({
    period: payload.period,
    referenceDate: payload.referenceDate,
    startDate: payload.startDate,
    endDate: payload.endDate
  }));
  const type = normalizeOptionalText(payload.type, 40, 'type');

  if (type && !MOVEMENT_TYPES.has(type)) {
    throw createAgentError({
      code: 'invalid_movement_type',
      message: `type must be one of: ${Array.from(MOVEMENT_TYPES).join(', ')}.`,
      agentAction: 'Use a supported movement type or omit type.',
      details: {
        allowedValues: Array.from(MOVEMENT_TYPES)
      }
    });
  }

  const rawLimit = payload.limit === undefined ? DEFAULT_LIMIT : Number(payload.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_LIMIT;

  return {
    workspaceId: normalizeWorkspaceId(payload),
    ...range,
    type,
    accountId: normalizeOptionalText(payload.accountId, 120, 'accountId'),
    accountName: normalizeOptionalText(payload.accountName, 160, 'accountName'),
    category: normalizeOptionalText(payload.category, 80, 'category'),
    limit
  };
};

module.exports = {
  fromMinorUnits,
  normalizeCurrency,
  normalizeLookupName,
  toMinorUnits,
  validateAddWorkspaceMemberPayload,
  validateCreateExpensePayload,
  validateCreateIncomePayload,
  validateCreateTransferPayload,
  validateCreateWorkspacePayload,
  validateListMovementsPayload,
  validateListWorkspaceMembersPayload,
  validateSetAccountBalancePayload,
  validateUpsertAccountPayload,
  validateUpsertPaymentMethodPayload
};
