import { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
}

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const statusCode = error.statusCode || 500;
  const response: ErrorResponse = {
    statusCode,
    error: error.name,
    message: error.message,
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
