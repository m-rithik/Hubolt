-- Rename LLMGatewayRequest to GatewayLog for cleaner camelCase
ALTER TABLE IF EXISTS "llm_gateway_requests" RENAME TO "gateway_logs";
