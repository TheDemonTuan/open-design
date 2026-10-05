import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  DEPLOYMENT_SCHEMA_VERSION,
  type DeploymentPhase,
  type DeploymentStatus,
  type DesignTurnCreateRequest,
  type DesignTurnLease,
  type DesignTurnCompleteRequest,
} from '@open-design/contracts/api/deployment';
import { isLoopbackPeerAddress } from './http/local-daemon-request.js';

const OPERATION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

interface PersistedFence {
  schemaVersion: 1;
  operationId: string;
  phase: 'draining' | 'quiesced';
}

interface PersistedClientTurn extends DesignTurnLease {
  projectId: string;
  workspaceId?: string;
  createdAt: string;
}

interface PersistedClientTurnsFile {
  schemaVersion: 1;
  leases: PersistedClientTurn[];
}

export class DeploymentMaintenanceError extends Error {
  readonly code = 'DEPLOYMENT_MAINTENANCE';
  readonly status = 503;
  constructor(message = 'Design server is in maintenance; retry after deployment.') {
    super(message);
    this.name = 'DeploymentMaintenanceError';
  }
}

export class DeploymentConflictError extends Error {
  readonly code: string;
  readonly status = 409;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DeploymentConflictError';
    this.code = code;
  }
}

export class DeploymentForbiddenError extends Error {
  readonly code = 'DEPLOYMENT_LOCAL_ONLY';
  readonly status = 403;
  constructor(message = 'Deployment endpoints are local-only.') {
    super(message);
    this.name = 'DeploymentForbiddenError';
  }
}

export interface DeploymentLifecycleOptions {
  runtimeDataDir: string;
  getActiveRunsCount?: () => number;
}

export class DeploymentLifecycle {
  private readonly dataDir: string;
  private readonly fenceFilePath: string;
  private readonly clientTurnsFilePath: string;
  private readonly getActiveRunsCount: () => number;

  private phase: DeploymentPhase = 'open';
  private operationId: string | null = null;
  private corruptFence = false;
  private activeOperationsCount = 0;
  private readonly clientTurns = new Map<string, PersistedClientTurn>();

  constructor(options: DeploymentLifecycleOptions) {
    this.dataDir = options.runtimeDataDir;
    this.fenceFilePath = path.join(this.dataDir, 'deployment-fence.json');
    this.clientTurnsFilePath = path.join(this.dataDir, 'deployment-client-turns.json');
    this.getActiveRunsCount = options.getActiveRunsCount ?? (() => 0);

    this.loadStateOnBoot();
  }

  private loadStateOnBoot(): void {
    if (fs.existsSync(this.fenceFilePath)) {
      try {
        const raw = fs.readFileSync(this.fenceFilePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedFence;
        if (
          parsed &&
          parsed.schemaVersion === 1 &&
          typeof parsed.operationId === 'string' &&
          (parsed.phase === 'draining' || parsed.phase === 'quiesced')
        ) {
          this.operationId = parsed.operationId;
          // Booting while fenced maintains quiesced state to prevent accepting new work
          this.phase = parsed.phase === 'draining' ? 'draining' : 'quiesced';
        } else {
          this.corruptFence = true;
          this.phase = 'quiesced';
        }
      } catch {
        this.corruptFence = true;
        this.phase = 'quiesced';
      }
    }

    if (fs.existsSync(this.clientTurnsFilePath)) {
      try {
        const raw = fs.readFileSync(this.clientTurnsFilePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedClientTurnsFile;
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.leases)) {
          for (const item of parsed.leases) {
            if (item && item.leaseId && item.clientTurnId) {
              this.clientTurns.set(item.leaseId, item);
            }
          }
        } else {
          this.corruptFence = true;
          this.phase = 'quiesced';
        }
      } catch {
        this.corruptFence = true;
        this.phase = 'quiesced';
      }
    }
  }

  private persistFence(): void {
    if (this.phase === 'open') {
      try {
        if (fs.existsSync(this.fenceFilePath)) {
          fs.unlinkSync(this.fenceFilePath);
        }
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err) {
          if (err.code !== 'ENOENT') throw err;
        } else {
          throw err;
        }
      }
      return;
    }

    const payload: PersistedFence = {
      schemaVersion: 1,
      operationId: this.operationId!,
      phase: this.phase as 'draining' | 'quiesced',
    };

    const tempPath = `${this.fenceFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tempPath, this.fenceFilePath);
  }

  private persistClientTurns(): void {
    const payload: PersistedClientTurnsFile = {
      schemaVersion: 1,
      leases: Array.from(this.clientTurns.values()),
    };

    const tempPath = `${this.clientTurnsFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tempPath, this.clientTurnsFilePath);
  }

  public getStatus(): DeploymentStatus {
    const activeRuns = this.getActiveRunsCount();
    const activeOperations = this.activeOperationsCount;
    const activeClientTurns = this.clientTurns.size;
    const idle = activeRuns === 0 && activeOperations === 0 && activeClientTurns === 0;

    return {
      schemaVersion: 1,
      operationId: this.operationId,
      phase: this.phase,
      accepting: this.phase === 'open' && !this.corruptFence,
      activeRuns,
      activeOperations,
      activeClientTurns,
      idle,
    };
  }

  public isAccepting(): boolean {
    return this.phase === 'open' && !this.corruptFence;
  }

  public isMaintenance(): boolean {
    return this.phase !== 'open' || this.corruptFence;
  }

  public isCorrupt(): boolean {
    return this.corruptFence;
  }

  public getPhase(): DeploymentPhase {
    return this.phase;
  }

  public getOperationId(): string | null {
    return this.operationId;
  }

  public fence(operationId: string): DeploymentStatus {
    if (this.corruptFence) {
      throw new DeploymentConflictError('DEPLOYMENT_CORRUPT_FENCE', 'Deployment fence state is corrupt on disk.');
    }
    if (typeof operationId !== 'string' || !OPERATION_ID_REGEX.test(operationId)) {
      throw new DeploymentConflictError('INVALID_OPERATION_ID', 'Invalid operationId format.');
    }

    if (this.phase !== 'open') {
      if (this.operationId === operationId) {
        return this.getStatus(); // idempotent
      }
      throw new DeploymentConflictError(
        'DEPLOYMENT_FENCE_CONFLICT',
        `Deployment is already fenced with operationId=${this.operationId}`,
      );
    }

    this.operationId = operationId;
    this.phase = 'draining';
    this.persistFence();
    return this.getStatus();
  }

  public quiesce(operationId: string): DeploymentStatus {
    if (this.corruptFence) {
      throw new DeploymentConflictError('DEPLOYMENT_CORRUPT_FENCE', 'Deployment fence state is corrupt on disk.');
    }
    if (typeof operationId !== 'string' || !OPERATION_ID_REGEX.test(operationId)) {
      throw new DeploymentConflictError('INVALID_OPERATION_ID', 'Invalid operationId format.');
    }

    if (this.phase === 'open' || this.operationId !== operationId) {
      throw new DeploymentConflictError(
        'DEPLOYMENT_FENCE_CONFLICT',
        `Cannot quiesce: current operationId=${this.operationId}, expected=${operationId}`,
      );
    }

    const status = this.getStatus();
    if (!status.idle) {
      throw new DeploymentConflictError(
        'DEPLOYMENT_NOT_IDLE',
        `Cannot quiesce: server is not idle (runs=${status.activeRuns}, ops=${status.activeOperations}, turns=${status.activeClientTurns})`,
      );
    }

    this.phase = 'quiesced';
    this.persistFence();
    return this.getStatus();
  }

  public resume(operationId: string): DeploymentStatus {
    if (this.corruptFence) {
      throw new DeploymentConflictError('DEPLOYMENT_CORRUPT_FENCE', 'Deployment fence state is corrupt on disk.');
    }
    if (typeof operationId !== 'string' || !OPERATION_ID_REGEX.test(operationId)) {
      throw new DeploymentConflictError('INVALID_OPERATION_ID', 'Invalid operationId format.');
    }

    if (this.phase === 'open' && this.operationId === null) {
      return this.getStatus(); // no-op
    }

    if (this.operationId !== operationId) {
      throw new DeploymentConflictError(
        'DEPLOYMENT_FENCE_CONFLICT',
        `Cannot resume: current operationId=${this.operationId}, expected=${operationId}`,
      );
    }

    this.phase = 'open';
    this.operationId = null;
    this.persistFence();
    return this.getStatus();
  }

  public async withOperation<T>(work: () => Promise<T>): Promise<T> {
    if (!this.isAccepting()) {
      throw new DeploymentMaintenanceError();
    }
    this.activeOperationsCount++;
    try {
      return await work();
    } finally {
      this.activeOperationsCount--;
    }
  }

  public acquireOperationSync(): () => void {
    if (!this.isAccepting()) {
      throw new DeploymentMaintenanceError();
    }
    this.activeOperationsCount++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeOperationsCount--;
      }
    };
  }

  public createClientTurn(
    projectId: string,
    req: DesignTurnCreateRequest,
    workspaceId?: string,
  ): DesignTurnLease {
    if (!this.isAccepting()) {
      throw new DeploymentMaintenanceError();
    }

    // Check for existing turn with same clientTurnId in this conversation
    for (const existing of this.clientTurns.values()) {
      if (
        existing.projectId === projectId &&
        existing.conversationId === req.conversationId &&
        existing.clientTurnId === req.clientTurnId
      ) {
        return {
          leaseId: existing.leaseId,
          conversationId: existing.conversationId,
          clientTurnId: existing.clientTurnId,
          proxyStarted: existing.proxyStarted,
        };
      }
    }

    const leaseId = crypto.randomUUID();
    const newLease: PersistedClientTurn = {
      leaseId,
      projectId,
      conversationId: req.conversationId,
      clientTurnId: req.clientTurnId,
      ...(workspaceId ? { workspaceId } : {}),
      proxyStarted: false,
      createdAt: new Date().toISOString(),
    };

    this.clientTurns.set(leaseId, newLease);
    this.persistClientTurns();

    return {
      leaseId: newLease.leaseId,
      conversationId: newLease.conversationId,
      clientTurnId: newLease.clientTurnId,
      proxyStarted: newLease.proxyStarted,
    };
  }

  public listClientTurns(projectId: string, conversationId?: string): DesignTurnLease[] {
    const result: DesignTurnLease[] = [];
    for (const lease of this.clientTurns.values()) {
      if (lease.projectId === projectId) {
        if (!conversationId || lease.conversationId === conversationId) {
          result.push({
            leaseId: lease.leaseId,
            conversationId: lease.conversationId,
            clientTurnId: lease.clientTurnId,
            proxyStarted: lease.proxyStarted,
          });
        }
      }
    }
    return result;
  }

  public markProxyStarted(leaseId: string): void {
    const existing = this.clientTurns.get(leaseId);
    if (existing && !existing.proxyStarted) {
      existing.proxyStarted = true;
      this.persistClientTurns();
    }
  }

  public completeClientTurn(
    leaseId: string,
    _options?: DesignTurnCompleteRequest,
  ): boolean {
    const existing = this.clientTurns.get(leaseId);
    if (!existing) return false;

    this.clientTurns.delete(leaseId);
    this.persistClientTurns();
    return true;
  }

  public validateLocalRequest(req: Request): boolean {
    const remote = req.socket?.remoteAddress;
    if (!isLoopbackPeerAddress(remote)) return false;

    const origin = req.get('origin');
    if (origin !== undefined && origin.trim().length > 0) return false;

    return true;
  }
}
