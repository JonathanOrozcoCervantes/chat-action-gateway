const AppError = require('./AppError');

const createAgentError = ({
  statusCode = 400,
  code,
  message,
  agentAction,
  missingFields = [],
  suggestedTool = '',
  details = {}
}) => new AppError({
  statusCode,
  code,
  message,
  details: {
    agentAction,
    missingFields,
    suggestedTool,
    ...details
  }
});

const toAgentErrorPayload = (error) => {
  const details = error?.details && typeof error.details === 'object'
    ? error.details
    : {};

  return {
    ok: false,
    error: {
      code: error?.code || 'tool_failed',
      message: error?.message || 'The tool could not complete the request.',
      agentAction: details.agentAction || 'Explain the failure to the user and ask for the missing or corrected information before retrying.',
      missingFields: Array.isArray(details.missingFields) ? details.missingFields : [],
      suggestedTool: details.suggestedTool || '',
      details
    }
  };
};

const toMcpToolError = (error) => {
  const payload = toAgentErrorPayload(error);
  const { code, message, agentAction, suggestedTool } = payload.error;
  const nextStep = suggestedTool
    ? `${agentAction} Suggested tool: ${suggestedTool}.`
    : agentAction;

  return {
    isError: true,
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: `Tool error (${code}): ${message}\nAgent action: ${nextStep}`
      }
    ]
  };
};

module.exports = {
  createAgentError,
  toAgentErrorPayload,
  toMcpToolError
};
