const { z } = require('zod');
const financeService = require('../services/financeService');
const { toMcpToolError } = require('../utils/agentError');
const { logError, logInfo } = require('../utils/logger');
const { FINANCE_SCOPES } = require('./scopes');

const moneyInput = z.union([z.number(), z.string()]);
const scopeInput = z.enum(FINANCE_SCOPES);
const optionalText = (max = 500) => z.string().max(max).optional();
const workspaceIdInput = {
  workspaceId: optionalText(120).describe('Workspace ID. If omitted and the user has more than one workspace, the tool returns workspace_required and the agent must call list_workspaces first.')
};
const accountSelectorInput = {
  accountId: optionalText(120).describe('Preferred account ID. Use IDs returned by list_accounts.'),
  accountName: optionalText(160).describe('Account name fallback. If ambiguous or not found, call list_accounts or upsert_account before retrying.')
};
const paymentMethodSelectorInput = {
  paymentMethodId: optionalText(120).describe('Preferred payment method ID from list_payment_methods.'),
  paymentMethodName: optionalText(160).describe('Payment method name fallback. If ambiguous or not found, call list_payment_methods or upsert_payment_method before retrying.')
};
const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date in YYYY-MM-DD format. Ask the user if missing or ambiguous.');
const currencyInput = z.string().regex(/^[A-Za-z]{3}$/).default('MXN').describe('ISO 4217 currency code. Defaults to MXN.');

const metadataFromAuth = (authContext) => ({
  clientId: authContext.clientId,
  scope: authContext.scope,
  resource: authContext.resource
});

const successResponse = ({ result, text }) => ({
  structuredContent: result,
  content: [
    {
      type: 'text',
      text
    }
  ]
});

const registerFinanceTool = (server, authContext, {
  name,
  config,
  handler,
  successText
}) => {
  server.registerTool(name, config, async (args = {}) => {
    logInfo(`mcp.tool.${name}.start`, {
      userId: authContext.userId,
      clientId: authContext.clientId,
      args
    });

    try {
      const result = await handler(args);

      logInfo(`mcp.tool.${name}.success`, {
        userId: authContext.userId,
        clientId: authContext.clientId,
        workspaceId: result.workspaceId || '',
        documentId: result.documentId || result.movementId || '',
        action: result.action
      });

      return successResponse({
        result,
        text: successText(result)
      });
    } catch (error) {
      logError(`mcp.tool.${name}.error`, error, {
        userId: authContext.userId,
        clientId: authContext.clientId,
        args
      });

      return toMcpToolError(error);
    }
  });
};

const registerFinanceTools = (server, { authContext }) => {
  registerFinanceTool(server, authContext, {
    name: 'create_workspace',
    config: {
      title: 'Create workspace',
      description: 'Creates a personal or business workspace. Use this when the user wants to separate finances by personal life, business, project, or company. After creating it, use the returned workspaceId in finance tools.',
      inputSchema: {
        name: z.string().min(1).max(160).describe('Workspace name, such as Personal, Mi negocio, or Consultoria.'),
        type: z.enum(['personal', 'business']).default('personal').describe('Workspace type. Use business for micro-business use cases.'),
        currency: currencyInput,
        description: optionalText(500)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.createWorkspace({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `Workspace creado: ${result.workspace?.name || result.workspaceId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'list_workspaces',
    config: {
      title: 'List workspaces',
      description: 'Lists the workspaces available to the authenticated user. Call this before finance actions when workspaceId is missing and the user may have more than one workspace. Show the options and ask which workspace to use.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: () => financeService.listWorkspaces({
      userId: authContext.userId,
      authContext
    }),
    successText: (result) => `${result.workspaces.length} workspace(s) disponibles.`
  });

  registerFinanceTool(server, authContext, {
    name: 'add_workspace_member',
    config: {
      title: 'Add workspace member',
      description: 'Adds or updates an existing MCP user as a member of a workspace. The member must already have signed in to this MCP with Google at least once, because users are identified by Firebase Auth UID. Prefer memberEmail when the UID is unknown. Always choose the member permissions intentionally: accessLevel=read grants read-only finance visibility, accessLevel=write grants write actions without list/read tools, accessLevel=read_write grants common personal-finance read and write tools, and accessLevel=custom uses the exact scopes array. To let a member manage members, explicitly include members:read and members:write in scopes. If the target user is not found, tell them to connect the MCP with Google first, then retry.',
      inputSchema: {
        ...workspaceIdInput,
        memberUserId: optionalText(120).describe('Firebase UID of the user to add. Use only if known.'),
        memberEmail: optionalText(320).describe('Google email used by the member when they signed in to this MCP. Preferred when UID is unknown.'),
        accessLevel: z.enum(['read', 'write', 'read_write', 'custom']).default('read_write').describe('Permission preset. Use custom only when providing explicit scopes.'),
        scopes: z.array(scopeInput).optional().describe(`Exact workspace scopes for custom or advanced access. Allowed: ${FINANCE_SCOPES.join(', ')}.`),
        role: z.enum(['viewer', 'member', 'admin']).default('member').describe('Human-readable role label. Actual permissions are enforced by scopes.'),
        notes: optionalText(500)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.addWorkspaceMember({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `Miembro ${result.created ? 'agregado' : 'actualizado'}: ${result.member?.email || result.memberUserId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'list_workspace_members',
    config: {
      title: 'List workspace members',
      description: 'Lists members of a workspace and their workspace-level scopes. Use this before adding/updating a member when you need to inspect existing access, or when a tool returns workspace_scope_denied and the user wants to know who has access. If workspaceId is missing and the user has multiple workspaces, call list_workspaces first and ask which workspace to inspect.',
      inputSchema: {
        ...workspaceIdInput,
        includeInactive: z.boolean().default(false).describe('Whether to include inactive members. Defaults to false.')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.listWorkspaceMembers({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `${result.count} miembro(s) en ${result.workspace?.name || result.workspaceId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'upsert_account',
    config: {
      title: 'Create or update account',
      description: 'Creates or updates a financial account/balance container in a workspace. Accounts represent where money lives or debt is tracked: bank account, cash, wallet, credit card, investment, loan, or other. Cash/efectivo should be modeled as an account with type=cash, usually named Efectivo. Call this before recording movements if the needed account does not exist.',
      inputSchema: {
        ...workspaceIdInput,
        accountId: optionalText(120).describe('Account ID to update. Omit to create or update by unique name.'),
        name: z.string().min(1).max(160).describe('Account name, such as BBVA, Mercado Pago, Efectivo, or BBVA Tarjeta Credito.'),
        type: z.enum(['bank', 'cash', 'wallet', 'credit_card', 'investment', 'loan', 'other']).default('bank'),
        currency: currencyInput,
        balance: moneyInput.optional().describe('Current account balance. Omit it when updating metadata without changing balance. Can be negative for debt or loans. New accounts default to 0 when omitted.'),
        institution: optionalText(160),
        description: optionalText(500),
        active: z.boolean().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.upsertAccount({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `Cuenta lista: ${result.account?.name || result.accountId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'list_accounts',
    config: {
      title: 'List accounts',
      description: 'Lists accounts in a workspace. Call this when an account is missing, ambiguous, or before writing a movement if you only know an account name. Never guess account IDs when multiple accounts could match.',
      inputSchema: {
        ...workspaceIdInput
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.listAccounts({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `${result.accounts.length} cuenta(s) disponibles.`
  });

  registerFinanceTool(server, authContext, {
    name: 'upsert_payment_method',
    config: {
      title: 'Create or update payment method',
      description: 'Creates or updates a payment method inside an account. Payment methods are sub-documents of accounts, such as debit card, credit card, bank transfer, SPEI, or wallet balance. Do not create or use a payment method just because the user paid in cash; for cash payments, use an Efectivo account with type=cash and omit paymentMethodId/paymentMethodName. If accountId is unknown, call list_accounts first.',
      inputSchema: {
        ...workspaceIdInput,
        ...accountSelectorInput,
        paymentMethodId: optionalText(120).describe('Payment method ID to update. Omit to create or update by unique name inside the account.'),
        name: z.string().min(1).max(160).describe('Payment method name, such as Debito BBVA, Credito BBVA, SPEI, or Saldo Mercado Pago.'),
        type: z.enum(['debit_card', 'credit_card', 'cash', 'bank_transfer', 'spei', 'wallet_balance', 'other']).default('debit_card'),
        last4: optionalText(4).describe('Last 4 digits, only when known.'),
        network: optionalText(80).describe('Card network or payment network, such as Visa, Mastercard, or SPEI.'),
        description: optionalText(500),
        active: z.boolean().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.upsertPaymentMethod({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `Metodo de pago listo: ${result.paymentMethod?.name || result.paymentMethodId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'list_payment_methods',
    config: {
      title: 'List payment methods',
      description: 'Lists payment methods for one account. Call this when the user mentions a card or payment method but the ID is unknown. If accountId is unknown, call list_accounts first.',
      inputSchema: {
        ...workspaceIdInput,
        ...accountSelectorInput
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.listPaymentMethods({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `${result.paymentMethods.length} metodo(s) de pago disponibles.`
  });

  registerFinanceTool(server, authContext, {
    name: 'create_expense',
    config: {
      title: 'Create expense',
      description: 'Registers an expense and subtracts it from the selected account balance. Required: amount, merchant, category, date, currency, and accountId or accountName. If the user paid in cash, use the cash account (usually accountName=Efectivo, type=cash) and omit paymentMethodId/paymentMethodName. Do not use paymentMethodName as a substitute for accountName. If workspaceId is missing and there are multiple workspaces, call list_workspaces first. If the account is unknown, call list_accounts or upsert_account. If a non-cash payment method is unknown, call list_payment_methods or upsert_payment_method. Ask the user for missing or ambiguous required fields before calling.',
      inputSchema: {
        ...workspaceIdInput,
        amount: moneyInput.describe('Expense amount as a positive number.'),
        merchant: z.string().min(1).max(160).describe('Merchant/place where the expense happened.'),
        category: z.string().min(1).max(80).describe('Expense category, such as comida, cafe, transporte, salud, servicios.'),
        date: dateInput,
        currency: currencyInput,
        ...accountSelectorInput,
        ...paymentMethodSelectorInput,
        description: optionalText(260),
        notes: optionalText(500),
        idempotencyKey: optionalText(260).describe('Optional unique key for retry-safe writes. Reuse only for the exact same movement retry.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.createExpense({
      userId: authContext.userId,
      authContext,
      payload: args,
      metadata: metadataFromAuth(authContext)
    }),
    successText: (result) => `Gasto registrado con ID ${result.movementId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'create_income',
    config: {
      title: 'Create income',
      description: 'Registers income and adds it to the selected account balance. Required: amount, category, date, currency, and accountId/accountName. If the account is unknown, call list_accounts or upsert_account first. Ask the user for missing source/category/account details before calling.',
      inputSchema: {
        ...workspaceIdInput,
        amount: moneyInput.describe('Income amount as a positive number.'),
        sourceName: optionalText(160).describe('Income source, such as employer, client, refund, or interest.'),
        category: z.string().min(1).max(80).describe('Income category, such as sueldo, venta, reembolso, inversion.'),
        date: dateInput,
        currency: currencyInput,
        ...accountSelectorInput,
        description: optionalText(260),
        notes: optionalText(500),
        idempotencyKey: optionalText(260)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.createIncome({
      userId: authContext.userId,
      authContext,
      payload: args,
      metadata: metadataFromAuth(authContext)
    }),
    successText: (result) => `Ingreso registrado con ID ${result.movementId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'create_transfer',
    config: {
      title: 'Create transfer',
      description: 'Moves money between two accounts and updates both balances. Use this for bank-to-wallet transfers and ATM withdrawals. For ATM withdrawal, model it as fromAccount=bank and toAccount=Efectivo/cash. Required: amount, date, currency, fromAccountId/fromAccountName, toAccountId/toAccountName. If either account is unknown, call list_accounts or upsert_account first. Never use the same account as origin and destination.',
      inputSchema: {
        ...workspaceIdInput,
        amount: moneyInput.describe('Transfer amount as a positive number.'),
        date: dateInput,
        currency: currencyInput,
        fromAccountId: optionalText(120).describe('Origin account ID.'),
        fromAccountName: optionalText(160).describe('Origin account name fallback.'),
        toAccountId: optionalText(120).describe('Destination account ID.'),
        toAccountName: optionalText(160).describe('Destination account name fallback.'),
        category: optionalText(80).describe('Optional category. Defaults to transfer.'),
        description: optionalText(260),
        notes: optionalText(500),
        idempotencyKey: optionalText(260)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.createTransfer({
      userId: authContext.userId,
      authContext,
      payload: args,
      metadata: metadataFromAuth(authContext)
    }),
    successText: (result) => `Transferencia registrada con ID ${result.movementId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'set_account_balance',
    config: {
      title: 'Set account balance',
      description: 'Sets an account balance to an exact amount and records a balance_adjustment movement for auditability. Use this when the user says the current balance of an account. If account is unknown, call list_accounts first. This changes the account balance by the difference between current and target balance.',
      inputSchema: {
        ...workspaceIdInput,
        ...accountSelectorInput,
        balance: moneyInput.describe('Target account balance. Can be negative for debt or credit cards.'),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Optional currency. If provided, it must match the account currency.'),
        date: dateInput,
        description: optionalText(260),
        notes: optionalText(500),
        idempotencyKey: optionalText(260)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.setAccountBalance({
      userId: authContext.userId,
      authContext,
      payload: args,
      metadata: metadataFromAuth(authContext)
    }),
    successText: (result) => `Saldo actualizado con movimiento ${result.movementId}.`
  });

  registerFinanceTool(server, authContext, {
    name: 'list_movements',
    config: {
      title: 'List movements',
      description: 'Lists financial movements for a workspace and date range. Use this for monthly, weekly, daily, annual, or custom queries. If workspaceId is missing and there are multiple workspaces, call list_workspaces first. Use accountId/accountName, type, and category filters when needed. Returns movements and summary totals.',
      inputSchema: {
        ...workspaceIdInput,
        period: z.enum(['today', 'week', 'month', 'year', 'custom']).default('month').describe('Date period to query. For custom, provide startDate and endDate.'),
        referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Reference date for today/week/month/year. Use current user-relevant date when possible.'),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        type: z.enum(['expense', 'income', 'transfer', 'balance_adjustment']).optional(),
        accountId: optionalText(120),
        accountName: optionalText(160),
        category: optionalText(80),
        limit: z.number().int().min(1).max(100).default(50)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: (args) => financeService.listMovements({
      userId: authContext.userId,
      authContext,
      payload: args
    }),
    successText: (result) => `${result.count} movimiento(s) encontrados.`
  });
};

module.exports = {
  registerFinanceTools
};
