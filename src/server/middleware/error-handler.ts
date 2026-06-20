import { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
}

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const statusCode = error.statusCode || 500;

  // 4xx are deliberate client errors (validation, bad input) whose messages are
  // safe and useful. 5xx are unexpected: the message can carry stack/DB/internal
  // detail, so return a generic body and keep the detail in the server log only.
  const isServerError = statusCode >= 500;
  const response: ErrorResponse = {
    statusCode,
    error: isServerError ? "Internal Server Error" : error.name,
    message: isServerError ? "Internal Server Error" : error.message,
    timestamp: new Date().toISOString()
  };

  request.log.error({
    err: error,
    statusCode,
    method: request.method,
    url: request.url
  });

  reply.status(statusCode).send(response);
}
