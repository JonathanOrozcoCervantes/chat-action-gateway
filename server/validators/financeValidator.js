const { createAgentError } = require('../utils/agentError');
const { FINANCE_SCOPES, READ_SCOPES, WRITE_SCOPES } = require('../mcp/profiles/finance/scopes');

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

const CATEGORY_TYPES = new Set([
  'expense',
  'income',
  'both'
]);

const WORKSPACE_TYPES = new Set([
  'personal',
  'household',
  'business'
]);

const MEMBER_ROLES = new Set([
  'viewer',
  'member',
  'admin'
]);

const FINANCIAL_GOAL_TYPES = new Set([
  'purchase',
  'savings',
  'debt_payoff',
  'investment',
  'retirement',
  'emergency_fund',
  'education',
  'housing',
  'travel',
  'other'
]);

const FINANCIAL_GOAL_STATUSES = new Set([
  'active',
  'paused',
  'completed',
  'cancelled'
]);

const FINANCIAL_GOAL_PRIORITIES = new Set([
  'low',
  'medium',
  'high'
]);

const MOVEMENT_TYPES = new Set([
  'expense',
  'income',
  'transfer',
  'balance_adjustment',
  'credit_disbursement',
  'credit_purchase',
  'credit_payment',
  'credit_disbursement_void',
  'credit_purchase_void',
  'credit_payment_void'
]);

const CREDIT_STATUSES = new Set([
  'active',
  'paid',
  'cancelled'
]);

const CREDIT_INTEREST_TYPES = new Set([
  'no_interest',
  'msi',
  'fixed_total',
  'fixed_payment'
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

const requireEnum = (payload, field, allowedValues, agentAction) => {
  const value = trimText(payload[field]).toLowerCase();

  if (!value) {
    throw createAgentError({
      code: 'missing_fields',
      message: `${field} is required.`,
      agentAction,
      missingFields: [field],
      details: {
        allowedValues: Array.from(allowedValues)
      }
    });
  }

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

const normalizeOptionalEnum = (payload, field, allowedValues, agentAction) => {
  const value = normalizeOptionalText(payload[field], 80, field).toLowerCase();

  if (!value) {
    return undefined;
  }

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

const validateNotFutureDate = (date, field = 'date', {
  agentAction = `Ask the user for ${field} again before retrying.`
} = {}) => {
  const today = formatDate(new Date());

  if (date > today) {
    throw createAgentError({
      code: 'future_date_not_allowed',
      message: `${field} cannot be in the future for this action.`,
      agentAction,
      missingFields: [field],
      details: {
        field,
        providedDate: date,
        maxDate: today
      }
    });
  }

  return date;
};

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

const normalizeBalanceForAccountType = ({ accountType, balanceMinor }) => {
  if (accountType === 'credit_card' && balanceMinor > 0) {
    return -balanceMinor;
  }

  return balanceMinor;
};

const requirePositiveInteger = (payload, field, agentAction) => {
  const value = Number(payload[field]);

  if (!Number.isInteger(value) || value <= 0) {
    throw createAgentError({
      code: 'invalid_field',
      message: `${field} must be a positive integer.`,
      agentAction,
      missingFields: [field]
    });
  }

  return value;
};

const requireOptionalPositiveInteger = (payload, field, agentAction) => {
  if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
    return undefined;
  }

  return requirePositiveInteger(payload, field, agentAction);
};

const requireOptionalMoney = (payload, field, options = {}) => {
  if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
    return null;
  }

  return toMinorUnits(payload[field], {
    field,
    allowZero: true,
    ...options
  });
};

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

const scopesForMemberRole = (role) => {
  if (role === 'viewer') {
    return READ_SCOPES;
  }

  if (role === 'member') {
    return Array.from(new Set([...READ_SCOPES, ...WRITE_SCOPES]));
  }

  return FINANCE_SCOPES;
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

const normalizeCategorySelector = (payload) => ({
  categoryId: normalizeOptionalText(payload.categoryId, 120, 'categoryId'),
  categoryName: normalizeOptionalText(payload.categoryName || payload.category, 80, 'categoryName')
});

const normalizeCreditSelector = (payload) => ({
  creditId: normalizeOptionalText(payload.creditId, 120, 'creditId'),
  creditName: normalizeOptionalText(payload.creditName || payload.name, 160, 'creditName')
});

const normalizeTextArray = (payload, field, {
  maxItems = 20,
  maxLength = 80
} = {}) => {
  if (payload[field] === undefined || payload[field] === null) {
    return undefined;
  }

  if (!Array.isArray(payload[field])) {
    throw createAgentError({
      code: 'invalid_field',
      message: `${field} must be an array of text values.`,
      agentAction: `Ask the user for ${field} as a short list, then retry.`,
      details: {
        field
      }
    });
  }

  if (payload[field].length > maxItems) {
    throw createAgentError({
      code: 'invalid_field',
      message: `${field} cannot contain more than ${maxItems} items.`,
      agentAction: `Ask the user to reduce ${field} and retry.`,
      details: {
        field,
        maxItems
      }
    });
  }

  return Array.from(new Set(
    payload[field]
      .map((value) => normalizeOptionalText(value, maxLength, field))
      .filter(Boolean)
  ));
};

const normalizeRepaymentPlan = (payload, { principalMinor, allowMsi = false } = {}) => {
  const termMonths = requirePositiveInteger(
    payload,
    'termMonths',
    'Ask the user how many months/installments the credit or financed purchase will be paid over.'
  );
  const firstPaymentDate = validateDateString(payload.firstPaymentDate, 'firstPaymentDate');
  const allowedInterestTypes = allowMsi
    ? CREDIT_INTEREST_TYPES
    : new Set(Array.from(CREDIT_INTEREST_TYPES).filter((item) => item !== 'msi'));
  const interestType = requireEnum(
    payload,
    'interestType',
    allowedInterestTypes,
    allowMsi
      ? 'Ask whether this is MSI/no-interest, or whether there is a fixed total or fixed monthly payment.'
      : 'Ask whether this credit has no interest, a fixed total to repay, or a fixed monthly payment.'
  );
  const totalRepaymentInputMinor = requireOptionalMoney(payload, 'totalRepaymentAmount', { allowZero: false });
  const monthlyPaymentInputMinor = requireOptionalMoney(payload, 'monthlyPayment', { allowZero: false });
  const interestAmountInputMinor = requireOptionalMoney(payload, 'interestAmount');
  let totalRepaymentMinor = totalRepaymentInputMinor;
  let monthlyPaymentMinor = monthlyPaymentInputMinor;
  let interestAmountMinor = interestAmountInputMinor;

  if (interestType === 'no_interest' || interestType === 'msi') {
    totalRepaymentMinor = principalMinor;
    interestAmountMinor = 0;
  }

  if (interestType === 'fixed_total') {
    if (totalRepaymentMinor === null && interestAmountMinor !== null) {
      totalRepaymentMinor = principalMinor + interestAmountMinor;
    }

    if (totalRepaymentMinor === null) {
      throw createAgentError({
        code: 'missing_credit_repayment_total',
        message: 'totalRepaymentAmount or interestAmount is required for fixed_total credits.',
        agentAction: 'Ask the user for the total amount they will repay, or the total interest/extra cost charged for the whole plan. Do not estimate it.',
        missingFields: ['totalRepaymentAmount', 'interestAmount']
      });
    }

    interestAmountMinor = totalRepaymentMinor - principalMinor;
  }

  if (interestType === 'fixed_payment') {
    if (monthlyPaymentMinor === null) {
      throw createAgentError({
        code: 'missing_monthly_payment',
        message: 'monthlyPayment is required for fixed_payment credits.',
        agentAction: 'Ask the user the exact monthly payment amount. Do not estimate it from the principal.',
        missingFields: ['monthlyPayment']
      });
    }

    totalRepaymentMinor = monthlyPaymentMinor * termMonths;
    interestAmountMinor = totalRepaymentMinor - principalMinor;
  }

  if (totalRepaymentMinor < principalMinor) {
    throw createAgentError({
      code: 'invalid_repayment_amount',
      message: 'Total repayment cannot be lower than the financed amount.',
      agentAction: 'Ask the user to confirm the financed amount, term, and total repayment or monthly payment.',
      missingFields: ['totalRepaymentAmount', 'monthlyPayment']
    });
  }

  return {
    termMonths,
    firstPaymentDate,
    interestType,
    monthlyPaymentMinor,
    monthlyPayment: monthlyPaymentMinor === null ? null : fromMinorUnits(monthlyPaymentMinor),
    totalRepaymentMinor,
    totalRepayment: fromMinorUnits(totalRepaymentMinor),
    interestAmountMinor,
    interestAmount: fromMinorUnits(interestAmountMinor),
    principalSplitKnown: interestType === 'no_interest' || interestType === 'msi'
  };
};

const validateCreateWorkspacePayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 160,
    agentAction: 'Ask the user for the workspace name before creating it.'
  });

  return {
    name,
    normalizedName: normalizeLookupName(name),
    type: normalizeEnum(payload, 'type', WORKSPACE_TYPES, 'personal', 'Ask whether this workspace is personal, household, or business.'),
    currency: normalizeCurrency(payload.currency || DEFAULT_CURRENCY),
    description: normalizeOptionalText(payload.description, 500, 'description')
  };
};

const validateUpsertWorkspacePayload = (payload = {}) => {
  const workspaceId = normalizeWorkspaceId(payload);
  const name = hasOwnField(payload, 'name')
    ? normalizeOptionalText(payload.name, 160, 'name')
    : '';
  const type = normalizeOptionalEnum(
    payload,
    'type',
    WORKSPACE_TYPES,
    'Ask whether this workspace is personal, household, or business.'
  );
  const currency = hasOwnField(payload, 'currency') ? normalizeCurrency(payload.currency || DEFAULT_CURRENCY) : undefined;
  const description = hasOwnField(payload, 'description')
    ? normalizeOptionalText(payload.description, 500, 'description')
    : undefined;
  const active = hasOwnField(payload, 'active') ? Boolean(payload.active) : undefined;

  if (!workspaceId && !name) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'name is required when creating a workspace.',
      agentAction: 'Ask the user for the workspace name before creating it.',
      missingFields: ['name']
    });
  }

  const hasUpdates = [name, type, currency, description, active].some((value) => value !== undefined && value !== '');

  if (workspaceId && !hasUpdates) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'At least one workspace field is required when updating a workspace.',
      agentAction: 'Ask the user what they want to change in this workspace, then retry.',
      missingFields: ['name', 'type', 'currency', 'description', 'active']
    });
  }

  return {
    workspaceId,
    name: name || undefined,
    normalizedName: name ? normalizeLookupName(name) : undefined,
    type: type || (!workspaceId ? 'personal' : undefined),
    currency: currency || (!workspaceId ? DEFAULT_CURRENCY : undefined),
    description,
    active
  };
};

const validateUpsertWorkspaceMemberPayload = (payload = {}) => {
  const memberUserId = normalizeOptionalText(payload.memberUserId, 120, 'memberUserId');
  const memberEmail = normalizeEmail(payload.memberEmail);
  const role = normalizeEnum(payload, 'role', MEMBER_ROLES, 'member', 'Ask whether the member should be viewer, member, or admin.');
  const grantedScopes = scopesForMemberRole(role);

  if (!memberUserId && !memberEmail) {
    throw createAgentError({
      code: 'missing_member_identifier',
      message: 'memberUserId or memberEmail is required.',
      agentAction: 'Ask for the Google email used by the member when they created their MCP account, then retry with memberEmail.',
      missingFields: ['memberUserId', 'memberEmail']
    });
  }

  return {
    workspaceId: normalizeWorkspaceId(payload),
    memberUserId,
    memberEmail,
    role,
    grantedScopes,
    notes: normalizeOptionalText(payload.notes, 500, 'notes')
  };
};

const validateListWorkspaceMembersPayload = (payload = {}) => ({
  workspaceId: normalizeWorkspaceId(payload),
  includeInactive: Boolean(payload.includeInactive)
});

const hasOwnField = (payload, field) => Object.prototype.hasOwnProperty.call(payload, field);

const normalizeOptionalMoneyUpdate = (payload, field) => {
  if (!hasOwnField(payload, field)) {
    return {
      amountMinor: undefined,
      amount: undefined
    };
  }

  const amountMinor = requireOptionalMoney(payload, field);

  return {
    amountMinor,
    amount: amountMinor === null ? null : fromMinorUnits(amountMinor)
  };
};

const normalizeOptionalDateUpdate = (payload, field) => {
  if (!hasOwnField(payload, field)) {
    return undefined;
  }

  const value = normalizeOptionalText(payload[field], 20, field);

  return value ? validateDateString(value, field) : null;
};

const normalizeOptionalPositiveIntegerUpdate = (payload, field, agentAction) => {
  if (!hasOwnField(payload, field)) {
    return undefined;
  }

  if (payload[field] === null || payload[field] === '') {
    return null;
  }

  return requireOptionalPositiveInteger(payload, field, agentAction);
};

const validateListFinancialGoalsPayload = (payload = {}) => {
  const type = normalizeOptionalEnum(
    payload,
    'type',
    FINANCIAL_GOAL_TYPES,
    'Use a supported goal type or omit type to list all goal types.'
  );
  const status = normalizeOptionalEnum(
    payload,
    'status',
    FINANCIAL_GOAL_STATUSES,
    'Use active, paused, completed, cancelled, or omit status to list all statuses.'
  );

  return {
    workspaceId: normalizeWorkspaceId(payload),
    type: type || '',
    status: status || '',
    includeInactive: Boolean(payload.includeInactive)
  };
};

const validateUpsertFinancialGoalPayload = (payload = {}) => {
  const workspaceId = normalizeWorkspaceId(payload);
  const goalId = normalizeOptionalText(payload.goalId, 120, 'goalId');
  const name = hasOwnField(payload, 'name')
    ? normalizeOptionalText(payload.name, 160, 'name')
    : '';

  if (!goalId && !name) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'name is required when goalId is omitted.',
      agentAction: 'Ask the user for a short goal name, or call list_financial_goals and retry with the selected goalId.',
      missingFields: ['name'],
      suggestedTool: 'list_financial_goals'
    });
  }

  const targetAmount = normalizeOptionalMoneyUpdate(payload, 'targetAmount');
  const currentAmount = normalizeOptionalMoneyUpdate(payload, 'currentAmount');
  const monthlyContribution = normalizeOptionalMoneyUpdate(payload, 'monthlyContribution');
  const goal = {
    workspaceId,
    goalId,
    name: name || undefined,
    normalizedName: name ? normalizeLookupName(name) : undefined,
    type: normalizeOptionalEnum(
      payload,
      'type',
      FINANCIAL_GOAL_TYPES,
      'Use one supported financial goal type, or omit type if unknown.'
    ),
    status: normalizeOptionalEnum(
      payload,
      'status',
      FINANCIAL_GOAL_STATUSES,
      'Use active, paused, completed, or cancelled.'
    ),
    priority: normalizeOptionalEnum(
      payload,
      'priority',
      FINANCIAL_GOAL_PRIORITIES,
      'Use low, medium, or high priority.'
    ),
    currency: hasOwnField(payload, 'currency') ? normalizeCurrency(payload.currency || DEFAULT_CURRENCY) : undefined,
    targetAmountMinor: targetAmount.amountMinor,
    targetAmount: targetAmount.amount,
    currentAmountMinor: currentAmount.amountMinor,
    currentAmount: currentAmount.amount,
    monthlyContributionMinor: monthlyContribution.amountMinor,
    monthlyContribution: monthlyContribution.amount,
    targetDate: normalizeOptionalDateUpdate(payload, 'targetDate'),
    targetAge: normalizeOptionalPositiveIntegerUpdate(
      payload,
      'targetAge',
      'Ask the user for the target age as a positive whole number, or omit targetAge.'
    ),
    description: hasOwnField(payload, 'description') ? normalizeOptionalText(payload.description, 1000, 'description') : undefined,
    motivation: hasOwnField(payload, 'motivation') ? normalizeOptionalText(payload.motivation, 1000, 'motivation') : undefined,
    notes: hasOwnField(payload, 'notes') ? normalizeOptionalText(payload.notes, 1500, 'notes') : undefined,
    tags: normalizeTextArray(payload, 'tags', { maxItems: 20, maxLength: 80 }),
    active: hasOwnField(payload, 'active') ? Boolean(payload.active) : undefined
  };

  const hasUpdates = Object.entries(goal)
    .filter(([field]) => !['workspaceId', 'goalId'].includes(field))
    .some(([, value]) => value !== undefined);

  if (goalId && !hasUpdates) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'At least one goal field is required when updating by goalId.',
      agentAction: 'Ask the user what they want to change in this financial goal, then retry.',
      missingFields: ['name', 'type', 'status', 'priority', 'targetAmount', 'targetDate', 'description']
    });
  }

  return goal;
};

const validateUpsertCategoryPayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 80,
    agentAction: 'Ask the user for the category name before creating or updating it.'
  });

  return {
    workspaceId: normalizeWorkspaceId(payload),
    categoryId: normalizeOptionalText(payload.categoryId, 120, 'categoryId'),
    name,
    normalizedName: normalizeLookupName(name),
    type: requireEnum(
      payload,
      'type',
      CATEGORY_TYPES,
      'Ask whether this category is for expenses, income, or both before creating it.'
    ),
    description: normalizeOptionalText(payload.description, 500, 'description'),
    active: payload.active === undefined ? true : Boolean(payload.active)
  };
};

const validateListCategoriesPayload = (payload = {}) => {
  const type = normalizeOptionalText(payload.type, 40, 'type').toLowerCase();

  if (type && !CATEGORY_TYPES.has(type)) {
    throw createAgentError({
      code: 'invalid_field',
      message: `type must be one of: ${Array.from(CATEGORY_TYPES).join(', ')}.`,
      agentAction: 'Use type expense, income, both, or omit type to list all categories.',
      details: {
        field: 'type',
        allowedValues: Array.from(CATEGORY_TYPES)
      }
    });
  }

  return {
    workspaceId: normalizeWorkspaceId(payload),
    type,
    includeInactive: Boolean(payload.includeInactive)
  };
};

const validateUpsertAccountPayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 160,
    agentAction: 'Ask the user for the account name before creating or updating it.'
  });
  const type = normalizeEnum(payload, 'type', ACCOUNT_TYPES, 'bank', 'Ask the user what type of account this is.');
  const balanceValue = payload.balance === undefined || payload.balance === null || payload.balance === ''
    ? 0
    : payload.balance;
  const balanceWasProvided = !(payload.balance === undefined || payload.balance === null || payload.balance === '');
  const parsedBalanceMinor = toMinorUnits(balanceValue, {
    field: 'balance',
    allowNegative: true,
    allowZero: true
  });
  const balanceMinor = normalizeBalanceForAccountType({
    accountType: type,
    balanceMinor: parsedBalanceMinor
  });
  const creditLimitMinor = requireOptionalMoney(payload, 'creditLimit');

  return {
    workspaceId: normalizeWorkspaceId(payload),
    accountId: normalizeOptionalText(payload.accountId, 120, 'accountId'),
    name,
    normalizedName: normalizeLookupName(name),
    type,
    currency: normalizeCurrency(payload.currency || DEFAULT_CURRENCY),
    balanceMinor,
    balance: fromMinorUnits(balanceMinor),
    balanceWasProvided,
    creditLimitMinor,
    creditLimit: creditLimitMinor === null ? null : fromMinorUnits(creditLimitMinor),
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

const normalizeMovementBase = (payload = {}) => {
  const amountMinor = toMinorUnits(payload.amount, { field: 'amount' });
  const currency = normalizeCurrency(payload.currency || DEFAULT_CURRENCY);

  return {
    workspaceId: normalizeWorkspaceId(payload),
    amountMinor,
    amount: fromMinorUnits(amountMinor),
    currency,
    date: validateDateString(payload.date, 'date'),
    ...normalizeCategorySelector(payload),
    description: normalizeOptionalText(payload.description, 260, 'description'),
    notes: normalizeOptionalText(payload.notes, 500, 'notes'),
    idempotencyKey: normalizeOptionalText(payload.idempotencyKey, 260, 'idempotencyKey')
  };
};

const normalizeMovementId = (payload) => normalizeOptionalText(payload.movementId || payload.documentId, 120, 'movementId');

const validateCreateExpensePayload = (payload = {}) => ({
  ...normalizeMovementBase(payload),
  merchant: requireText(payload, 'merchant', {
    maxLength: 160,
    agentAction: 'Ask the user where the expense happened before retrying this tool.'
  }),
  ...normalizeAccountSelector(payload),
  ...normalizePaymentMethodSelector(payload)
});

const validateUpsertExpensePayload = (payload = {}) => ({
  ...validateCreateExpensePayload(payload),
  movementId: normalizeMovementId(payload)
});

const validateCreateIncomePayload = (payload = {}) => ({
  ...normalizeMovementBase(payload),
  sourceName: normalizeOptionalText(payload.sourceName, 160, 'sourceName'),
  ...normalizeAccountSelector(payload)
});

const validateUpsertIncomePayload = (payload = {}) => ({
  ...validateCreateIncomePayload(payload),
  movementId: normalizeMovementId(payload)
});

const validateCreateTransferPayload = (payload = {}) => ({
  ...normalizeMovementBase(payload),
  category: normalizeOptionalText(payload.category || 'transfer', 80, 'category'),
  fromAccountId: normalizeOptionalText(payload.fromAccountId, 120, 'fromAccountId'),
  fromAccountName: normalizeOptionalText(payload.fromAccountName, 160, 'fromAccountName'),
  toAccountId: normalizeOptionalText(payload.toAccountId, 120, 'toAccountId'),
  toAccountName: normalizeOptionalText(payload.toAccountName, 160, 'toAccountName')
});

const validateUpsertTransferPayload = (payload = {}) => ({
  ...validateCreateTransferPayload(payload),
  movementId: normalizeMovementId(payload)
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

const validateCreateCreditPayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 160,
    agentAction: 'Ask the user what display name they want to use for this credit, such as Personal Loan, Payroll Credit, Bank Credit, Store Credit, or Car Loan.'
  });
  const principalMinor = toMinorUnits(payload.amount, { field: 'amount' });
  const plan = normalizeRepaymentPlan(payload, {
    principalMinor,
    allowMsi: false
  });

  return {
    workspaceId: normalizeWorkspaceId(payload),
    name,
    normalizedName: normalizeLookupName(name),
    type: 'cash_credit',
    amountMinor: principalMinor,
    amount: fromMinorUnits(principalMinor),
    currency: normalizeCurrency(payload.currency || DEFAULT_CURRENCY),
    startDate: validateDateString(payload.startDate || payload.date, 'startDate'),
    provider: requireText(payload, 'provider', {
      maxLength: 160,
      agentAction: 'Ask who issued the credit or loan, such as a bank, store, fintech, employer, or person.'
    }),
    ...normalizeAccountSelector({
      accountId: payload.disbursementAccountId,
      accountName: payload.disbursementAccountName
    }),
    ...plan,
    description: normalizeOptionalText(payload.description, 500, 'description'),
    notes: normalizeOptionalText(payload.notes, 500, 'notes'),
    idempotencyKey: normalizeOptionalText(payload.idempotencyKey, 260, 'idempotencyKey')
  };
};

const validateCreateCreditPurchasePayload = (payload = {}) => {
  const name = requireText(payload, 'name', {
    maxLength: 160,
    agentAction: 'Ask the user what display name they want to use for this financed purchase, such as Phone, Laptop, Refrigerator, Motorcycle, Furniture, or Dental Treatment.'
  });
  const amountMinor = toMinorUnits(payload.amount, { field: 'amount' });
  const plan = normalizeRepaymentPlan(payload, {
    principalMinor: amountMinor,
    allowMsi: true
  });

  return {
    workspaceId: normalizeWorkspaceId(payload),
    name,
    normalizedName: normalizeLookupName(name),
    type: 'installment_purchase',
    amountMinor,
    amount: fromMinorUnits(amountMinor),
    currency: normalizeCurrency(payload.currency || DEFAULT_CURRENCY),
    date: validateDateString(payload.date, 'date'),
    merchant: requireText(payload, 'merchant', {
      maxLength: 160,
      agentAction: 'Ask where the financed purchase was made before registering it.'
    }),
    provider: normalizeOptionalText(payload.provider || payload.financingProvider, 160, 'provider'),
    ...normalizeCategorySelector(payload),
    creditAccountId: normalizeOptionalText(payload.creditAccountId || payload.accountId, 120, 'creditAccountId'),
    creditAccountName: normalizeOptionalText(payload.creditAccountName || payload.accountName, 160, 'creditAccountName'),
    ...plan,
    description: normalizeOptionalText(payload.description, 500, 'description'),
    notes: normalizeOptionalText(payload.notes, 500, 'notes'),
    idempotencyKey: normalizeOptionalText(payload.idempotencyKey, 260, 'idempotencyKey')
  };
};

const validateRecordCreditPaymentPayload = (payload = {}) => {
  const amountMinor = requireOptionalMoney(payload, 'amount', { allowZero: false });
  const principalAmountMinor = requireOptionalMoney(payload, 'principalAmount');
  const interestAmountMinor = requireOptionalMoney(payload, 'interestAmount');
  const feeAmountMinor = requireOptionalMoney(payload, 'feeAmount');
  const remainingPrincipalAfterPaymentMinor = requireOptionalMoney(payload, 'remainingPrincipalAfterPayment');
  const installmentNumber = payload.installmentNumber === undefined || payload.installmentNumber === null || payload.installmentNumber === ''
    ? null
    : requirePositiveInteger(payload, 'installmentNumber', 'Ask which installment number was paid, or omit it to use the next unpaid installment.');

  return {
    workspaceId: normalizeWorkspaceId(payload),
    ...normalizeCreditSelector(payload),
    installmentNumber,
    date: validateNotFutureDate(validateDateString(payload.date, 'date'), 'date', {
      agentAction: 'Use the actual date when the user made the payment. Do not use the installment dueDate unless the user says they actually paid on that date.'
    }),
    amountMinor,
    amount: amountMinor === null ? null : fromMinorUnits(amountMinor),
    paymentAccountId: normalizeOptionalText(payload.paymentAccountId || payload.accountId, 120, 'paymentAccountId'),
    paymentAccountName: normalizeOptionalText(payload.paymentAccountName || payload.accountName, 160, 'paymentAccountName'),
    principalAmountMinor,
    principalAmount: principalAmountMinor === null ? null : fromMinorUnits(principalAmountMinor),
    interestAmountMinor,
    interestAmount: interestAmountMinor === null ? null : fromMinorUnits(interestAmountMinor),
    feeAmountMinor: feeAmountMinor || 0,
    feeAmount: fromMinorUnits(feeAmountMinor || 0),
    remainingPrincipalAfterPaymentMinor,
    remainingPrincipalAfterPayment: remainingPrincipalAfterPaymentMinor === null ? null : fromMinorUnits(remainingPrincipalAfterPaymentMinor),
    description: normalizeOptionalText(payload.description, 500, 'description'),
    notes: normalizeOptionalText(payload.notes, 500, 'notes'),
    idempotencyKey: normalizeOptionalText(payload.idempotencyKey, 260, 'idempotencyKey')
  };
};

const validateListCreditsPayload = (payload = {}) => {
  const status = normalizeOptionalText(payload.status, 40, 'status').toLowerCase();

  if (status && !CREDIT_STATUSES.has(status)) {
    throw createAgentError({
      code: 'invalid_field',
      message: `status must be one of: ${Array.from(CREDIT_STATUSES).join(', ')}.`,
      agentAction: 'Use active, paid, cancelled, or omit status to list active credits.',
      details: {
        field: 'status',
        allowedValues: Array.from(CREDIT_STATUSES)
      }
    });
  }

  return {
    workspaceId: normalizeWorkspaceId(payload),
    status: status || 'active',
    includeInstallments: Boolean(payload.includeInstallments)
  };
};

const validateUpdateCreditMetadataOnlyPayload = (payload = {}) => {
  const selector = {
    creditId: normalizeOptionalText(payload.creditId, 120, 'creditId'),
    creditName: normalizeOptionalText(payload.creditName, 160, 'creditName')
  };
  const name = hasOwnField(payload, 'name')
    ? normalizeOptionalText(payload.name, 160, 'name')
    : '';
  const provider = hasOwnField(payload, 'provider')
    ? normalizeOptionalText(payload.provider, 160, 'provider')
    : undefined;
  const description = hasOwnField(payload, 'description')
    ? normalizeOptionalText(payload.description, 500, 'description')
    : undefined;
  const notes = hasOwnField(payload, 'notes')
    ? normalizeOptionalText(payload.notes, 500, 'notes')
    : undefined;
  const active = hasOwnField(payload, 'active') ? Boolean(payload.active) : undefined;
  const hasUpdates = [name, provider, description, notes, active].some((value) => value !== undefined && value !== '');

  if (!selector.creditId && !selector.creditName) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'creditId or creditName is required.',
      agentAction: 'Call list_credits, ask the user which credit or financed purchase to update, then retry with creditId.',
      missingFields: ['creditId', 'creditName'],
      suggestedTool: 'list_credits'
    });
  }

  if (!hasUpdates) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'At least one editable credit field is required.',
      agentAction: 'Ask the user what descriptive credit information they want to change. Amounts, terms, payment schedules, and already recorded payments are not edited by this tool.',
      missingFields: ['name', 'provider', 'description', 'notes', 'active']
    });
  }

  return {
    workspaceId: normalizeWorkspaceId(payload),
    ...selector,
    name: name || undefined,
    normalizedName: name ? normalizeLookupName(name) : undefined,
    provider,
    description,
    notes,
    active
  };
};

const validateVoidCreditPayload = (payload = {}) => {
  const selector = normalizeCreditSelector(payload);

  if (!selector.creditId && !selector.creditName) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'creditId or creditName is required.',
      agentAction: 'Call list_credits, ask the user which credit or financed purchase to void, then retry with creditId.',
      missingFields: ['creditId', 'creditName'],
      suggestedTool: 'list_credits'
    });
  }

  return {
    workspaceId: normalizeWorkspaceId(payload),
    ...selector,
    date: validateDateString(payload.date, 'date'),
    reason: requireText(payload, 'reason', {
      maxLength: 500,
      agentAction: 'Ask the user why this credit or financed purchase should be voided. This reason is kept for audit history.'
    }),
    idempotencyKey: normalizeOptionalText(payload.idempotencyKey, 260, 'idempotencyKey')
  };
};

const validateVoidCreditPaymentPayload = (payload = {}) => {
  const paymentMovementId = normalizeOptionalText(
    payload.paymentMovementId || payload.movementId || payload.documentId,
    120,
    'paymentMovementId'
  );

  if (!paymentMovementId) {
    throw createAgentError({
      code: 'missing_fields',
      message: 'paymentMovementId is required.',
      agentAction: 'Call list_movements with type=credit_payment, show the candidate payments to the user, ask which payment to void, then retry with paymentMovementId.',
      missingFields: ['paymentMovementId'],
      suggestedTool: 'list_movements'
    });
  }

  return {
    workspaceId: normalizeWorkspaceId(payload),
    paymentMovementId,
    date: validateDateString(payload.date, 'date'),
    reason: requireText(payload, 'reason', {
      maxLength: 500,
      agentAction: 'Ask the user why this credit payment should be voided. This reason is kept for audit history.'
    }),
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
  const type = normalizeOptionalText(payload.type, 40, 'type').toLowerCase();

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
    categoryId: normalizeOptionalText(payload.categoryId, 120, 'categoryId'),
    categoryName: normalizeOptionalText(payload.categoryName || payload.category, 80, 'categoryName'),
    cursor: normalizeOptionalText(payload.cursor, 1000, 'cursor'),
    limit
  };
};

module.exports = {
  fromMinorUnits,
  normalizeCurrency,
  normalizeLookupName,
  toMinorUnits,
  validateCreateCreditPayload,
  validateCreateCreditPurchasePayload,
  validateListCategoriesPayload,
  validateListCreditsPayload,
  validateListFinancialGoalsPayload,
  validateListMovementsPayload,
  validateListWorkspaceMembersPayload,
  validateRecordCreditPaymentPayload,
  validateSetAccountBalancePayload,
  validateUpdateCreditMetadataOnlyPayload,
  validateUpsertAccountPayload,
  validateUpsertCategoryPayload,
  validateUpsertExpensePayload,
  validateUpsertFinancialGoalPayload,
  validateUpsertIncomePayload,
  validateUpsertPaymentMethodPayload,
  validateUpsertTransferPayload,
  validateUpsertWorkspaceMemberPayload,
  validateUpsertWorkspacePayload,
  validateVoidCreditPayload,
  validateVoidCreditPaymentPayload
};
