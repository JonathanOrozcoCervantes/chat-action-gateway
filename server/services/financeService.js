const financeRepository = require('../repositories/financeRepository');
const {
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
} = require('../validators/financeValidator');
const { createAgentError } = require('../utils/agentError');
const { hashValue, randomToken } = require('../utils/security');

const splitScopes = (scope = '') => String(scope)
  .split(/[\s,]+/)
  .filter(Boolean);

const normalizeGrantedScopes = (scopes) => Array.isArray(scopes)
  ? Array.from(new Set(scopes.map((scope) => String(scope || '').trim()).filter(Boolean)))
  : [];

const toAmount = (minor) => fromMinorUnits(minor);

const ensureScope = (authContext, requiredScope) => {
  if (!requiredScope) {
    return;
  }

  if (!splitScopes(authContext.scope).includes(requiredScope)) {
    throw createAgentError({
      statusCode: 403,
      code: 'insufficient_scope',
      message: `This access token does not include ${requiredScope}.`,
      agentAction: `Ask the user to reconnect the ChatGPT connector with the ${requiredScope} scope enabled before retrying this tool.`,
      details: {
        requiredScope,
        currentScope: authContext.scope || ''
      }
    });
  }
};

const normalizeIdempotencyKey = (value, prefix) => value || `${prefix}-${randomToken(18)}`;
const MOVEMENT_SCAN_LIMIT = 1000;
const MOVEMENT_RAW_PAGE_LIMIT = 200;

const addMonthsToDateString = (dateString, months) => {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, day));

  return date.toISOString().slice(0, 10);
};

const splitMinorAmount = (totalMinor, parts) => {
  const base = Math.trunc(totalMinor / parts);
  const remainder = totalMinor - (base * parts);

  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
};

const buildInstallments = ({
  termMonths,
  firstPaymentDate,
  totalRepaymentMinor,
  principalMinor,
  principalSplitKnown
}) => {
  const paymentParts = splitMinorAmount(totalRepaymentMinor, termMonths);
  const principalParts = principalSplitKnown ? splitMinorAmount(principalMinor, termMonths) : [];

  return paymentParts.map((paymentMinor, index) => {
    const principalDueMinor = principalSplitKnown ? principalParts[index] : null;
    const interestDueMinor = principalSplitKnown ? paymentMinor - principalDueMinor : null;
    const installmentNumber = index + 1;

    return {
      installmentId: String(installmentNumber).padStart(3, '0'),
      installmentNumber,
      dueDate: addMonthsToDateString(firstPaymentDate, index),
      status: 'pending',
      scheduledPaymentMinor: paymentMinor,
      scheduledPayment: toAmount(paymentMinor),
      principalDueMinor,
      principalDue: principalDueMinor === null ? null : toAmount(principalDueMinor),
      interestDueMinor,
      interestDue: interestDueMinor === null ? null : toAmount(interestDueMinor),
      paidAmountMinor: 0,
      paidAmount: 0,
      principalPaidMinor: 0,
      principalPaid: 0,
      interestPaidMinor: 0,
      interestPaid: 0,
      feePaidMinor: 0,
      feePaid: 0
    };
  });
};

const summarizeCreditForResponse = (credit) => ({
  creditId: credit.creditId || credit.id,
  type: credit.type,
  status: credit.status,
  name: credit.name,
  amount: credit.amount,
  amountMinor: credit.amountMinor,
  currency: credit.currency,
  termMonths: credit.termMonths,
  startDate: credit.startDate || credit.date,
  firstPaymentDate: credit.firstPaymentDate,
  interestType: credit.interestType,
  totalRepayment: credit.totalRepayment,
  totalRepaymentMinor: credit.totalRepaymentMinor,
  monthlyPayment: credit.monthlyPayment,
  monthlyPaymentMinor: credit.monthlyPaymentMinor,
  outstandingPrincipal: credit.outstandingPrincipal,
  outstandingPrincipalMinor: credit.outstandingPrincipalMinor,
  liabilityAccountId: credit.liabilityAccountId,
  liabilityAccountName: credit.liabilityAccountName,
  provider: credit.provider || '',
  merchant: credit.merchant || ''
});

const summarizeFinancialGoalForResponse = (goal) => {
  const targetAmountMinor = goal.targetAmountMinor ?? null;
  const currentAmountMinor = goal.currentAmountMinor ?? null;
  const progressPercent = targetAmountMinor && targetAmountMinor > 0 && currentAmountMinor !== null
    ? Number(Math.min(100, Math.max(0, (currentAmountMinor / targetAmountMinor) * 100)).toFixed(2))
    : null;

  return {
    goalId: goal.goalId || goal.id,
    name: goal.name,
    type: goal.type,
    status: goal.status,
    priority: goal.priority,
    currency: goal.currency,
    targetAmount: goal.targetAmount ?? null,
    targetAmountMinor,
    currentAmount: goal.currentAmount ?? null,
    currentAmountMinor,
    monthlyContribution: goal.monthlyContribution ?? null,
    monthlyContributionMinor: goal.monthlyContributionMinor ?? null,
    targetDate: goal.targetDate ?? null,
    targetAge: goal.targetAge ?? null,
    progressPercent,
    description: goal.description || '',
    motivation: goal.motivation || '',
    notes: goal.notes || '',
    tags: goal.tags || [],
    active: goal.active !== false,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  };
};

const encodeMovementCursor = (cursor) => Buffer
  .from(JSON.stringify(cursor))
  .toString('base64url');

const decodeMovementCursor = (cursor = '') => {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    if (!parsed?.date || !parsed?.movementId) {
      throw new Error('Missing cursor fields.');
    }

    return {
      date: String(parsed.date),
      movementId: String(parsed.movementId)
    };
  } catch (error) {
    throw createAgentError({
      code: 'invalid_cursor',
      message: 'The pagination cursor is invalid.',
      agentAction: 'Call list_movements again without cursor to restart from the first page, or use the exact nextCursor returned by the previous list_movements response.',
      missingFields: ['cursor']
    });
  }
};

const requireSameCurrency = ({ expectedCurrency, actualCurrency, field, account }) => {
  if (expectedCurrency !== actualCurrency) {
    throw createAgentError({
      code: 'currency_mismatch',
      message: `${field} uses ${actualCurrency}, but the movement currency is ${expectedCurrency}.`,
      agentAction: 'Ask the user to choose an account with the same currency or confirm a same-currency movement. Currency conversion is not supported yet.',
      details: {
        expectedCurrency,
        actualCurrency,
        account
      }
    });
  }
};

const createLine = ({
  account,
  paymentMethod = null,
  amountMinor,
  direction
}) => ({
  accountId: account.accountId,
  accountName: account.name,
  paymentMethodId: paymentMethod?.paymentMethodId || '',
  paymentMethodName: paymentMethod?.name || '',
  amountMinor,
  amount: toAmount(amountMinor),
  direction
});

const summarizeMovementForResponse = (movement) => ({
  type: movement.type,
  date: movement.date,
  amount: movement.amount,
  amountMinor: movement.amountMinor,
  currency: movement.currency,
  category: movement.category,
  categoryId: movement.categoryId || '',
  categoryName: movement.categoryName || movement.category || '',
  description: movement.description,
  merchant: movement.merchant || '',
  sourceName: movement.sourceName || '',
  accountId: movement.accountId || '',
  accountName: movement.accountName || '',
  fromAccountId: movement.fromAccountId || '',
  fromAccountName: movement.fromAccountName || '',
  toAccountId: movement.toAccountId || '',
  toAccountName: movement.toAccountName || '',
  creditId: movement.creditId || '',
  creditName: movement.creditName || '',
  installmentId: movement.installmentId || '',
  installmentNumber: movement.installmentNumber || null,
  principalAmount: movement.principalAmount ?? null,
  principalAmountMinor: movement.principalAmountMinor ?? null,
  interestAmount: movement.interestAmount ?? null,
  interestAmountMinor: movement.interestAmountMinor ?? null,
  feeAmount: movement.feeAmount ?? null,
  feeAmountMinor: movement.feeAmountMinor ?? null,
  lines: movement.lines || [],
  originalMovementId: movement.originalMovementId || '',
  originalMovementIds: movement.originalMovementIds || [],
  voided: movement.voided === true,
  voidReason: movement.voidReason || ''
});

class FinanceService {
  async ensurePersonalWorkspaceForUser({
    userId,
    displayName,
    currency = 'MXN'
  }) {
    if (!userId) {
      return null;
    }

    return financeRepository.ensurePersonalWorkspaceForUser({
      userId,
      displayName,
      currency
    });
  }

  async resolveWorkspace({ userId, workspaceId }) {
    let workspaces = await financeRepository.listUserWorkspaces(userId);

    if (!workspaces.length) {
      await financeRepository.ensurePersonalWorkspaceForUser({ userId });
      workspaces = await financeRepository.listUserWorkspaces(userId);
    }

    if (workspaceId) {
      const workspace = workspaces.find((item) => item.workspaceId === workspaceId);

      if (!workspace) {
        throw createAgentError({
          statusCode: 403,
          code: 'workspace_not_found',
          message: 'The provided workspaceId does not exist or the user does not have access to it.',
          agentAction: 'Call list_workspaces, show the available workspaces to the user, ask which one to use, then retry with the selected workspaceId.',
          suggestedTool: 'list_workspaces',
          details: {
            workspaceId,
            workspaces: workspaces.map(({ workspaceId: id, name, type }) => ({ workspaceId: id, name, type }))
          }
        });
      }

      return workspace;
    }

    if (workspaces.length === 1) {
      return workspaces[0];
    }

    throw createAgentError({
      code: 'workspace_required',
      message: 'workspaceId is required because the user has more than one workspace.',
      agentAction: 'Call list_workspaces, show the available workspaces to the user, ask which workspace to use, then retry this tool with workspaceId.',
      missingFields: ['workspaceId'],
      suggestedTool: 'list_workspaces',
      details: {
        workspaces: workspaces.map(({ workspaceId: id, name, type, isDefault }) => ({ workspaceId: id, name, type, isDefault }))
      }
    });
  }

  async hasWorkspaceScope({ userId, workspace, requiredScope }) {
    const workspaceId = workspace.workspaceId || workspace.id;
    const member = await financeRepository.getWorkspaceMember({
      workspaceId,
      userId
    });
    const isWorkspaceOwner = workspace.ownerUserId === userId || member?.role === 'owner';

    if (!member) {
      return {
        ok: isWorkspaceOwner,
        member
      };
    }

    if (member.status !== 'active') {
      return {
        ok: false,
        member
      };
    }

    if (isWorkspaceOwner && !Array.isArray(member.grantedScopes)) {
      return {
        ok: true,
        member
      };
    }

    const grantedScopes = normalizeGrantedScopes(member?.grantedScopes);

    return {
      ok: grantedScopes.includes(requiredScope),
      member
    };
  }

  async ensureWorkspaceScope({ userId, workspace, requiredScope, suggestedTool = '' }) {
    const result = await this.hasWorkspaceScope({
      userId,
      workspace,
      requiredScope
    });

    if (result.ok) {
      return result.member;
    }

    throw createAgentError({
      statusCode: 403,
      code: 'workspace_scope_denied',
      message: `The authenticated user does not have ${requiredScope} in workspace "${workspace.name}".`,
      agentAction: 'Tell the user they do not have permission for this action in the selected workspace. Ask a workspace owner to update their member scopes, then retry.',
      suggestedTool,
      details: {
        workspaceId: workspace.workspaceId || workspace.id,
        workspaceName: workspace.name,
        requiredScope,
        currentWorkspaceScopes: normalizeGrantedScopes(result.member?.grantedScopes),
        role: result.member?.role || ''
      }
    });
  }

  async resolveAccount({
    workspaceId,
    accountId = '',
    accountName = '',
    fieldPrefix = ''
  }) {
    const fieldLabel = fieldPrefix ? `${fieldPrefix}Account` : 'account';

    if (accountId) {
      const account = await financeRepository.getAccount({ workspaceId, accountId });

      if (!account || account.active === false) {
        throw createAgentError({
          code: 'account_not_found',
          message: `The provided ${fieldLabel}Id does not exist in this workspace.`,
          agentAction: 'Call list_accounts for this workspace and ask the user which account to use, or create the account with upsert_account before retrying.',
          suggestedTool: 'list_accounts',
          details: {
            accountId,
            workspaceId
          }
        });
      }

      return account;
    }

    if (!accountName) {
      throw createAgentError({
        code: 'account_required',
        message: `${fieldLabel}Id or ${fieldLabel}Name is required.`,
        agentAction: 'Call list_accounts for this workspace and ask the user which account to use. If the account does not exist, call upsert_account first.',
        missingFields: [`${fieldLabel}Id`],
        suggestedTool: 'list_accounts',
        details: {
          workspaceId
        }
      });
    }

    const matches = await financeRepository.findAccountsByNormalizedName({
      workspaceId,
      normalizedName: normalizeLookupName(accountName)
    });

    if (!matches.length) {
      throw createAgentError({
        code: 'account_not_found',
        message: `No account matches "${accountName}" in this workspace.`,
        agentAction: 'Call list_accounts to show existing accounts. If none matches, ask the user whether to create it and call upsert_account before retrying.',
        suggestedTool: 'list_accounts',
        details: {
          accountName,
          workspaceId
        }
      });
    }

    if (matches.length > 1) {
      throw createAgentError({
        code: 'ambiguous_account',
        message: `More than one account matches "${accountName}".`,
        agentAction: 'Show the matching accounts to the user and ask which one they mean. Retry with the selected accountId.',
        suggestedTool: 'list_accounts',
        details: {
          accountName,
          matches: matches.map(({ accountId: id, name, type, currency }) => ({ accountId: id, name, type, currency }))
        }
      });
    }

    return matches[0];
  }

  async resolvePaymentMethod({
    workspaceId,
    account,
    paymentMethodId = '',
    paymentMethodName = ''
  }) {
    if (!paymentMethodId && !paymentMethodName) {
      return null;
    }

    if (paymentMethodId) {
      const paymentMethod = await financeRepository.getPaymentMethod({
        workspaceId,
        accountId: account.accountId,
        paymentMethodId
      });

      if (!paymentMethod || paymentMethod.active === false) {
        throw createAgentError({
          code: 'payment_method_not_found',
          message: 'The provided paymentMethodId does not exist in the selected account.',
          agentAction: 'Call list_payment_methods with the accountId, then ask the user to choose one or create a new payment method with upsert_payment_method.',
          suggestedTool: 'list_payment_methods',
          details: {
            accountId: account.accountId,
            paymentMethodId
          }
        });
      }

      return paymentMethod;
    }

    const matches = await financeRepository.findPaymentMethodsByNormalizedName({
      workspaceId,
      accountId: account.accountId,
      normalizedName: normalizeLookupName(paymentMethodName)
    });

    if (!matches.length) {
      throw createAgentError({
        code: 'payment_method_not_found',
        message: `No payment method matches "${paymentMethodName}" in account "${account.name}".`,
        agentAction: 'Call list_payment_methods for this account. If none matches, ask the user whether to create it and call upsert_payment_method before retrying.',
        suggestedTool: 'list_payment_methods',
        details: {
          accountId: account.accountId,
          accountName: account.name,
          paymentMethodName
        }
      });
    }

    if (matches.length > 1) {
      throw createAgentError({
        code: 'ambiguous_payment_method',
        message: `More than one payment method matches "${paymentMethodName}" in account "${account.name}".`,
        agentAction: 'Show the matching payment methods to the user and ask which one they mean. Retry with paymentMethodId.',
        suggestedTool: 'list_payment_methods',
        details: {
          accountId: account.accountId,
          accountName: account.name,
          matches: matches.map(({ paymentMethodId: id, name, type, last4 }) => ({ paymentMethodId: id, name, type, last4 }))
        }
      });
    }

    return matches[0];
  }

  isCategoryCompatible(category, movementType) {
    return category.type === 'both' || category.type === movementType;
  }

  categoryAgentAction({ movementType, categoryName = '' }) {
    const createPhrase = categoryName ? `create category "${categoryName}"` : 'create a new category';

    return `Call list_categories filtered by type=${movementType}, show the available categories to the user, and ask whether to use one of them or ${createPhrase} with upsert_category. Only retry the movement after the user confirms the category.`;
  }

  async resolveCategory({
    workspaceId,
    categoryId = '',
    categoryName = '',
    movementType
  }) {
    if (categoryId) {
      const category = await financeRepository.getCategory({ workspaceId, categoryId });

      if (!category || category.active === false) {
        throw createAgentError({
          code: 'category_not_found',
          message: 'The provided categoryId does not exist in this workspace.',
          agentAction: this.categoryAgentAction({ movementType }),
          suggestedTool: 'list_categories',
          details: {
            workspaceId,
            categoryId,
            requiredType: movementType
          }
        });
      }

      if (!this.isCategoryCompatible(category, movementType)) {
        throw createAgentError({
          code: 'category_type_mismatch',
          message: `Category "${category.name}" is type ${category.type}, but this movement requires ${movementType}.`,
          agentAction: this.categoryAgentAction({ movementType, categoryName: category.name }),
          suggestedTool: 'list_categories',
          details: {
            workspaceId,
            category,
            requiredType: movementType
          }
        });
      }

      return category;
    }

    if (!categoryName) {
      throw createAgentError({
        code: 'category_required',
        message: 'categoryId or categoryName is required.',
        agentAction: this.categoryAgentAction({ movementType }),
        missingFields: ['categoryId', 'categoryName'],
        suggestedTool: 'list_categories',
        details: {
          workspaceId,
          requiredType: movementType
        }
      });
    }

    const matches = await financeRepository.findCategoriesByNormalizedName({
      workspaceId,
      normalizedName: normalizeLookupName(categoryName)
    });

    if (!matches.length) {
      throw createAgentError({
        code: 'category_not_found',
        message: `No category matches "${categoryName}" in this workspace.`,
        agentAction: this.categoryAgentAction({ movementType, categoryName }),
        suggestedTool: 'list_categories',
        details: {
          workspaceId,
          categoryName,
          requiredType: movementType,
          suggestedCreatePayload: {
            name: categoryName,
            type: movementType
          }
        }
      });
    }

    const compatibleMatches = matches.filter((category) => this.isCategoryCompatible(category, movementType));

    if (!compatibleMatches.length) {
      throw createAgentError({
        code: 'category_type_mismatch',
        message: `Category "${categoryName}" exists, but not for ${movementType} movements.`,
        agentAction: `Ask the user whether to update that category to type=both with upsert_category, or choose/create another ${movementType} category. Do not retry the movement until the user confirms.`,
        suggestedTool: 'list_categories',
        details: {
          workspaceId,
          categoryName,
          requiredType: movementType,
          matches
        }
      });
    }

    if (compatibleMatches.length > 1) {
      throw createAgentError({
        code: 'ambiguous_category',
        message: `More than one category matches "${categoryName}".`,
        agentAction: 'Show the matching categories to the user and ask which one they mean. Retry with categoryId.',
        suggestedTool: 'list_categories',
        details: {
          workspaceId,
          categoryName,
          requiredType: movementType,
          matches: compatibleMatches.map(({ categoryId: id, name, type }) => ({ categoryId: id, name, type }))
        }
      });
    }

    return compatibleMatches[0];
  }

  async resolveCredit({
    workspaceId,
    creditId = '',
    creditName = '',
    requireActive = true
  }) {
    if (creditId) {
      const credit = await financeRepository.getCredit({
        workspaceId,
        creditId,
        includeInstallments: true
      });

      if (!credit || (requireActive && credit.status !== 'active')) {
        throw createAgentError({
          code: 'credit_not_found',
          message: 'The provided creditId does not exist or is not active.',
          agentAction: 'Call list_credits, show the active credits to the user, ask which one they mean, then retry with creditId.',
          suggestedTool: 'list_credits',
          details: {
            workspaceId,
            creditId
          }
        });
      }

      return credit;
    }

    if (!creditName) {
      throw createAgentError({
        code: 'credit_required',
        message: 'creditId or creditName is required.',
        agentAction: 'Call list_credits and ask the user which credit or financed purchase this payment belongs to.',
        missingFields: ['creditId', 'creditName'],
        suggestedTool: 'list_credits'
      });
    }

    const matches = await financeRepository.findCreditsByNormalizedName({
      workspaceId,
      normalizedName: normalizeLookupName(creditName)
    });
    const activeMatches = requireActive ? matches.filter((credit) => credit.status === 'active') : matches;

    if (!activeMatches.length) {
      throw createAgentError({
        code: 'credit_not_found',
        message: `No active credit matches "${creditName}" in this workspace.`,
        agentAction: 'Call list_credits, show the active credits to the user, ask which one they mean, then retry with creditId.',
        suggestedTool: 'list_credits',
        details: {
          workspaceId,
          creditName
        }
      });
    }

    if (activeMatches.length > 1) {
      throw createAgentError({
        code: 'ambiguous_credit',
        message: `More than one active credit matches "${creditName}".`,
        agentAction: 'Show the matching credits to the user and ask which one they mean. Retry with creditId.',
        suggestedTool: 'list_credits',
        details: {
          creditName,
          matches: activeMatches.map(({ creditId: id, name, type, status, outstandingPrincipal }) => ({
            creditId: id,
            name,
            type,
            status,
            outstandingPrincipal
          }))
        }
      });
    }

    return financeRepository.getCredit({
      workspaceId,
      creditId: activeMatches[0].creditId,
      includeInstallments: true
    });
  }

  getNextInstallment(credit, requestedInstallmentNumber = null) {
    const installments = Array.isArray(credit.installments) ? credit.installments : [];

    if (requestedInstallmentNumber) {
      const installment = installments.find((item) => item.installmentNumber === requestedInstallmentNumber);

      if (!installment) {
        throw createAgentError({
          code: 'installment_not_found',
          message: `Installment ${requestedInstallmentNumber} does not exist for this credit.`,
          agentAction: 'Call list_credits with includeInstallments=true, show the installments to the user, and retry with a valid installmentNumber.',
          suggestedTool: 'list_credits',
          details: {
            creditId: credit.creditId,
            installmentNumber: requestedInstallmentNumber
          }
        });
      }

      return installment;
    }

    return installments.find((item) => item.status !== 'paid') || null;
  }

  async upsertWorkspace({ userId, authContext, payload }) {
    ensureScope(authContext, 'workspaces:write');
    const normalizedPayload = validateUpsertWorkspacePayload(payload);

    if (!normalizedPayload.workspaceId) {
      const result = await financeRepository.createWorkspace({
        userId,
        payload: normalizedPayload
      });
      const workspace = await financeRepository.getWorkspace(result.workspaceId);

      return {
        ok: true,
        action: 'upsert_workspace',
        workspaceId: result.workspaceId,
        created: true,
        workspace
      };
    }

    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'workspaces:write',
      suggestedTool: 'list_workspaces'
    });

    const result = await financeRepository.updateWorkspace({
      workspaceId: workspace.workspaceId,
      payload: normalizedPayload
    });
    const updatedWorkspace = await financeRepository.getWorkspace(result.workspaceId);

    return {
      ok: true,
      action: 'upsert_workspace',
      workspaceId: result.workspaceId,
      created: false,
      workspace: updatedWorkspace
    };
  }

  async listWorkspaces({ userId, authContext }) {
    ensureScope(authContext, 'workspaces:read');
    const workspaces = await financeRepository.listUserWorkspaces(userId);
    const visibleWorkspaces = [];

    for (const workspace of workspaces) {
      const permission = await this.hasWorkspaceScope({
        userId,
        workspace,
        requiredScope: 'workspaces:read'
      });

      if (permission.ok) {
        visibleWorkspaces.push(workspace);
      }
    }

    return {
      ok: true,
      action: 'list_workspaces',
      workspaces: visibleWorkspaces
    };
  }

  async upsertWorkspaceMember({ userId, authContext, payload }) {
    ensureScope(authContext, 'members:write');
    const normalizedPayload = validateUpsertWorkspaceMemberPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'members:write',
      suggestedTool: 'list_workspace_members'
    });

    const targetUser = normalizedPayload.memberUserId
      ? await financeRepository.getUserById(normalizedPayload.memberUserId)
      : await financeRepository.findUserByEmail(normalizedPayload.memberEmail);

    if (!targetUser) {
      throw createAgentError({
        statusCode: 404,
        code: 'member_user_not_found',
        message: 'The user to add was not found.',
          agentAction: 'Tell the user that the member must first connect this MCP with Google so their Firebase account exists. After that, retry upsert_workspace_member using memberEmail.',
        missingFields: ['memberEmail'],
        details: {
          memberUserId: normalizedPayload.memberUserId,
          memberEmail: normalizedPayload.memberEmail
        }
      });
    }

    if (targetUser.userId === userId) {
      throw createAgentError({
        code: 'cannot_add_self',
        message: 'The authenticated user is already the active user for this request.',
        agentAction: 'Use list_workspace_members to inspect current access. To change your own permissions, use the Firebase console or have another workspace owner update them.',
        suggestedTool: 'list_workspace_members'
      });
    }

    const result = await financeRepository.upsertWorkspaceMember({
      workspaceId: workspace.workspaceId,
      targetUser,
      role: normalizedPayload.role,
      grantedScopes: normalizedPayload.grantedScopes,
      notes: normalizedPayload.notes,
      addedByUserId: userId
    });
    const members = await financeRepository.listWorkspaceMembers({
      workspaceId: workspace.workspaceId,
      includeInactive: true
    });
    const member = members.find((item) => item.userId === result.memberUserId);

    return {
      ok: true,
      action: 'upsert_workspace_member',
      workspaceId: workspace.workspaceId,
      workspace: {
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        type: workspace.type
      },
      memberUserId: result.memberUserId,
      created: result.created,
      member
    };
  }

  async listWorkspaceMembers({ userId, authContext, payload = {} }) {
    ensureScope(authContext, 'members:read');
    const normalizedPayload = validateListWorkspaceMembersPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'members:read'
    });

    const members = await financeRepository.listWorkspaceMembers({
      workspaceId: workspace.workspaceId,
      includeInactive: normalizedPayload.includeInactive
    });

    return {
      ok: true,
      action: 'list_workspace_members',
      workspaceId: workspace.workspaceId,
      workspace: {
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        type: workspace.type
      },
      count: members.length,
      members
    };
  }

  async listFinancialGoals({ userId, authContext, payload = {} }) {
    ensureScope(authContext, 'goals:read');
    const normalizedPayload = validateListFinancialGoalsPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'goals:read'
    });

    const goals = await financeRepository.listFinancialGoals({
      workspaceId: workspace.workspaceId,
      type: normalizedPayload.type,
      status: normalizedPayload.status,
      includeInactive: normalizedPayload.includeInactive
    });

    return {
      ok: true,
      action: 'list_financial_goals',
      workspaceId: workspace.workspaceId,
      type: normalizedPayload.type,
      status: normalizedPayload.status,
      count: goals.length,
      goals: goals.map(summarizeFinancialGoalForResponse)
    };
  }

  async upsertFinancialGoal({ userId, authContext, payload }) {
    ensureScope(authContext, 'goals:write');
    const normalizedPayload = validateUpsertFinancialGoalPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'goals:write',
      suggestedTool: 'list_financial_goals'
    });

    if (normalizedPayload.goalId) {
      const existingGoal = await financeRepository.getFinancialGoal({
        workspaceId: workspace.workspaceId,
        goalId: normalizedPayload.goalId
      });

      if (!existingGoal) {
        throw createAgentError({
          code: 'financial_goal_not_found',
          message: 'The goalId provided for update does not exist.',
          agentAction: 'Call list_financial_goals and ask the user which existing financial goal to update. To create a new goal, omit goalId and provide name.',
          suggestedTool: 'list_financial_goals',
          details: {
            workspaceId: workspace.workspaceId,
            goalId: normalizedPayload.goalId
          }
        });
      }
    }

    if (!normalizedPayload.goalId && normalizedPayload.normalizedName) {
      const matches = await financeRepository.findFinancialGoalsByNormalizedName({
        workspaceId: workspace.workspaceId,
        normalizedName: normalizedPayload.normalizedName
      });

      if (matches.length > 1) {
        throw createAgentError({
          code: 'ambiguous_financial_goal',
          message: `More than one financial goal matches "${normalizedPayload.name}".`,
          agentAction: 'Call list_financial_goals, show the matching goals to the user, ask which one they want to update, then retry with goalId.',
          suggestedTool: 'list_financial_goals',
          details: {
            workspaceId: workspace.workspaceId,
            name: normalizedPayload.name,
            matches: matches.map(({ goalId, name, type, status, targetDate }) => ({
              goalId,
              name,
              type,
              status,
              targetDate: targetDate || null
            }))
          }
        });
      }
    }

    const result = await financeRepository.upsertFinancialGoal({
      workspaceId: workspace.workspaceId,
      userId,
      payload: normalizedPayload
    });
    const goal = await financeRepository.getFinancialGoal({
      workspaceId: workspace.workspaceId,
      goalId: result.goalId
    });

    return {
      ok: true,
      action: 'upsert_financial_goal',
      workspaceId: workspace.workspaceId,
      goalId: result.goalId,
      created: result.created,
      goal: summarizeFinancialGoalForResponse(goal)
    };
  }

  async upsertCategory({ userId, authContext, payload }) {
    ensureScope(authContext, 'categories:write');
    const normalizedPayload = validateUpsertCategoryPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'categories:write',
      suggestedTool: 'list_categories'
    });

    if (normalizedPayload.categoryId) {
      const existingCategory = await financeRepository.getCategory({
        workspaceId: workspace.workspaceId,
        categoryId: normalizedPayload.categoryId
      });

      if (!existingCategory) {
        throw createAgentError({
          code: 'category_not_found',
          message: 'The categoryId provided for update does not exist.',
          agentAction: 'Call list_categories and ask the user which existing category to update. To create a new category, omit categoryId and provide name and type.',
          suggestedTool: 'list_categories',
          details: {
            workspaceId: workspace.workspaceId,
            categoryId: normalizedPayload.categoryId
          }
        });
      }
    }

    const result = await financeRepository.upsertCategory({
      workspaceId: workspace.workspaceId,
      payload: normalizedPayload
    });
    const category = await financeRepository.getCategory({
      workspaceId: workspace.workspaceId,
      categoryId: result.categoryId
    });

    return {
      ok: true,
      action: 'upsert_category',
      workspaceId: workspace.workspaceId,
      categoryId: result.categoryId,
      category
    };
  }

  async listCategories({ userId, authContext, payload = {} }) {
    ensureScope(authContext, 'categories:read');
    const normalizedPayload = validateListCategoriesPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'categories:read'
    });

    const categories = await financeRepository.listCategories({
      workspaceId: workspace.workspaceId,
      type: normalizedPayload.type,
      includeInactive: normalizedPayload.includeInactive
    });

    return {
      ok: true,
      action: 'list_categories',
      workspaceId: workspace.workspaceId,
      type: normalizedPayload.type,
      count: categories.length,
      categories
    };
  }

  async upsertAccount({ userId, authContext, payload }) {
    ensureScope(authContext, 'accounts:write');
    const normalizedPayload = validateUpsertAccountPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'accounts:write',
      suggestedTool: 'list_accounts'
    });

    if (normalizedPayload.accountId) {
      const existingAccount = await financeRepository.getAccount({
        workspaceId: workspace.workspaceId,
        accountId: normalizedPayload.accountId
      });

      if (!existingAccount) {
        throw createAgentError({
          code: 'account_not_found',
          message: 'The accountId provided for update does not exist.',
          agentAction: 'Call list_accounts and ask the user which existing account to update. To create a new account, omit accountId and provide name, type, currency, and current balance.',
          suggestedTool: 'list_accounts',
          details: {
            workspaceId: workspace.workspaceId,
            accountId: normalizedPayload.accountId
          }
        });
      }
    }

    if (!normalizedPayload.accountId) {
      const existingAccounts = await financeRepository.findAccountsByNormalizedName({
        workspaceId: workspace.workspaceId,
        normalizedName: normalizedPayload.normalizedName
      });

      if (!existingAccounts.length && !normalizedPayload.balanceWasProvided) {
        throw createAgentError({
          code: 'initial_balance_required',
          message: 'A new account requires an explicit current balance.',
          agentAction: 'Ask the user for the current balance of this account before creating it. For cash, ask how much cash they have right now. For bank or wallet accounts, ask the current available balance. For credit cards, ask the current debt/balance and credit limit when known. If the user does not know, ask whether they want to start from 0 and explain future balances may be incomplete.',
          missingFields: ['balance'],
          details: {
            workspaceId: workspace.workspaceId,
            accountName: normalizedPayload.name,
            accountType: normalizedPayload.type,
            currency: normalizedPayload.currency
          }
        });
      }
    }

    const result = await financeRepository.upsertAccount({
      workspaceId: workspace.workspaceId,
      payload: normalizedPayload
    });
    const account = await financeRepository.getAccount({
      workspaceId: workspace.workspaceId,
      accountId: result.accountId
    });

    return {
      ok: true,
      action: 'upsert_account',
      workspaceId: workspace.workspaceId,
      accountId: result.accountId,
      account
    };
  }

  async listAccounts({ userId, authContext, payload = {} }) {
    ensureScope(authContext, 'accounts:read');
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: payload.workspaceId || ''
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'accounts:read'
    });
    const accounts = await financeRepository.listAccounts(workspace.workspaceId);

    return {
      ok: true,
      action: 'list_accounts',
      workspaceId: workspace.workspaceId,
      accounts
    };
  }

  async upsertPaymentMethod({ userId, authContext, payload }) {
    ensureScope(authContext, 'payment_methods:write');
    const normalizedPayload = validateUpsertPaymentMethodPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'payment_methods:write',
      suggestedTool: 'list_payment_methods'
    });
    const account = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.accountId,
      accountName: normalizedPayload.accountName
    });
    const result = await financeRepository.upsertPaymentMethod({
      workspaceId: workspace.workspaceId,
      accountId: account.accountId,
      payload: normalizedPayload
    });
    const paymentMethod = await financeRepository.getPaymentMethod({
      workspaceId: workspace.workspaceId,
      accountId: account.accountId,
      paymentMethodId: result.paymentMethodId
    });

    return {
      ok: true,
      action: 'upsert_payment_method',
      workspaceId: workspace.workspaceId,
      accountId: account.accountId,
      paymentMethodId: result.paymentMethodId,
      paymentMethod
    };
  }

  async listPaymentMethods({ userId, authContext, payload = {} }) {
    ensureScope(authContext, 'payment_methods:read');
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: payload.workspaceId || ''
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'payment_methods:read'
    });
    const account = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: payload.accountId || '',
      accountName: payload.accountName || ''
    });
    const paymentMethods = await financeRepository.listPaymentMethods({
      workspaceId: workspace.workspaceId,
      accountId: account.accountId
    });

    return {
      ok: true,
      action: 'list_payment_methods',
      workspaceId: workspace.workspaceId,
      accountId: account.accountId,
      paymentMethods
    };
  }

  async listCredits({ userId, authContext, payload = {} }) {
    ensureScope(authContext, 'credits:read');
    const normalizedPayload = validateListCreditsPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'credits:read'
    });

    const credits = await financeRepository.listCredits({
      workspaceId: workspace.workspaceId,
      status: normalizedPayload.status,
      includeInstallments: normalizedPayload.includeInstallments
    });

    return {
      ok: true,
      action: 'list_credits',
      workspaceId: workspace.workspaceId,
      status: normalizedPayload.status,
      count: credits.length,
      credits: credits.map((credit) => ({
        ...summarizeCreditForResponse(credit),
        nextInstallment: Array.isArray(credit.installments)
          ? credit.installments.find((item) => item.status !== 'paid') || null
          : undefined,
        installments: normalizedPayload.includeInstallments ? credit.installments || [] : undefined
      }))
    };
  }

  async updateCreditMetadataOnly({ userId, authContext, payload }) {
    ensureScope(authContext, 'credits:write');
    const normalizedPayload = validateUpdateCreditMetadataOnlyPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'credits:write',
      suggestedTool: 'list_credits'
    });

    const credit = await this.resolveCredit({
      workspaceId: workspace.workspaceId,
      creditId: normalizedPayload.creditId,
      creditName: normalizedPayload.creditName,
      requireActive: false
    });

    const result = await financeRepository.updateCreditMetadataOnly({
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      payload: normalizedPayload
    });
    const updatedCredit = await financeRepository.getCredit({
      workspaceId: workspace.workspaceId,
      creditId: result.creditId,
      includeInstallments: true
    });

    await financeRepository.createActionLog({
      action: 'update_credit_metadata_only',
      workspaceId: workspace.workspaceId,
      userId,
      status: 'success',
      creditId: credit.creditId,
      request: {
        creditId: credit.creditId,
        updates: normalizedPayload
      }
    });

    return {
      ok: true,
      action: 'update_credit_metadata_only',
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      credit: {
        ...summarizeCreditForResponse(updatedCredit),
        installments: updatedCredit.installments || []
      }
    };
  }

  async createCredit({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'credits:write');
    const normalizedPayload = validateCreateCreditPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'credits:write',
      suggestedTool: 'list_credits'
    });

    const disbursementAccount = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.accountId,
      accountName: normalizedPayload.accountName
    });

    requireSameCurrency({
      expectedCurrency: normalizedPayload.currency,
      actualCurrency: disbursementAccount.currency,
      field: `disbursementAccount "${disbursementAccount.name}"`,
      account: disbursementAccount
    });

    const creditId = `credit_${randomToken(12)}`;
    const liabilityAccountId = `credit_liability_${randomToken(12)}`;
    const liabilityAccountName = `${normalizedPayload.name} - deuda`;
    const installments = buildInstallments({
      termMonths: normalizedPayload.termMonths,
      firstPaymentDate: normalizedPayload.firstPaymentDate,
      totalRepaymentMinor: normalizedPayload.totalRepaymentMinor,
      principalMinor: normalizedPayload.amountMinor,
      principalSplitKnown: normalizedPayload.principalSplitKnown
    });
    const liabilityAccount = {
      accountId: liabilityAccountId,
      name: liabilityAccountName,
      normalizedName: normalizeLookupName(liabilityAccountName),
      type: 'loan',
      currency: normalizedPayload.currency,
      balanceMinor: -normalizedPayload.amountMinor,
      balance: toAmount(-normalizedPayload.amountMinor),
      institution: normalizedPayload.provider,
      description: `Internal liability account for credit ${normalizedPayload.name}.`,
      active: true,
      internal: true
    };
    const credit = {
      creditId,
      workspaceId: workspace.workspaceId,
      type: 'cash_credit',
      status: 'active',
      name: normalizedPayload.name,
      normalizedName: normalizedPayload.normalizedName,
      provider: normalizedPayload.provider,
      amountMinor: normalizedPayload.amountMinor,
      amount: normalizedPayload.amount,
      currency: normalizedPayload.currency,
      termMonths: normalizedPayload.termMonths,
      startDate: normalizedPayload.startDate,
      firstPaymentDate: normalizedPayload.firstPaymentDate,
      interestType: normalizedPayload.interestType,
      totalRepaymentMinor: normalizedPayload.totalRepaymentMinor,
      totalRepayment: normalizedPayload.totalRepayment,
      monthlyPaymentMinor: normalizedPayload.monthlyPaymentMinor,
      monthlyPayment: normalizedPayload.monthlyPayment,
      interestAmountMinor: normalizedPayload.interestAmountMinor,
      interestAmount: normalizedPayload.interestAmount,
      principalSplitKnown: normalizedPayload.principalSplitKnown,
      outstandingPrincipalMinor: normalizedPayload.amountMinor,
      outstandingPrincipal: normalizedPayload.amount,
      paidPrincipalMinor: 0,
      paidPrincipal: 0,
      paidInterestMinor: 0,
      paidInterest: 0,
      paidFeesMinor: 0,
      paidFees: 0,
      paidTotalMinor: 0,
      paidTotal: 0,
      liabilityAccountId,
      liabilityAccountName,
      disbursementAccountId: disbursementAccount.accountId,
      disbursementAccountName: disbursementAccount.name,
      description: normalizedPayload.description,
      notes: normalizedPayload.notes,
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };
    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'credit');
    const movement = {
      type: 'credit_disbursement',
      workspaceId: workspace.workspaceId,
      creditId,
      amountMinor: normalizedPayload.amountMinor,
      amount: normalizedPayload.amount,
      currency: normalizedPayload.currency,
      date: normalizedPayload.startDate,
      category: 'credit_disbursement',
      description: normalizedPayload.description || `Credit disbursement from ${normalizedPayload.provider}`,
      notes: normalizedPayload.notes,
      fromAccountId: liabilityAccountId,
      fromAccountName: liabilityAccountName,
      toAccountId: disbursementAccount.accountId,
      toAccountName: disbursementAccount.name,
      lines: [
        {
          accountId: liabilityAccountId,
          accountName: liabilityAccountName,
          amountMinor: -normalizedPayload.amountMinor,
          amount: toAmount(-normalizedPayload.amountMinor),
          direction: 'debt_increase'
        },
        createLine({
          account: disbursementAccount,
          amountMinor: normalizedPayload.amountMinor,
          direction: 'inflow'
        })
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };
    const idempotencyScopeDate = movement.date || '';
    const idempotencyHash = hashValue(`create_credit:${idempotencyScopeDate}:${idempotencyKey}`);
    const result = await financeRepository.createCreditWithIdempotency({
      workspaceId: workspace.workspaceId,
      userId,
      credit,
      installments,
      movement,
      accountsToCreate: [liabilityAccount],
      accountDeltas: [
        {
          accountId: disbursementAccount.accountId,
          deltaMinor: normalizedPayload.amountMinor
        }
      ],
      idempotencyKey,
      idempotencyHash,
      idempotencyScopeDate,
      action: 'create_credit'
    });

    await financeRepository.createActionLog({
      action: 'create_credit',
      workspaceId: workspace.workspaceId,
      userId,
      status: 'success',
      documentId: result.movementId,
      creditId,
      idempotencyHash,
      idempotencyScopeDate,
      request: {
        credit: summarizeCreditForResponse(credit),
        idempotencyKey
      }
    });

    const createdCredit = await financeRepository.getCredit({
      workspaceId: workspace.workspaceId,
      creditId,
      includeInstallments: true
    });

    return {
      ok: true,
      action: 'create_credit',
      workspaceId: workspace.workspaceId,
      creditId,
      movementId: result.movementId,
      documentId: result.movementId,
      idempotencyKey,
      credit: summarizeCreditForResponse(createdCredit),
      installments: createdCredit.installments,
      affectedAccounts: await Promise.all([
        financeRepository.getAccount({ workspaceId: workspace.workspaceId, accountId: liabilityAccountId }),
        financeRepository.getAccount({ workspaceId: workspace.workspaceId, accountId: disbursementAccount.accountId })
      ])
    };
  }

  async createCreditPurchase({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'credits:write');
    const normalizedPayload = validateCreateCreditPurchasePayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'credits:write',
      suggestedTool: 'list_credits'
    });

    const category = await this.resolveCategory({
      workspaceId: workspace.workspaceId,
      categoryId: normalizedPayload.categoryId,
      categoryName: normalizedPayload.categoryName,
      movementType: 'expense'
    });
    let liabilityAccount = null;
    let accountToCreate = null;

    if (normalizedPayload.creditAccountId || normalizedPayload.creditAccountName) {
      liabilityAccount = await this.resolveAccount({
        workspaceId: workspace.workspaceId,
        accountId: normalizedPayload.creditAccountId,
        accountName: normalizedPayload.creditAccountName
      });

      if (liabilityAccount.type !== 'credit_card') {
        throw createAgentError({
          code: 'invalid_credit_purchase_account',
          message: 'creditAccount must be a credit_card account for card MSI/installment purchases.',
          agentAction: 'Ask the user which credit card was used, or omit creditAccount and provide provider when this is store financing not tied to a registered credit card.',
          suggestedTool: 'list_accounts',
          details: {
            account: liabilityAccount
          }
        });
      }

      requireSameCurrency({
        expectedCurrency: normalizedPayload.currency,
        actualCurrency: liabilityAccount.currency,
        field: `creditAccount "${liabilityAccount.name}"`,
        account: liabilityAccount
      });
    } else {
      if (!normalizedPayload.provider) {
        throw createAgentError({
          code: 'credit_provider_required',
          message: 'provider is required when the financed purchase is not linked to an existing credit_card account.',
          agentAction: 'Ask the user who financed the purchase, or ask which registered credit card was used. Do not create a financing account silently without knowing the provider.',
          missingFields: ['provider', 'creditAccountId', 'creditAccountName'],
          suggestedTool: 'list_accounts'
        });
      }

      const liabilityAccountId = `credit_liability_${randomToken(12)}`;
      const liabilityAccountName = `${normalizedPayload.name} - deuda`;
      accountToCreate = {
        accountId: liabilityAccountId,
        name: liabilityAccountName,
        normalizedName: normalizeLookupName(liabilityAccountName),
        type: 'loan',
        currency: normalizedPayload.currency,
        balanceMinor: -normalizedPayload.amountMinor,
        balance: toAmount(-normalizedPayload.amountMinor),
        institution: normalizedPayload.provider,
        description: `Internal liability account for financed purchase ${normalizedPayload.name}.`,
        active: true,
        internal: true
      };
      liabilityAccount = {
        ...accountToCreate,
        accountId: liabilityAccountId
      };
    }

    const creditId = `credit_${randomToken(12)}`;
    const installments = buildInstallments({
      termMonths: normalizedPayload.termMonths,
      firstPaymentDate: normalizedPayload.firstPaymentDate,
      totalRepaymentMinor: normalizedPayload.totalRepaymentMinor,
      principalMinor: normalizedPayload.amountMinor,
      principalSplitKnown: normalizedPayload.principalSplitKnown
    });
    const credit = {
      creditId,
      workspaceId: workspace.workspaceId,
      type: 'installment_purchase',
      status: 'active',
      name: normalizedPayload.name,
      normalizedName: normalizedPayload.normalizedName,
      merchant: normalizedPayload.merchant,
      provider: normalizedPayload.provider || liabilityAccount.institution || '',
      amountMinor: normalizedPayload.amountMinor,
      amount: normalizedPayload.amount,
      currency: normalizedPayload.currency,
      termMonths: normalizedPayload.termMonths,
      startDate: normalizedPayload.date,
      firstPaymentDate: normalizedPayload.firstPaymentDate,
      interestType: normalizedPayload.interestType,
      totalRepaymentMinor: normalizedPayload.totalRepaymentMinor,
      totalRepayment: normalizedPayload.totalRepayment,
      monthlyPaymentMinor: normalizedPayload.monthlyPaymentMinor,
      monthlyPayment: normalizedPayload.monthlyPayment,
      interestAmountMinor: normalizedPayload.interestAmountMinor,
      interestAmount: normalizedPayload.interestAmount,
      principalSplitKnown: normalizedPayload.principalSplitKnown,
      outstandingPrincipalMinor: normalizedPayload.amountMinor,
      outstandingPrincipal: normalizedPayload.amount,
      paidPrincipalMinor: 0,
      paidPrincipal: 0,
      paidInterestMinor: 0,
      paidInterest: 0,
      paidFeesMinor: 0,
      paidFees: 0,
      paidTotalMinor: 0,
      paidTotal: 0,
      liabilityAccountId: liabilityAccount.accountId,
      liabilityAccountName: liabilityAccount.name,
      categoryId: category.categoryId,
      categoryName: category.name,
      categoryType: category.type,
      description: normalizedPayload.description,
      notes: normalizedPayload.notes,
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };
    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'credit-purchase');
    const movement = {
      type: 'credit_purchase',
      workspaceId: workspace.workspaceId,
      creditId,
      amountMinor: normalizedPayload.amountMinor,
      amount: normalizedPayload.amount,
      currency: normalizedPayload.currency,
      date: normalizedPayload.date,
      category: category.name,
      categoryId: category.categoryId,
      categoryName: category.name,
      categoryType: category.type,
      merchant: normalizedPayload.merchant,
      description: normalizedPayload.description || normalizedPayload.name,
      notes: normalizedPayload.notes,
      accountId: liabilityAccount.accountId,
      accountName: liabilityAccount.name,
      lines: [
        {
          accountId: liabilityAccount.accountId,
          accountName: liabilityAccount.name,
          amountMinor: -normalizedPayload.amountMinor,
          amount: toAmount(-normalizedPayload.amountMinor),
          direction: 'debt_increase'
        }
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };
    const accountDeltas = accountToCreate ? [] : [
      {
        accountId: liabilityAccount.accountId,
        deltaMinor: -normalizedPayload.amountMinor
      }
    ];
    const idempotencyScopeDate = movement.date || '';
    const idempotencyHash = hashValue(`create_credit_purchase:${idempotencyScopeDate}:${idempotencyKey}`);
    const result = await financeRepository.createCreditWithIdempotency({
      workspaceId: workspace.workspaceId,
      userId,
      credit,
      installments,
      movement,
      accountsToCreate: accountToCreate ? [accountToCreate] : [],
      accountDeltas,
      idempotencyKey,
      idempotencyHash,
      idempotencyScopeDate,
      action: 'create_credit_purchase'
    });

    await financeRepository.createActionLog({
      action: 'create_credit_purchase',
      workspaceId: workspace.workspaceId,
      userId,
      status: 'success',
      documentId: result.movementId,
      creditId,
      idempotencyHash,
      idempotencyScopeDate,
      request: {
        credit: summarizeCreditForResponse(credit),
        idempotencyKey
      }
    });

    const createdCredit = await financeRepository.getCredit({
      workspaceId: workspace.workspaceId,
      creditId,
      includeInstallments: true
    });

    return {
      ok: true,
      action: 'create_credit_purchase',
      workspaceId: workspace.workspaceId,
      creditId,
      movementId: result.movementId,
      documentId: result.movementId,
      idempotencyKey,
      credit: summarizeCreditForResponse(createdCredit),
      installments: createdCredit.installments,
      affectedAccounts: [
        await financeRepository.getAccount({ workspaceId: workspace.workspaceId, accountId: liabilityAccount.accountId })
      ].filter(Boolean)
    };
  }

  async recordCreditPayment({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'credits:write');
    const normalizedPayload = validateRecordCreditPaymentPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'credits:write',
      suggestedTool: 'list_credits'
    });

    const credit = await this.resolveCredit({
      workspaceId: workspace.workspaceId,
      creditId: normalizedPayload.creditId,
      creditName: normalizedPayload.creditName
    });
    const installment = this.getNextInstallment(credit, normalizedPayload.installmentNumber);
    const paymentAccount = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.paymentAccountId,
      accountName: normalizedPayload.paymentAccountName
    });
    const liabilityAccount = await financeRepository.getAccount({
      workspaceId: workspace.workspaceId,
      accountId: credit.liabilityAccountId
    });

    if (!liabilityAccount) {
      throw createAgentError({
        code: 'credit_liability_account_not_found',
        message: 'The liability account linked to this credit no longer exists.',
        agentAction: 'Tell the user this credit needs manual review because its linked debt account is missing.',
        details: {
          creditId: credit.creditId,
          liabilityAccountId: credit.liabilityAccountId
        }
      });
    }

    requireSameCurrency({
      expectedCurrency: credit.currency,
      actualCurrency: paymentAccount.currency,
      field: `paymentAccount "${paymentAccount.name}"`,
      account: paymentAccount
    });
    requireSameCurrency({
      expectedCurrency: credit.currency,
      actualCurrency: liabilityAccount.currency,
      field: `credit "${credit.name}" liability account`,
      account: liabilityAccount
    });

    const scheduledAmountMinor = installment?.scheduledPaymentMinor ?? null;
    const paymentAmountMinor = normalizedPayload.amountMinor ?? scheduledAmountMinor;
    const feeAmountMinor = normalizedPayload.feeAmountMinor || 0;
    const hasExplicitExtraCharges = Number(normalizedPayload.interestAmountMinor || 0) > 0 || feeAmountMinor > 0;

    if (!paymentAmountMinor) {
      throw createAgentError({
        code: 'credit_payment_amount_required',
        message: 'amount is required because this credit does not have a scheduled payment amount available.',
        agentAction: 'Ask the user how much they paid for this credit installment.',
        missingFields: ['amount']
      });
    }

    if (normalizedPayload.amountMinor === null && hasExplicitExtraCharges) {
      throw createAgentError({
        code: 'credit_payment_total_required_with_charges',
        message: 'amount is required when a credit payment includes interest or fees.',
        agentAction: 'Ask the user for the exact total amount paid, including principal, interest, and fees. Do not assume whether fees were included in the scheduled payment.',
        missingFields: ['amount'],
        details: {
          scheduledAmount: scheduledAmountMinor === null ? null : toAmount(scheduledAmountMinor),
          interestAmount: normalizedPayload.interestAmount,
          feeAmount: normalizedPayload.feeAmount
        }
      });
    }

    let interestAmountMinor = normalizedPayload.interestAmountMinor;
    let principalAmountMinor = normalizedPayload.principalAmountMinor;

    if (credit.interestType === 'no_interest' || credit.interestType === 'msi') {
      interestAmountMinor = interestAmountMinor ?? 0;
      principalAmountMinor = principalAmountMinor ?? (paymentAmountMinor - interestAmountMinor - feeAmountMinor);
    } else if (principalAmountMinor === null && interestAmountMinor !== null) {
      principalAmountMinor = paymentAmountMinor - interestAmountMinor - feeAmountMinor;
    } else if (interestAmountMinor === null && principalAmountMinor !== null) {
      interestAmountMinor = paymentAmountMinor - principalAmountMinor - feeAmountMinor;
    } else if (normalizedPayload.remainingPrincipalAfterPaymentMinor !== null) {
      principalAmountMinor = Number(credit.outstandingPrincipalMinor || 0) - normalizedPayload.remainingPrincipalAfterPaymentMinor;
      interestAmountMinor = paymentAmountMinor - principalAmountMinor - feeAmountMinor;
    } else if (installment?.principalDueMinor !== null && installment?.principalDueMinor !== undefined) {
      principalAmountMinor = installment.principalDueMinor;
      interestAmountMinor = paymentAmountMinor - principalAmountMinor - feeAmountMinor;
    } else {
      throw createAgentError({
        code: 'credit_payment_split_required',
        message: 'This credit has interest, so principal/interest split is required before recording payment.',
        agentAction: 'Ask the user how much of the payment was interest/fees, how much reduced principal, or what the remaining principal balance is after the payment. Do not guess the split.',
        missingFields: ['interestAmount', 'principalAmount', 'remainingPrincipalAfterPayment'],
        details: {
          creditId: credit.creditId,
          creditName: credit.name,
          paymentAmount: toAmount(paymentAmountMinor),
          outstandingPrincipal: credit.outstandingPrincipal
        }
      });
    }

    if (principalAmountMinor <= 0 || interestAmountMinor < 0 || feeAmountMinor < 0) {
      throw createAgentError({
        code: 'invalid_credit_payment_split',
        message: 'Credit payment split is invalid.',
        agentAction: 'Ask the user to confirm total paid, interest, fees, and principal reduction. Principal must be positive and interest/fees cannot be negative.',
        missingFields: ['amount', 'principalAmount', 'interestAmount', 'feeAmount']
      });
    }

    if (principalAmountMinor + interestAmountMinor + feeAmountMinor !== paymentAmountMinor) {
      throw createAgentError({
        code: 'credit_payment_split_mismatch',
        message: 'principalAmount + interestAmount + feeAmount must equal amount.',
        agentAction: 'Ask the user to confirm the exact payment breakdown. Do not alter any amount to make it fit.',
        missingFields: ['amount', 'principalAmount', 'interestAmount', 'feeAmount'],
        details: {
          amount: toAmount(paymentAmountMinor),
          principalAmount: toAmount(principalAmountMinor),
          interestAmount: toAmount(interestAmountMinor),
          feeAmount: toAmount(feeAmountMinor)
        }
      });
    }

    const currentOutstandingMinor = Number(credit.outstandingPrincipalMinor || 0);

    if (principalAmountMinor > currentOutstandingMinor) {
      throw createAgentError({
        code: 'credit_payment_exceeds_outstanding',
        message: 'principalAmount cannot exceed the current outstanding principal.',
        agentAction: 'Ask the user to confirm the payment or current remaining balance before retrying.',
        details: {
          outstandingPrincipal: toAmount(currentOutstandingMinor),
          principalAmount: toAmount(principalAmountMinor)
        }
      });
    }

    const nextOutstandingMinor = currentOutstandingMinor - principalAmountMinor;
    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'credit-payment');
    const movement = {
      type: 'credit_payment',
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      creditName: credit.name,
      installmentId: installment?.installmentId || '',
      installmentNumber: installment?.installmentNumber || null,
      amountMinor: paymentAmountMinor,
      amount: toAmount(paymentAmountMinor),
      principalAmountMinor,
      principalAmount: toAmount(principalAmountMinor),
      interestAmountMinor,
      interestAmount: toAmount(interestAmountMinor),
      feeAmountMinor,
      feeAmount: toAmount(feeAmountMinor),
      currency: credit.currency,
      date: normalizedPayload.date,
      category: 'credit_payment',
      description: normalizedPayload.description || `Payment for ${credit.name}`,
      notes: normalizedPayload.notes,
      fromAccountId: paymentAccount.accountId,
      fromAccountName: paymentAccount.name,
      toAccountId: liabilityAccount.accountId,
      toAccountName: liabilityAccount.name,
      lines: [
        createLine({
          account: paymentAccount,
          amountMinor: -paymentAmountMinor,
          direction: 'outflow'
        }),
        {
          accountId: liabilityAccount.accountId,
          accountName: liabilityAccount.name,
          amountMinor: principalAmountMinor,
          amount: toAmount(principalAmountMinor),
          direction: 'debt_reduction'
        }
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };
    const creditUpdates = {
      outstandingPrincipalMinor: nextOutstandingMinor,
      outstandingPrincipal: toAmount(nextOutstandingMinor),
      paidPrincipalMinor: Number(credit.paidPrincipalMinor || 0) + principalAmountMinor,
      paidPrincipal: toAmount(Number(credit.paidPrincipalMinor || 0) + principalAmountMinor),
      paidInterestMinor: Number(credit.paidInterestMinor || 0) + interestAmountMinor,
      paidInterest: toAmount(Number(credit.paidInterestMinor || 0) + interestAmountMinor),
      paidFeesMinor: Number(credit.paidFeesMinor || 0) + feeAmountMinor,
      paidFees: toAmount(Number(credit.paidFeesMinor || 0) + feeAmountMinor),
      paidTotalMinor: Number(credit.paidTotalMinor || 0) + paymentAmountMinor,
      paidTotal: toAmount(Number(credit.paidTotalMinor || 0) + paymentAmountMinor),
      status: nextOutstandingMinor === 0 ? 'paid' : 'active',
      ...(nextOutstandingMinor === 0 ? { paidDate: normalizedPayload.date } : {})
    };
    const previousInstallmentPaidMinor = Number(installment?.paidAmountMinor || 0);
    const installmentUpdates = installment ? {
      status: previousInstallmentPaidMinor + paymentAmountMinor >= Number(installment.scheduledPaymentMinor || 0) ? 'paid' : 'partial',
      paidDate: normalizedPayload.date,
      paidAmountMinor: previousInstallmentPaidMinor + paymentAmountMinor,
      paidAmount: toAmount(previousInstallmentPaidMinor + paymentAmountMinor),
      principalPaidMinor: Number(installment.principalPaidMinor || 0) + principalAmountMinor,
      principalPaid: toAmount(Number(installment.principalPaidMinor || 0) + principalAmountMinor),
      interestPaidMinor: Number(installment.interestPaidMinor || 0) + interestAmountMinor,
      interestPaid: toAmount(Number(installment.interestPaidMinor || 0) + interestAmountMinor),
      feePaidMinor: Number(installment.feePaidMinor || 0) + feeAmountMinor,
      feePaid: toAmount(Number(installment.feePaidMinor || 0) + feeAmountMinor)
    } : {};
    const idempotencyScopeDate = movement.date || '';
    const idempotencyHash = hashValue(`record_credit_payment:${idempotencyScopeDate}:${idempotencyKey}`);
    const result = await financeRepository.recordCreditPaymentWithIdempotency({
      workspaceId: workspace.workspaceId,
      userId,
      creditId: credit.creditId,
      installmentId: installment?.installmentId || '',
      creditUpdates,
      installmentUpdates,
      movement,
      accountDeltas: [
        {
          accountId: paymentAccount.accountId,
          deltaMinor: -paymentAmountMinor
        },
        {
          accountId: liabilityAccount.accountId,
          deltaMinor: principalAmountMinor
        }
      ],
      idempotencyKey,
      idempotencyHash,
      idempotencyScopeDate,
      action: 'record_credit_payment'
    });

    await financeRepository.createActionLog({
      action: 'record_credit_payment',
      workspaceId: workspace.workspaceId,
      userId,
      status: 'success',
      documentId: result.movementId,
      creditId: credit.creditId,
      idempotencyHash,
      idempotencyScopeDate,
      request: {
        movement: summarizeMovementForResponse(movement),
        idempotencyKey
      }
    });

    const updatedCredit = await financeRepository.getCredit({
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      includeInstallments: true
    });

    return {
      ok: true,
      action: 'record_credit_payment',
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      movementId: result.movementId,
      documentId: result.movementId,
      idempotencyKey,
      credit: summarizeCreditForResponse(updatedCredit),
      paidInstallment: installment ? updatedCredit.installments.find((item) => item.installmentId === installment.installmentId) : null,
      movement: summarizeMovementForResponse(movement),
      affectedAccounts: await Promise.all([
        financeRepository.getAccount({ workspaceId: workspace.workspaceId, accountId: paymentAccount.accountId }),
        financeRepository.getAccount({ workspaceId: workspace.workspaceId, accountId: liabilityAccount.accountId })
      ])
    };
  }

  async ensureCreditCanBeVoided({ workspaceId, credit }) {
    const paymentMovements = await financeRepository.listCreditMovementsByType({
      workspaceId,
      creditId: credit.creditId,
      type: 'credit_payment',
      limit: 100
    });
    const activePayments = paymentMovements.filter((movement) => movement.voided !== true);

    if (activePayments.length) {
      throw createAgentError({
        code: 'credit_has_active_payments',
        message: 'This credit or financed purchase has active payments and cannot be voided directly.',
        agentAction: 'Void the related payments first with void_credit_payment, then retry this void tool. Show the active payment movement IDs to the user and ask which payments should be voided.',
        suggestedTool: 'void_credit_payment',
        details: {
          creditId: credit.creditId,
          activePayments: activePayments.map((movement) => ({
            movementId: movement.movementId,
            date: movement.date,
            amount: movement.amount,
            principalAmount: movement.principalAmount,
            installmentNumber: movement.installmentNumber || null,
            description: movement.description || ''
          }))
        }
      });
    }

    if (Number(credit.paidTotalMinor || 0) > 0) {
      throw createAgentError({
        code: 'credit_has_payment_history',
        message: 'This credit or financed purchase has payment totals recorded and cannot be voided directly.',
        agentAction: 'Inspect list_credits with includeInstallments=true and list_movements with type=credit_payment. Void related payments first with void_credit_payment. If payment movements are missing, tell the user this credit needs manual review before cancellation.',
        suggestedTool: 'list_credits',
        details: {
          creditId: credit.creditId,
          paidTotal: credit.paidTotal,
          paidTotalMinor: credit.paidTotalMinor
        }
      });
    }
  }

  async voidCreditRecord({
    userId,
    authContext,
    payload,
    expectedCreditType,
    sourceMovementType,
    voidMovementType,
    action,
    metadata = {}
  }) {
    ensureScope(authContext, 'credits:write');
    const normalizedPayload = validateVoidCreditPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'credits:write',
      suggestedTool: 'list_credits'
    });

    const credit = await this.resolveCredit({
      workspaceId: workspace.workspaceId,
      creditId: normalizedPayload.creditId,
      creditName: normalizedPayload.creditName,
      requireActive: false
    });

    if (credit.type !== expectedCreditType) {
      throw createAgentError({
        code: 'credit_type_mismatch',
        message: `This tool expects a credit of type ${expectedCreditType}, but the selected credit is ${credit.type}.`,
        agentAction: expectedCreditType === 'cash_credit'
          ? 'Use void_credit_purchase for financed purchases, or call list_credits and ask the user which credit they mean.'
          : 'Use void_credit for cash credits/loans, or call list_credits and ask the user which financed purchase they mean.',
        suggestedTool: expectedCreditType === 'cash_credit' ? 'void_credit_purchase' : 'void_credit',
        details: {
          creditId: credit.creditId,
          expectedCreditType,
          actualCreditType: credit.type
        }
      });
    }

    if (credit.status === 'cancelled' || credit.voided === true) {
      throw createAgentError({
        code: 'credit_already_voided',
        message: 'This credit or financed purchase is already cancelled/voided.',
        agentAction: 'Do not retry the void action. Show the user the current credit status from list_credits.',
        suggestedTool: 'list_credits',
        details: {
          creditId: credit.creditId,
          status: credit.status
        }
      });
    }

    await this.ensureCreditCanBeVoided({
      workspaceId: workspace.workspaceId,
      credit
    });

    const originMovements = await financeRepository.listCreditMovementsByType({
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      type: sourceMovementType,
      limit: 10
    });
    const activeOriginMovements = originMovements.filter((movement) => movement.voided !== true);

    if (!activeOriginMovements.length) {
      throw createAgentError({
        code: 'credit_origin_movement_not_found',
        message: 'The original credit movement could not be found, so the credit cannot be voided automatically.',
        agentAction: 'Tell the user this credit needs manual review because its original accounting movement is missing.',
        suggestedTool: 'list_movements',
        details: {
          creditId: credit.creditId,
          expectedMovementType: sourceMovementType
        }
      });
    }

    const liabilityAccount = await financeRepository.getAccount({
      workspaceId: workspace.workspaceId,
      accountId: credit.liabilityAccountId
    });

    if (!liabilityAccount) {
      throw createAgentError({
        code: 'credit_liability_account_not_found',
        message: 'The liability account linked to this credit no longer exists.',
        agentAction: 'Tell the user this credit needs manual review because its linked debt account is missing.',
        details: {
          creditId: credit.creditId,
          liabilityAccountId: credit.liabilityAccountId
        }
      });
    }

    const amountMinor = Number(credit.amountMinor || 0);
    const accountDeltas = [
      {
        accountId: liabilityAccount.accountId,
        deltaMinor: amountMinor
      }
    ];
    const lines = [
      {
        accountId: liabilityAccount.accountId,
        accountName: liabilityAccount.name,
        amountMinor,
        amount: toAmount(amountMinor),
        direction: 'debt_reversal'
      }
    ];

    if (expectedCreditType === 'cash_credit') {
      const disbursementAccount = await financeRepository.getAccount({
        workspaceId: workspace.workspaceId,
        accountId: credit.disbursementAccountId
      });

      if (!disbursementAccount) {
        throw createAgentError({
          code: 'credit_disbursement_account_not_found',
          message: 'The account that received this credit no longer exists.',
          agentAction: 'Tell the user this credit needs manual review because the original disbursement account is missing.',
          details: {
            creditId: credit.creditId,
            disbursementAccountId: credit.disbursementAccountId
          }
        });
      }

      accountDeltas.push({
        accountId: disbursementAccount.accountId,
        deltaMinor: -amountMinor
      });
      lines.push({
        accountId: disbursementAccount.accountId,
        accountName: disbursementAccount.name,
        amountMinor: -amountMinor,
        amount: toAmount(-amountMinor),
        direction: 'disbursement_reversal'
      });
    }

    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, action);
    const voidMovement = {
      type: voidMovementType,
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      creditName: credit.name,
      amountMinor,
      amount: toAmount(amountMinor),
      currency: credit.currency,
      date: normalizedPayload.date,
      category: voidMovementType,
      description: `Void ${credit.name}`,
      notes: normalizedPayload.reason,
      voidReason: normalizedPayload.reason,
      originalMovementIds: activeOriginMovements.map((movement) => movement.movementId),
      accountId: liabilityAccount.accountId,
      accountName: liabilityAccount.name,
      lines,
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };
    const idempotencyScopeDate = voidMovement.date || '';
    const idempotencyHash = hashValue(`${action}:${idempotencyScopeDate}:${idempotencyKey}`);
    const installmentIds = Array.isArray(credit.installments)
      ? credit.installments.map((installment) => installment.installmentId).filter(Boolean)
      : [];
    const deactivateAccountIds = liabilityAccount.internal === true ? [liabilityAccount.accountId] : [];
    const result = await financeRepository.voidCreditWithReversal({
      workspaceId: workspace.workspaceId,
      userId,
      creditId: credit.creditId,
      expectedCreditType,
      originalMovementIds: activeOriginMovements.map((movement) => movement.movementId),
      installmentIds,
      accountDeltas,
      voidMovement,
      voidReason: normalizedPayload.reason,
      deactivateAccountIds,
      idempotencyKey,
      idempotencyHash,
      idempotencyScopeDate,
      action
    });

    await financeRepository.createActionLog({
      action,
      workspaceId: workspace.workspaceId,
      userId,
      status: 'success',
      documentId: result.movementId,
      creditId: credit.creditId,
      idempotencyHash,
      idempotencyScopeDate,
      request: {
        credit: summarizeCreditForResponse(credit),
        reason: normalizedPayload.reason,
        idempotencyKey
      }
    });

    const updatedCredit = await financeRepository.getCredit({
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      includeInstallments: true
    });

    return {
      ok: true,
      action,
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      movementId: result.movementId,
      documentId: result.movementId,
      idempotencyKey,
      credit: {
        ...summarizeCreditForResponse(updatedCredit),
        installments: updatedCredit.installments || []
      },
      voidMovement: summarizeMovementForResponse(voidMovement),
      affectedAccounts: await Promise.all(
        accountDeltas.map((delta) => financeRepository.getAccount({
          workspaceId: workspace.workspaceId,
          accountId: delta.accountId
        }))
      )
    };
  }

  async voidCredit({ userId, authContext, payload, metadata = {} }) {
    return this.voidCreditRecord({
      userId,
      authContext,
      payload,
      expectedCreditType: 'cash_credit',
      sourceMovementType: 'credit_disbursement',
      voidMovementType: 'credit_disbursement_void',
      action: 'void_credit',
      metadata
    });
  }

  async voidCreditPurchase({ userId, authContext, payload, metadata = {} }) {
    return this.voidCreditRecord({
      userId,
      authContext,
      payload,
      expectedCreditType: 'installment_purchase',
      sourceMovementType: 'credit_purchase',
      voidMovementType: 'credit_purchase_void',
      action: 'void_credit_purchase',
      metadata
    });
  }

  async voidCreditPayment({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'credits:write');
    const normalizedPayload = validateVoidCreditPaymentPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });

    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'credits:write',
      suggestedTool: 'list_movements'
    });

    const paymentMovement = await financeRepository.getMovement({
      workspaceId: workspace.workspaceId,
      movementId: normalizedPayload.paymentMovementId
    });

    if (!paymentMovement || paymentMovement.active === false) {
      throw createAgentError({
        code: 'movement_not_found',
        message: 'The paymentMovementId does not exist.',
        agentAction: 'Call list_movements with type=credit_payment, ask the user which payment to void, then retry with paymentMovementId.',
        suggestedTool: 'list_movements',
        details: {
          paymentMovementId: normalizedPayload.paymentMovementId
        }
      });
    }

    if (paymentMovement.type !== 'credit_payment') {
      throw createAgentError({
        code: 'movement_type_mismatch',
        message: `Movement ${normalizedPayload.paymentMovementId} is type ${paymentMovement.type}, not credit_payment.`,
        agentAction: 'Call list_movements with type=credit_payment, ask the user which credit payment to void, then retry with the correct paymentMovementId.',
        suggestedTool: 'list_movements',
        details: {
          paymentMovementId: normalizedPayload.paymentMovementId,
          actualType: paymentMovement.type
        }
      });
    }

    if (paymentMovement.voided === true) {
      throw createAgentError({
        code: 'credit_payment_already_voided',
        message: 'This credit payment has already been voided.',
        agentAction: 'Do not retry the void action. Show the user the existing void status from list_movements.',
        suggestedTool: 'list_movements',
        details: {
          paymentMovementId: normalizedPayload.paymentMovementId,
          voidMovementId: paymentMovement.voidMovementId || ''
        }
      });
    }

    const credit = await financeRepository.getCredit({
      workspaceId: workspace.workspaceId,
      creditId: paymentMovement.creditId,
      includeInstallments: true
    });

    if (!credit) {
      throw createAgentError({
        code: 'credit_not_found',
        message: 'The credit linked to this payment does not exist.',
        agentAction: 'Tell the user this payment needs manual review because its linked credit is missing.',
        details: {
          paymentMovementId: normalizedPayload.paymentMovementId,
          creditId: paymentMovement.creditId || ''
        }
      });
    }

    if (credit.status === 'cancelled' || credit.voided === true) {
      throw createAgentError({
        code: 'credit_already_voided',
        message: 'The credit linked to this payment is already cancelled/voided.',
        agentAction: 'Do not void this payment automatically. Show the user the credit status and movement details; this needs manual review to avoid reviving a cancelled credit.',
        suggestedTool: 'list_credits',
        details: {
          creditId: credit.creditId,
          status: credit.status
        }
      });
    }

    const paymentAccount = await financeRepository.getAccount({
      workspaceId: workspace.workspaceId,
      accountId: paymentMovement.fromAccountId
    });
    const liabilityAccount = await financeRepository.getAccount({
      workspaceId: workspace.workspaceId,
      accountId: paymentMovement.toAccountId
    });

    if (!paymentAccount || !liabilityAccount) {
      throw createAgentError({
        code: 'credit_payment_account_not_found',
        message: 'One of the accounts linked to this credit payment no longer exists.',
        agentAction: 'Tell the user this payment needs manual review because its payment or debt account is missing.',
        details: {
          paymentMovementId: normalizedPayload.paymentMovementId,
          paymentAccountId: paymentMovement.fromAccountId || '',
          liabilityAccountId: paymentMovement.toAccountId || ''
        }
      });
    }

    const amountMinor = Number(paymentMovement.amountMinor || 0);
    const principalAmountMinor = Number(paymentMovement.principalAmountMinor || 0);
    const interestAmountMinor = Number(paymentMovement.interestAmountMinor || 0);
    const feeAmountMinor = Number(paymentMovement.feeAmountMinor || 0);
    const nextOutstandingMinor = Number(credit.outstandingPrincipalMinor || 0) + principalAmountMinor;
    const paidPrincipalMinor = Math.max(0, Number(credit.paidPrincipalMinor || 0) - principalAmountMinor);
    const paidInterestMinor = Math.max(0, Number(credit.paidInterestMinor || 0) - interestAmountMinor);
    const paidFeesMinor = Math.max(0, Number(credit.paidFeesMinor || 0) - feeAmountMinor);
    const paidTotalMinor = Math.max(0, Number(credit.paidTotalMinor || 0) - amountMinor);
    const creditUpdates = {
      outstandingPrincipalMinor: nextOutstandingMinor,
      outstandingPrincipal: toAmount(nextOutstandingMinor),
      paidPrincipalMinor,
      paidPrincipal: toAmount(paidPrincipalMinor),
      paidInterestMinor,
      paidInterest: toAmount(paidInterestMinor),
      paidFeesMinor,
      paidFees: toAmount(paidFeesMinor),
      paidTotalMinor,
      paidTotal: toAmount(paidTotalMinor),
      status: nextOutstandingMinor > 0 ? 'active' : credit.status,
      ...(nextOutstandingMinor > 0 ? { paidDate: '' } : {})
    };
    const installment = Array.isArray(credit.installments)
      ? credit.installments.find((item) => item.installmentId === paymentMovement.installmentId)
      : null;
    let installmentUpdates = {};

    if (installment) {
      const nextPaidAmountMinor = Math.max(0, Number(installment.paidAmountMinor || 0) - amountMinor);
      const nextPrincipalPaidMinor = Math.max(0, Number(installment.principalPaidMinor || 0) - principalAmountMinor);
      const nextInterestPaidMinor = Math.max(0, Number(installment.interestPaidMinor || 0) - interestAmountMinor);
      const nextFeePaidMinor = Math.max(0, Number(installment.feePaidMinor || 0) - feeAmountMinor);
      const scheduledPaymentMinor = Number(installment.scheduledPaymentMinor || 0);
      const nextStatus = nextPaidAmountMinor <= 0
        ? 'pending'
        : nextPaidAmountMinor >= scheduledPaymentMinor ? 'paid' : 'partial';

      installmentUpdates = {
        status: nextStatus,
        paidDate: nextStatus === 'paid' ? installment.paidDate : '',
        paidAmountMinor: nextPaidAmountMinor,
        paidAmount: toAmount(nextPaidAmountMinor),
        principalPaidMinor: nextPrincipalPaidMinor,
        principalPaid: toAmount(nextPrincipalPaidMinor),
        interestPaidMinor: nextInterestPaidMinor,
        interestPaid: toAmount(nextInterestPaidMinor),
        feePaidMinor: nextFeePaidMinor,
        feePaid: toAmount(nextFeePaidMinor)
      };
    }

    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'void-credit-payment');
    const voidMovement = {
      type: 'credit_payment_void',
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      creditName: credit.name,
      installmentId: paymentMovement.installmentId || '',
      installmentNumber: paymentMovement.installmentNumber || null,
      amountMinor,
      amount: toAmount(amountMinor),
      principalAmountMinor,
      principalAmount: toAmount(principalAmountMinor),
      interestAmountMinor,
      interestAmount: toAmount(interestAmountMinor),
      feeAmountMinor,
      feeAmount: toAmount(feeAmountMinor),
      currency: credit.currency,
      date: normalizedPayload.date,
      category: 'credit_payment_void',
      description: `Void payment for ${credit.name}`,
      notes: normalizedPayload.reason,
      voidReason: normalizedPayload.reason,
      originalMovementId: normalizedPayload.paymentMovementId,
      fromAccountId: liabilityAccount.accountId,
      fromAccountName: liabilityAccount.name,
      toAccountId: paymentAccount.accountId,
      toAccountName: paymentAccount.name,
      lines: [
        createLine({
          account: paymentAccount,
          amountMinor,
          direction: 'payment_reversal'
        }),
        {
          accountId: liabilityAccount.accountId,
          accountName: liabilityAccount.name,
          amountMinor: -principalAmountMinor,
          amount: toAmount(-principalAmountMinor),
          direction: 'debt_reincrease'
        }
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };
    const accountDeltas = [
      {
        accountId: paymentAccount.accountId,
        deltaMinor: amountMinor
      },
      {
        accountId: liabilityAccount.accountId,
        deltaMinor: -principalAmountMinor
      }
    ];
    const idempotencyScopeDate = voidMovement.date || '';
    const idempotencyHash = hashValue(`void_credit_payment:${idempotencyScopeDate}:${idempotencyKey}`);
    const result = await financeRepository.voidCreditPaymentWithReversal({
      workspaceId: workspace.workspaceId,
      userId,
      paymentMovementId: normalizedPayload.paymentMovementId,
      creditId: credit.creditId,
      installmentId: installment?.installmentId || '',
      creditUpdates,
      installmentUpdates,
      accountDeltas,
      voidMovement,
      voidReason: normalizedPayload.reason,
      idempotencyKey,
      idempotencyHash,
      idempotencyScopeDate,
      action: 'void_credit_payment'
    });

    await financeRepository.createActionLog({
      action: 'void_credit_payment',
      workspaceId: workspace.workspaceId,
      userId,
      status: 'success',
      documentId: result.movementId,
      creditId: credit.creditId,
      idempotencyHash,
      idempotencyScopeDate,
      request: {
        originalPayment: summarizeMovementForResponse(paymentMovement),
        reason: normalizedPayload.reason,
        idempotencyKey
      }
    });

    const updatedCredit = await financeRepository.getCredit({
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      includeInstallments: true
    });

    return {
      ok: true,
      action: 'void_credit_payment',
      workspaceId: workspace.workspaceId,
      creditId: credit.creditId,
      movementId: result.movementId,
      documentId: result.movementId,
      originalMovementId: normalizedPayload.paymentMovementId,
      idempotencyKey,
      credit: {
        ...summarizeCreditForResponse(updatedCredit),
        installments: updatedCredit.installments || []
      },
      voidMovement: summarizeMovementForResponse(voidMovement),
      affectedAccounts: await Promise.all(
        accountDeltas.map((delta) => financeRepository.getAccount({
          workspaceId: workspace.workspaceId,
          accountId: delta.accountId
        }))
      )
    };
  }

  async upsertExpense({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'expenses:write');
    const normalizedPayload = validateUpsertExpensePayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'expenses:write',
      suggestedTool: 'list_movements'
    });
    const account = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.accountId,
      accountName: normalizedPayload.accountName
    });
    const paymentMethod = await this.resolvePaymentMethod({
      workspaceId: workspace.workspaceId,
      account,
      paymentMethodId: normalizedPayload.paymentMethodId,
      paymentMethodName: normalizedPayload.paymentMethodName
    });
    const category = await this.resolveCategory({
      workspaceId: workspace.workspaceId,
      categoryId: normalizedPayload.categoryId,
      categoryName: normalizedPayload.categoryName,
      movementType: 'expense'
    });

    requireSameCurrency({
      expectedCurrency: normalizedPayload.currency,
      actualCurrency: account.currency,
      field: `account "${account.name}"`,
      account
    });

    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'expense');
    const movement = {
      type: 'expense',
      workspaceId: workspace.workspaceId,
      amountMinor: normalizedPayload.amountMinor,
      amount: normalizedPayload.amount,
      currency: normalizedPayload.currency,
      date: normalizedPayload.date,
      category: category.name,
      categoryId: category.categoryId,
      categoryName: category.name,
      categoryType: category.type,
      merchant: normalizedPayload.merchant,
      description: normalizedPayload.description || normalizedPayload.merchant,
      notes: normalizedPayload.notes,
      accountId: account.accountId,
      accountName: account.name,
      paymentMethodId: paymentMethod?.paymentMethodId || '',
      paymentMethodName: paymentMethod?.name || '',
      lines: [
        createLine({
          account,
          paymentMethod,
          amountMinor: -normalizedPayload.amountMinor,
          direction: 'outflow'
        })
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };

    const accountDeltas = [
      {
        accountId: account.accountId,
        deltaMinor: -normalizedPayload.amountMinor
      }
    ];

    if (normalizedPayload.movementId) {
      return this.updateMovementAndLog({
        userId,
        workspaceId: workspace.workspaceId,
        action: 'upsert_expense',
        movementId: normalizedPayload.movementId,
        expectedType: 'expense',
        movement,
        accountDeltas
      });
    }

    return this.createMovementAndLog({
      userId,
      workspaceId: workspace.workspaceId,
      action: 'upsert_expense',
      movement,
      accountDeltas,
      idempotencyKey
    });
  }

  async upsertIncome({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'income:write');
    const normalizedPayload = validateUpsertIncomePayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'income:write',
      suggestedTool: 'list_movements'
    });
    const account = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.accountId,
      accountName: normalizedPayload.accountName
    });
    const category = await this.resolveCategory({
      workspaceId: workspace.workspaceId,
      categoryId: normalizedPayload.categoryId,
      categoryName: normalizedPayload.categoryName,
      movementType: 'income'
    });

    requireSameCurrency({
      expectedCurrency: normalizedPayload.currency,
      actualCurrency: account.currency,
      field: `account "${account.name}"`,
      account
    });

    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'income');
    const movement = {
      type: 'income',
      workspaceId: workspace.workspaceId,
      amountMinor: normalizedPayload.amountMinor,
      amount: normalizedPayload.amount,
      currency: normalizedPayload.currency,
      date: normalizedPayload.date,
      category: category.name,
      categoryId: category.categoryId,
      categoryName: category.name,
      categoryType: category.type,
      sourceName: normalizedPayload.sourceName || '',
      description: normalizedPayload.description || normalizedPayload.sourceName || category.name,
      notes: normalizedPayload.notes,
      accountId: account.accountId,
      accountName: account.name,
      lines: [
        createLine({
          account,
          amountMinor: normalizedPayload.amountMinor,
          direction: 'inflow'
        })
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };

    const accountDeltas = [
      {
        accountId: account.accountId,
        deltaMinor: normalizedPayload.amountMinor
      }
    ];

    if (normalizedPayload.movementId) {
      return this.updateMovementAndLog({
        userId,
        workspaceId: workspace.workspaceId,
        action: 'upsert_income',
        movementId: normalizedPayload.movementId,
        expectedType: 'income',
        movement,
        accountDeltas
      });
    }

    return this.createMovementAndLog({
      userId,
      workspaceId: workspace.workspaceId,
      action: 'upsert_income',
      movement,
      accountDeltas,
      idempotencyKey
    });
  }

  async upsertTransfer({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'transfers:write');
    const normalizedPayload = validateUpsertTransferPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'transfers:write',
      suggestedTool: 'list_movements'
    });
    const fromAccount = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.fromAccountId,
      accountName: normalizedPayload.fromAccountName,
      fieldPrefix: 'from'
    });
    const toAccount = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.toAccountId,
      accountName: normalizedPayload.toAccountName,
      fieldPrefix: 'to'
    });

    if (fromAccount.accountId === toAccount.accountId) {
      throw createAgentError({
        code: 'invalid_transfer_accounts',
        message: 'fromAccount and toAccount must be different accounts.',
        agentAction: 'Ask the user for a different destination account, then retry upsert_transfer.',
        missingFields: ['toAccountId']
      });
    }

    requireSameCurrency({
      expectedCurrency: normalizedPayload.currency,
      actualCurrency: fromAccount.currency,
      field: `fromAccount "${fromAccount.name}"`,
      account: fromAccount
    });
    requireSameCurrency({
      expectedCurrency: normalizedPayload.currency,
      actualCurrency: toAccount.currency,
      field: `toAccount "${toAccount.name}"`,
      account: toAccount
    });

    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'transfer');
    const movement = {
      type: 'transfer',
      workspaceId: workspace.workspaceId,
      amountMinor: normalizedPayload.amountMinor,
      amount: normalizedPayload.amount,
      currency: normalizedPayload.currency,
      date: normalizedPayload.date,
      category: normalizedPayload.category || 'transfer',
      description: normalizedPayload.description || `Transfer from ${fromAccount.name} to ${toAccount.name}`,
      notes: normalizedPayload.notes,
      fromAccountId: fromAccount.accountId,
      fromAccountName: fromAccount.name,
      toAccountId: toAccount.accountId,
      toAccountName: toAccount.name,
      lines: [
        createLine({
          account: fromAccount,
          amountMinor: -normalizedPayload.amountMinor,
          direction: 'outflow'
        }),
        createLine({
          account: toAccount,
          amountMinor: normalizedPayload.amountMinor,
          direction: 'inflow'
        })
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };

    const accountDeltas = [
      {
        accountId: fromAccount.accountId,
        deltaMinor: -normalizedPayload.amountMinor
      },
      {
        accountId: toAccount.accountId,
        deltaMinor: normalizedPayload.amountMinor
      }
    ];

    if (normalizedPayload.movementId) {
      return this.updateMovementAndLog({
        userId,
        workspaceId: workspace.workspaceId,
        action: 'upsert_transfer',
        movementId: normalizedPayload.movementId,
        expectedType: 'transfer',
        movement,
        accountDeltas
      });
    }

    return this.createMovementAndLog({
      userId,
      workspaceId: workspace.workspaceId,
      action: 'upsert_transfer',
      movement,
      accountDeltas,
      idempotencyKey
    });
  }

  async setAccountBalance({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'accounts:write');
    const normalizedPayload = validateSetAccountBalancePayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'accounts:write',
      suggestedTool: 'list_accounts'
    });
    const account = await this.resolveAccount({
      workspaceId: workspace.workspaceId,
      accountId: normalizedPayload.accountId,
      accountName: normalizedPayload.accountName
    });
    const currency = normalizedPayload.currency || account.currency;

    requireSameCurrency({
      expectedCurrency: currency,
      actualCurrency: account.currency,
      field: `account "${account.name}"`,
      account
    });

    const targetBalanceMinor = account.type === 'credit_card' && normalizedPayload.balanceMinor > 0
      ? -normalizedPayload.balanceMinor
      : normalizedPayload.balanceMinor;
    const targetBalance = toAmount(targetBalanceMinor);
    const deltaMinor = targetBalanceMinor - Number(account.balanceMinor || 0);
    const idempotencyKey = normalizeIdempotencyKey(normalizedPayload.idempotencyKey, 'balance');
    const movement = {
      type: 'balance_adjustment',
      workspaceId: workspace.workspaceId,
      amountMinor: Math.abs(deltaMinor),
      amount: toAmount(Math.abs(deltaMinor)),
      currency,
      date: normalizedPayload.date,
      category: 'balance_adjustment',
      description: normalizedPayload.description || `Balance adjustment for ${account.name}`,
      notes: normalizedPayload.notes,
      accountId: account.accountId,
      accountName: account.name,
      balanceBeforeMinor: Number(account.balanceMinor || 0),
      balanceBefore: toAmount(account.balanceMinor || 0),
      balanceAfterMinor: targetBalanceMinor,
      balanceAfter: targetBalance,
      lines: [
        createLine({
          account,
          amountMinor: deltaMinor,
          direction: deltaMinor >= 0 ? 'inflow' : 'outflow'
        })
      ],
      source: 'chat-action-gateway-mcp',
      authType: 'firebase-google-oauth',
      metadata
    };

    return this.createMovementAndLog({
      userId,
      workspaceId: workspace.workspaceId,
      action: 'set_account_balance',
      movement,
      accountDeltas: [
        {
          accountId: account.accountId,
          deltaMinor
        }
      ],
      idempotencyKey
    });
  }

  async createMovementAndLog({
    userId,
    workspaceId,
    action,
    movement,
    accountDeltas,
    idempotencyKey
  }) {
    const idempotencyScopeDate = movement.date || '';
    const idempotencyHash = hashValue(`${action}:${idempotencyScopeDate}:${idempotencyKey}`);
    const logBase = {
      action,
      workspaceId,
      userId,
      idempotencyHash,
      idempotencyScopeDate,
      request: {
        ...summarizeMovementForResponse(movement),
        idempotencyKey
      }
    };

    try {
      const result = await financeRepository.createMovementWithIdempotency({
        workspaceId,
        userId,
        movement,
        accountDeltas,
        idempotencyKey,
        idempotencyHash,
        idempotencyScopeDate,
        action
      });
      const affectedAccounts = await Promise.all(
        accountDeltas.map((delta) => financeRepository.getAccount({
          workspaceId,
          accountId: delta.accountId
        }))
      );

      await financeRepository.createActionLog({
        ...logBase,
        status: 'success',
        documentId: result.documentId
      });

      return {
        ok: true,
        action,
        workspaceId,
        movementId: result.documentId,
        documentId: result.documentId,
        idempotencyKey,
        movement: summarizeMovementForResponse(movement),
        affectedAccounts
      };
    } catch (error) {
      await this.tryLogFailure({
        ...logBase,
        status: 'error',
        errorCode: error.code || 'movement_failed',
        errorMessage: error.message || 'Could not create movement.'
      });

      if (error.code === 'duplicate_action') {
        throw createAgentError({
          statusCode: 409,
          code: 'duplicate_action',
          message: 'A movement with this idempotencyKey already exists.',
          agentAction: 'Do not retry with the same idempotencyKey for the same action and movement date. Tell the user the action appears to have already been recorded, or retry with a new idempotencyKey only if they confirm it is a different real-world movement.',
          details: {
            documentId: error.details?.documentId || null,
            idempotencyScopeDate,
            idempotencyKey
          }
        });
      }

      throw error;
    }
  }

  getMovementAccountDeltas(movement) {
    if (movement.type === 'expense') {
      return [{
        accountId: movement.accountId,
        deltaMinor: -Number(movement.amountMinor || 0)
      }];
    }

    if (movement.type === 'income') {
      return [{
        accountId: movement.accountId,
        deltaMinor: Number(movement.amountMinor || 0)
      }];
    }

    if (movement.type === 'transfer') {
      return [
        {
          accountId: movement.fromAccountId,
          deltaMinor: -Number(movement.amountMinor || 0)
        },
        {
          accountId: movement.toAccountId,
          deltaMinor: Number(movement.amountMinor || 0)
        }
      ];
    }

    throw createAgentError({
      code: 'movement_update_not_supported',
      message: `Movements of type ${movement.type} cannot be updated by this tool.`,
      agentAction: 'Explain that this movement type has additional accounting effects. Use the matching domain tool or record an adjustment instead of editing it directly.',
      details: {
        movementId: movement.movementId || movement.id,
        type: movement.type
      }
    });
  }

  async updateMovementAndLog({
    userId,
    workspaceId,
    action,
    movementId,
    expectedType,
    movement,
    accountDeltas
  }) {
    const previousMovement = await financeRepository.getMovement({
      workspaceId,
      movementId
    });

    if (!previousMovement || previousMovement.active === false) {
      throw createAgentError({
        code: 'movement_not_found',
        message: 'The movementId provided for update does not exist.',
        agentAction: 'Call list_movements, ask the user which movement to update, then retry with the selected movementId.',
        suggestedTool: 'list_movements',
        details: {
          workspaceId,
          movementId
        }
      });
    }

    if (previousMovement.type !== expectedType) {
      throw createAgentError({
        code: 'movement_type_mismatch',
        message: `Movement ${movementId} is type ${previousMovement.type}, not ${expectedType}.`,
        agentAction: `Use the update tool for ${previousMovement.type}, or call list_movements and ask the user which movement they want to update.`,
        suggestedTool: 'list_movements',
        details: {
          workspaceId,
          movementId,
          expectedType,
          actualType: previousMovement.type
        }
      });
    }

    const previousAccountDeltas = this.getMovementAccountDeltas(previousMovement);
    const result = await financeRepository.updateMovementWithAccountDeltas({
      workspaceId,
      userId,
      movementId,
      expectedType,
      movement,
      previousAccountDeltas,
      nextAccountDeltas: accountDeltas
    });
    const affectedAccountIds = Array.from(new Set([
      ...previousAccountDeltas.map((delta) => delta.accountId),
      ...accountDeltas.map((delta) => delta.accountId)
    ].filter(Boolean)));
    const affectedAccounts = await Promise.all(
      affectedAccountIds.map((accountId) => financeRepository.getAccount({
        workspaceId,
        accountId
      }))
    );

    await financeRepository.createActionLog({
      action,
      workspaceId,
      userId,
      status: 'success',
      documentId: result.documentId,
      request: {
        previousMovement: summarizeMovementForResponse(previousMovement),
        nextMovement: summarizeMovementForResponse(movement)
      }
    });

    return {
      ok: true,
      action,
      workspaceId,
      movementId: result.documentId,
      documentId: result.documentId,
      created: false,
      movement: summarizeMovementForResponse(movement),
      previousMovement: summarizeMovementForResponse(previousMovement),
      affectedAccounts
    };
  }

  async listMovements({ userId, authContext, payload = {} }) {
    ensureScope(authContext, 'movements:read');
    const normalizedPayload = validateListMovementsPayload(payload);
    const workspace = await this.resolveWorkspace({
      userId,
      workspaceId: normalizedPayload.workspaceId
    });
    await this.ensureWorkspaceScope({
      userId,
      workspace,
      requiredScope: 'movements:read'
    });
    let accountId = normalizedPayload.accountId;

    if (!accountId && normalizedPayload.accountName) {
      const account = await this.resolveAccount({
        workspaceId: workspace.workspaceId,
        accountName: normalizedPayload.accountName
      });
      accountId = account.accountId;
    }

    const page = await this.listFilteredMovementPage({
      workspaceId: workspace.workspaceId,
      filters: normalizedPayload,
      accountId
    });

    return {
      ok: true,
      action: 'list_movements',
      workspaceId: workspace.workspaceId,
      period: normalizedPayload.period,
      startDate: normalizedPayload.startDate,
      endDate: normalizedPayload.endDate,
      count: page.movements.length,
      summary: this.summarizeMovements(page.movements),
      pagination: page.pagination,
      movements: page.movements
    };
  }

  async listFilteredMovementPage({ workspaceId, filters, accountId }) {
    const limit = filters.limit;
    const rawPageLimit = Math.min(MOVEMENT_RAW_PAGE_LIMIT, Math.max(limit, 50));
    let cursor = decodeMovementCursor(filters.cursor);
    let nextRawCursor = cursor;
    let scannedCount = 0;
    let hasMore = false;
    let nextCursor = '';
    let scanLimitReached = false;
    const movements = [];

    while (scannedCount < MOVEMENT_SCAN_LIMIT) {
      const page = await financeRepository.listMovements({
        workspaceId,
        filters,
        cursor: nextRawCursor,
        limit: rawPageLimit
      });

      if (!page.movements.length) {
        hasMore = false;
        nextCursor = '';
        break;
      }

      for (const movement of page.movements) {
        scannedCount += 1;
        const movementCursor = {
          date: movement.date,
          movementId: movement.movementId
        };

        if (this.movementMatchesFilters({
          movement,
          filters,
          accountId
        })) {
          if (movements.length < limit) {
            movements.push(movement);
          } else {
            hasMore = true;
            nextCursor = encodeMovementCursor({
              date: movements[movements.length - 1].date,
              movementId: movements[movements.length - 1].movementId
            });
            break;
          }
        }

        nextRawCursor = movementCursor;

        if (scannedCount >= MOVEMENT_SCAN_LIMIT) {
          break;
        }
      }

      if (hasMore) {
        break;
      }

      if (scannedCount >= MOVEMENT_SCAN_LIMIT) {
        scanLimitReached = Boolean(page.pagination.hasMore);
        hasMore = scanLimitReached;
        nextCursor = scanLimitReached && nextRawCursor
          ? encodeMovementCursor(nextRawCursor)
          : '';
        break;
      }

      if (!page.pagination.hasMore) {
        hasMore = false;
        nextCursor = '';
        break;
      }

      nextRawCursor = page.pagination.nextCursor;
    }

    return {
      movements,
      pagination: {
        limit,
        returned: movements.length,
        hasMore,
        nextCursor,
        scannedCount,
        scanLimit: MOVEMENT_SCAN_LIMIT,
        scanLimitReached,
        instruction: hasMore
          ? 'More movements are available. Ask the user if they want to see the next page, then call list_movements again with the same filters and this nextCursor as cursor.'
          : 'No more movements are available for these filters.'
      }
    };
  }

  movementMatchesFilters({ movement, filters, accountId }) {
    if (filters.type && movement.type !== filters.type) {
      return false;
    }

    if (filters.categoryId && movement.categoryId !== filters.categoryId) {
      return false;
    }

    if (
      filters.categoryName
      && normalizeLookupName(movement.categoryName || movement.category) !== normalizeLookupName(filters.categoryName)
    ) {
      return false;
    }

    if (accountId && !this.movementTouchesAccount(movement, accountId)) {
      return false;
    }

    return true;
  }

  movementTouchesAccount(movement, accountId) {
    if (movement.accountId === accountId || movement.fromAccountId === accountId || movement.toAccountId === accountId) {
      return true;
    }

    return Array.isArray(movement.lines)
      && movement.lines.some((line) => line.accountId === accountId);
  }

  summarizeMovements(movements) {
    const byCurrency = movements.reduce((summary, movement) => {
      const currency = normalizeCurrency(movement.currency || 'MXN');
      const current = summary[currency] || {
        incomeMinor: 0,
        expenseMinor: 0,
        transferMinor: 0,
        balanceAdjustmentMinor: 0,
        creditDisbursementMinor: 0,
        creditPurchaseMinor: 0,
        creditPaymentMinor: 0,
        creditDisbursementVoidMinor: 0,
        creditPurchaseVoidMinor: 0,
        creditPaymentVoidMinor: 0,
        creditPrincipalPaymentMinor: 0,
        creditInterestMinor: 0,
        creditFeeMinor: 0,
        spendingMinor: 0,
        netMinor: 0
      };
      const amountMinor = Number(movement.amountMinor || 0);

      if (movement.type === 'income') {
        current.incomeMinor += amountMinor;
        current.netMinor += amountMinor;
      }

      if (movement.type === 'expense') {
        current.expenseMinor += amountMinor;
        current.spendingMinor += amountMinor;
        current.netMinor -= amountMinor;
      }

      if (movement.type === 'transfer') {
        current.transferMinor += amountMinor;
      }

      if (movement.type === 'balance_adjustment') {
        current.balanceAdjustmentMinor += amountMinor;
      }

      if (movement.type === 'credit_disbursement') {
        current.creditDisbursementMinor += amountMinor;
      }

      if (movement.type === 'credit_purchase') {
        current.creditPurchaseMinor += amountMinor;
        current.spendingMinor += amountMinor;
      }

      if (movement.type === 'credit_payment') {
        const principalMinor = Number(movement.principalAmountMinor || 0);
        const interestMinor = Number(movement.interestAmountMinor || 0);
        const feeMinor = Number(movement.feeAmountMinor || 0);

        current.creditPaymentMinor += amountMinor;
        current.creditPrincipalPaymentMinor += principalMinor;
        current.creditInterestMinor += interestMinor;
        current.creditFeeMinor += feeMinor;
        current.spendingMinor += interestMinor + feeMinor;
        current.netMinor -= interestMinor + feeMinor;
      }

      if (movement.type === 'credit_disbursement_void') {
        current.creditDisbursementVoidMinor += amountMinor;
        current.creditDisbursementMinor -= amountMinor;
      }

      if (movement.type === 'credit_purchase_void') {
        current.creditPurchaseVoidMinor += amountMinor;
        current.creditPurchaseMinor -= amountMinor;
        current.spendingMinor -= amountMinor;
      }

      if (movement.type === 'credit_payment_void') {
        const principalMinor = Number(movement.principalAmountMinor || 0);
        const interestMinor = Number(movement.interestAmountMinor || 0);
        const feeMinor = Number(movement.feeAmountMinor || 0);

        current.creditPaymentVoidMinor += amountMinor;
        current.creditPaymentMinor -= amountMinor;
        current.creditPrincipalPaymentMinor -= principalMinor;
        current.creditInterestMinor -= interestMinor;
        current.creditFeeMinor -= feeMinor;
        current.spendingMinor -= interestMinor + feeMinor;
        current.netMinor += interestMinor + feeMinor;
      }

      summary[currency] = current;
      return summary;
    }, {});

    Object.keys(byCurrency).forEach((currency) => {
      const item = byCurrency[currency];
      item.income = toAmount(item.incomeMinor);
      item.expense = toAmount(item.expenseMinor);
      item.transfer = toAmount(item.transferMinor);
      item.balanceAdjustment = toAmount(item.balanceAdjustmentMinor);
      item.creditDisbursement = toAmount(item.creditDisbursementMinor);
      item.creditPurchase = toAmount(item.creditPurchaseMinor);
      item.creditPayment = toAmount(item.creditPaymentMinor);
      item.creditDisbursementVoid = toAmount(item.creditDisbursementVoidMinor);
      item.creditPurchaseVoid = toAmount(item.creditPurchaseVoidMinor);
      item.creditPaymentVoid = toAmount(item.creditPaymentVoidMinor);
      item.creditPrincipalPayment = toAmount(item.creditPrincipalPaymentMinor);
      item.creditInterest = toAmount(item.creditInterestMinor);
      item.creditFee = toAmount(item.creditFeeMinor);
      item.spending = toAmount(item.spendingMinor);
      item.net = toAmount(item.netMinor);
    });

    return {
      byCurrency
    };
  }

  async tryLogFailure(logData) {
    try {
      await financeRepository.createActionLog(logData);
    } catch (logError) {
      console.error('Error writing finance failure log:', logError);
    }
  }
}

module.exports = new FinanceService();
