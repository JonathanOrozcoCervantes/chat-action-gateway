const financeRepository = require('../repositories/financeRepository');
const {
  fromMinorUnits,
  normalizeCurrency,
  normalizeLookupName,
  validateCreateExpensePayload,
  validateCreateIncomePayload,
  validateCreateTransferPayload,
  validateCreateWorkspacePayload,
  validateAddWorkspaceMemberPayload,
  validateListCategoriesPayload,
  validateListMovementsPayload,
  validateListWorkspaceMembersPayload,
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
          agentAction: 'Ask the user for the current balance of this account before creating it. For cash, ask how much cash they have right now. For bank or wallet accounts, ask the current available balance. For credit cards or loans, ask the current debt/balance. If the user does not know, ask whether they want to start from 0 and explain future balances may be incomplete.',
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

    const deltaMinor = normalizedPayload.balanceMinor - Number(account.balanceMinor || 0);
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
      balanceAfterMinor: normalizedPayload.balanceMinor,
      balanceAfter: normalizedPayload.balance,
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

    const movements = (await financeRepository.listMovements({
      workspaceId: workspace.workspaceId,
      filters: normalizedPayload
    })).filter((movement) => {
      if (normalizedPayload.type && movement.type !== normalizedPayload.type) {
        return false;
      }

      if (normalizedPayload.categoryId && movement.categoryId !== normalizedPayload.categoryId) {
        return false;
      }

      if (
        normalizedPayload.categoryName
        && normalizeLookupName(movement.categoryName || movement.category) !== normalizeLookupName(normalizedPayload.categoryName)
      ) {
        return false;
      }

      if (accountId && !this.movementTouchesAccount(movement, accountId)) {
        return false;
      }

      return true;
    });

    return {
      ok: true,
      action: 'list_movements',
      workspaceId: workspace.workspaceId,
      period: normalizedPayload.period,
      startDate: normalizedPayload.startDate,
      endDate: normalizedPayload.endDate,
      count: movements.length,
      summary: this.summarizeMovements(movements),
      movements
    };
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
        netMinor: 0
      };
      const amountMinor = Number(movement.amountMinor || 0);

      if (movement.type === 'income') {
        current.incomeMinor += amountMinor;
        current.netMinor += amountMinor;
      }

      if (movement.type === 'expense') {
        current.expenseMinor += amountMinor;
        current.netMinor -= amountMinor;
      }

      if (movement.type === 'transfer') {
        current.transferMinor += amountMinor;
      }

      if (movement.type === 'balance_adjustment') {
        current.balanceAdjustmentMinor += amountMinor;
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
