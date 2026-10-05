/**
 * Deployment lifecycle & design turn lease contracts for OpenDesign.
 */

export const DEPLOYMENT_SCHEMA_VERSION = 1;

export type DeploymentPhase = 'open' | 'draining' | 'quiesced';

export interface DeploymentFenceRequest {
  operationId: string;
}

export interface DeploymentStatus {
  schemaVersion: 1;
  operationId: string | null;
  phase: DeploymentPhase;
  accepting: boolean;
  activeRuns: number;
  activeOperations: number;
  activeClientTurns: number;
  idle: boolean;
}

export interface DesignTurnCreateRequest {
  conversationId: string;
  clientTurnId: string;
}

export interface DesignTurnLease {
  leaseId: string;
  conversationId: string;
  clientTurnId: string;
  proxyStarted: boolean;
}

export interface DesignTurnCompleteRequest {
  discardPending?: boolean;
}

export interface DesignTurnListResponse {
  leases: DesignTurnLease[];
}
