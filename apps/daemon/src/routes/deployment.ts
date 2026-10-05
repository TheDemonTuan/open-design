import type { Express, Request, Response } from 'express';
import type {
  DeploymentFenceRequest,
  DesignTurnCreateRequest,
  DesignTurnCompleteRequest,
} from '@open-design/contracts/api/deployment';
import {
  DeploymentLifecycle,
  DeploymentMaintenanceError,
  DeploymentConflictError,
  DeploymentForbiddenError,
} from '../deployment-lifecycle.js';
import { sendApiError } from '../http/api-errors.js';
import { getProject, type SqliteDb } from '../db.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';

export interface RegisterDeploymentRoutesDeps {
  db: SqliteDb;
  deploymentLifecycle: DeploymentLifecycle;
  authorizeProjectRequest: AuthorizeProjectRequest;
}

export function registerDeploymentRoutes(
  app: Express,
  deps: RegisterDeploymentRoutesDeps,
): void {
  const { db, deploymentLifecycle, authorizeProjectRequest } = deps;

  const requireLocalOnly = (req: Request, res: Response): boolean => {
    if (!deploymentLifecycle.validateLocalRequest(req)) {
      sendApiError(
        res,
        403,
        'FORBIDDEN',
        'Deployment endpoints are local-only.',
        { details: { reason: 'DEPLOYMENT_LOCAL_ONLY' } },
      );
      return false;
    }
    return true;
  };

  app.get('/api/deployment/status', (req: Request, res: Response) => {
    if (!requireLocalOnly(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(deploymentLifecycle.getStatus());
  });

  app.post('/api/deployment/fence', (req: Request, res: Response) => {
    if (!requireLocalOnly(req, res)) return;
    const body = req.body as Partial<DeploymentFenceRequest> | undefined;
    const operationId = body?.operationId;
    if (typeof operationId !== 'string' || !operationId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'operationId is required');
    }

    try {
      const status = deploymentLifecycle.fence(operationId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(status);
    } catch (err: unknown) {
      if (err instanceof DeploymentConflictError) {
        return sendApiError(res, err.status, 'CONFLICT', err.message);
      }
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to fence');
    }
  });

  app.post('/api/deployment/quiesce', (req: Request, res: Response) => {
    if (!requireLocalOnly(req, res)) return;
    const body = req.body as Partial<DeploymentFenceRequest> | undefined;
    const operationId = body?.operationId;
    if (typeof operationId !== 'string' || !operationId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'operationId is required');
    }

    try {
      const status = deploymentLifecycle.quiesce(operationId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(status);
    } catch (err: unknown) {
      if (err instanceof DeploymentConflictError) {
        return sendApiError(res, err.status, 'CONFLICT', err.message);
      }
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to quiesce');
    }
  });

  app.post('/api/deployment/resume', (req: Request, res: Response) => {
    if (!requireLocalOnly(req, res)) return;
    const body = req.body as Partial<DeploymentFenceRequest> | undefined;
    const operationId = body?.operationId;
    if (typeof operationId !== 'string' || !operationId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'operationId is required');
    }

    try {
      const status = deploymentLifecycle.resume(operationId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(status);
    } catch (err: unknown) {
      if (err instanceof DeploymentConflictError) {
        return sendApiError(res, err.status, 'CONFLICT', err.message);
      }
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to resume');
    }
  });

  // Client Design Turns API
  app.post('/api/projects/:id/design-turns', async (req: Request, res: Response) => {
    const projectId = req.params.id;
    if (typeof projectId !== 'string' || !projectId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Project ID required');
    }

    const project = getProject(db, projectId);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    }

    const authorized = await authorizeProjectRequest(req, res, project.id, { mode: 'write', capability: 'writeFiles' });
    if (!authorized) return;

    if (!deploymentLifecycle.isAccepting()) {
      res.setHeader('Retry-After', '30');
      return sendApiError(
        res,
        503,
        'UPSTREAM_UNAVAILABLE',
        'Design server is in maintenance; retry after deployment.',
      );
    }

    const body = req.body as Partial<DesignTurnCreateRequest> | undefined;
    const conversationId = body?.conversationId;
    const clientTurnId = body?.clientTurnId;

    if (typeof conversationId !== 'string' || !conversationId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'conversationId is required');
    }
    if (typeof clientTurnId !== 'string' || !clientTurnId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'clientTurnId is required');
    }

    try {
      const lease = deploymentLifecycle.createClientTurn(
        project.id,
        { conversationId, clientTurnId },
      );
      res.json(lease);
    } catch (err: unknown) {
      if (err instanceof DeploymentMaintenanceError) {
        res.setHeader('Retry-After', '30');
        return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', err.message);
      }
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to create client turn');
    }
  });

  app.get('/api/projects/:id/design-turns', async (req: Request, res: Response) => {
    const projectId = req.params.id;
    if (typeof projectId !== 'string' || !projectId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Project ID required');
    }

    const project = getProject(db, projectId);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    }

    const authorized = await authorizeProjectRequest(req, res, project.id, { mode: 'read' });
    if (!authorized) return;

    const conversationId = typeof req.query.conversationId === 'string'
      ? req.query.conversationId
      : undefined;

    const leases = deploymentLifecycle.listClientTurns(project.id, conversationId);
    res.json({ leases });
  });

  app.post('/api/projects/:id/design-turns/:leaseId/complete', async (req: Request, res: Response) => {
    const projectId = req.params.id;
    const leaseId = req.params.leaseId;
    if (typeof projectId !== 'string' || !projectId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Project ID required');
    }
    if (typeof leaseId !== 'string' || !leaseId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'leaseId required');
    }

    const project = getProject(db, projectId);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    }

    const authorized = await authorizeProjectRequest(req, res, project.id, { mode: 'write', capability: 'writeFiles' });
    if (!authorized) return;

    const body = req.body as Partial<DesignTurnCompleteRequest> | undefined;
    const completed = deploymentLifecycle.completeClientTurn(leaseId, body);
    if (!completed) {
      return sendApiError(res, 404, 'NOT_FOUND', 'Lease not found');
    }

    res.json({ ok: true });
  });
}
