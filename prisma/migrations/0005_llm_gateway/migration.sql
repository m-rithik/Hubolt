-- CreateTable ProviderCredential
CREATE TABLE "provider_credentials" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyHash" VARCHAR(100) NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable ModelRoute
CREATE TABLE "model_routes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "reviewScope" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "costLimit" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable LLMGatewayRequest
CREATE TABLE "llm_gateway_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "cachedResponse" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_gateway_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_orgId_provider_key" ON "provider_credentials"("orgId", "provider");

-- CreateIndex
CREATE INDEX "provider_credentials_keyHash_idx" ON "provider_credentials"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "model_routes_orgId_reviewScope_provider_key" ON "model_routes"("orgId", "reviewScope", "provider");

-- CreateIndex
CREATE INDEX "llm_gateway_requests_orgId_idx" ON "llm_gateway_requests"("orgId");

-- CreateIndex
CREATE INDEX "llm_gateway_requests_createdAt_idx" ON "llm_gateway_requests"("createdAt");

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
