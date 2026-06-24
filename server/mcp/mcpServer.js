const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const expenseService = require('../services/expenseService');
const { randomToken } = require('../utils/security');
const { logError, logInfo } = require('../utils/logger');

const createExpenseToolInput = {
  amount: z.number().positive().describe('Expense amount as a positive number.'),
  merchant: z.string().min(1).max(160).describe('Merchant or place where the expense happened.'),
  category: z.string().min(1).max(80).describe('Expense category, such as comida, cafe, transporte, salud, or servicios.'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Expense date in YYYY-MM-DD format.'),
  currency: z.string().regex(/^[A-Za-z]{3}$/).default('MXN').describe('ISO 4217 currency code. Defaults to MXN.'),
  description: z.string().max(260).optional().describe('Short description of the expense.'),
  paymentMethod: z.string().max(80).optional().describe('Payment method, if known.'),
  notes: z.string().max(500).optional().describe('Additional notes.'),
  idempotencyKey: z.string().max(260).optional().describe('Optional unique key for retry-safe writes.')
};

const createExpenseToolOutput = {
  action: z.string(),
  userId: z.string(),
  documentId: z.string(),
  idempotencyKey: z.string()
};

const createMcpServer = ({ authContext }) => {
  const server = new McpServer({
    name: 'chat-action-gateway',
    version: '0.1.0'
  });

  server.registerTool(
    'create_expense',
    {
      title: 'Create expense',
      description: 'Creates an expense for the authenticated user. Ask the user for any missing amount, merchant, category, date, currency, or payment details before calling this tool.',
      inputSchema: createExpenseToolInput,
      outputSchema: createExpenseToolOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const idempotencyKey = args.idempotencyKey || `mcp-${randomToken(18)}`;

      logInfo('mcp.tool.create_expense.start', {
        userId: authContext.userId,
        clientId: authContext.clientId,
        merchant: args.merchant,
        amount: args.amount,
        category: args.category,
        date: args.date,
        currency: args.currency || 'MXN',
        idempotencyKey
      });

      try {
        const result = await expenseService.createExpenseForUser({
          userId: authContext.userId,
          tokenHash: authContext.actionTokenHash,
          payload: {
            amount: args.amount,
            merchant: args.merchant,
            category: args.category,
            date: args.date,
            currency: args.currency || 'MXN',
            description: args.description || '',
            paymentMethod: args.paymentMethod || '',
            notes: args.notes || '',
            idempotencyKey
          },
          metadata: {
            clientId: authContext.clientId,
            scope: authContext.scope,
            resource: authContext.resource
          },
          source: 'chat-action-gateway-mcp',
          authType: 'oauth-bearer'
        });

        logInfo('mcp.tool.create_expense.success', {
          userId: authContext.userId,
          clientId: authContext.clientId,
          documentId: result.documentId,
          idempotencyKey
        });

        return {
          content: [
            {
              type: 'text',
              text: `Gasto registrado correctamente con ID ${result.documentId}.`
            }
          ],
          structuredContent: result
        };
      } catch (error) {
        logError('mcp.tool.create_expense.error', error, {
          userId: authContext.userId,
          clientId: authContext.clientId,
          idempotencyKey
        });

        throw error;
      }
    }
  );

  return server;
};

module.exports = {
  createMcpServer
};
