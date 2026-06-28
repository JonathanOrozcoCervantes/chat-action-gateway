const financeRepository = require('../repositories/financeRepository');
const {
  fromMinorUnits,
  normalizeCurrency,
  normalizeLookupName,
  toMinorUnits,
  validateCreateCreditPayload,
  validateCreateCreditPurchasePayload,
  validateCreateExpensePayload,
  validateCreateIncomePayload,
  validateCreateTransferPayload,
  validateCreateWorkspacePayload,
  validateAddWorkspaceMemberPayload,
  validateListCategoriesPayload,
  validateListCreditsPayload,
  validateListMovementsPayload,
  validateListWorkspaceMembersPayload,
  validateRecordCreditPaymentPayload,
  validateSetAccountBalancePayload,
  validateUpsertAccountPayload,
  validateUpsertCategoryPayload,
  validateUpsertPaymentMethodPayload
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
  lines: movement.lines || []
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

  async createWorkspace({ userId, authContext, payload }) {
    ensureScope(authContext, 'workspaces:write');
    const normalizedPayload = validateCreateWorkspacePayload(payload);
    const result = await financeRepository.createWorkspace({
      userId,
      payload: normalizedPayload
    });
    const workspace = await financeRepository.getWorkspace(result.workspaceId);

    return {
      ok: true,
      action: 'create_workspace',
      workspaceId: result.workspaceId,
      workspace
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

  async addWorkspaceMember({ userId, authContext, payload }) {
    ensureScope(authContext, 'members:write');
    const normalizedPayload = validateAddWorkspaceMemberPayload(payload);
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
        agentAction: 'Tell the user that the member must first connect this MCP with Google so their Firebase account exists. After that, retry add_workspace_member using memberEmail.',
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
      action: 'add_workspace_member',
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

  async createExpense({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'expenses:write');
    const normalizedPayload = validateCreateExpensePayload(payload);
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

    return this.createMovementAndLog({
      userId,
      workspaceId: workspace.workspaceId,
      action: 'create_expense',
      movement,
      accountDeltas: [
        {
          accountId: account.accountId,
          deltaMinor: -normalizedPayload.amountMinor
        }
      ],
      idempotencyKey
    });
  }

  async createIncome({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'income:write');
    const normalizedPayload = validateCreateIncomePayload(payload);
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

    return this.createMovementAndLog({
      userId,
      workspaceId: workspace.workspaceId,
      action: 'create_income',
      movement,
      accountDeltas: [
        {
          accountId: account.accountId,
          deltaMinor: normalizedPayload.amountMinor
        }
      ],
      idempotencyKey
    });
  }

  async createTransfer({ userId, authContext, payload, metadata = {} }) {
    ensureScope(authContext, 'transfers:write');
    const normalizedPayload = validateCreateTransferPayload(payload);
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
        agentAction: 'Ask the user for a different destination account, then retry create_transfer.',
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

    return this.createMovementAndLog({
      userId,
      workspaceId: workspace.workspaceId,
      action: 'create_transfer',
      movement,
      accountDeltas: [
        {
          accountId: fromAccount.accountId,
          deltaMinor: -normalizedPayload.amountMinor
        },
        {
          accountId: toAccount.accountId,
          deltaMinor: normalizedPayload.amountMinor
        }
      ],
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
