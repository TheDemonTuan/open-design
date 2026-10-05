import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DeploymentLifecycle,
  DeploymentConflictError,
  DeploymentMaintenanceError,
} from '../src/deployment-lifecycle.js';

describe('DeploymentLifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-deploy-lifecycle-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('starts in open phase and idle when no runs or operations exist', () => {
    const lifecycle = new DeploymentLifecycle({ runtimeDataDir: tmpDir });
    const status = lifecycle.getStatus();
    expect(status.phase).toBe('open');
    expect(status.accepting).toBe(true);
    expect(status.operationId).toBeNull();
    expect(status.activeRuns).toBe(0);
    expect(status.activeOperations).toBe(0);
    expect(status.activeClientTurns).toBe(0);
    expect(status.idle).toBe(true);
  });

  it('fences and transitions to draining idempotently', () => {
    const lifecycle = new DeploymentLifecycle({ runtimeDataDir: tmpDir });
    const s1 = lifecycle.fence('op-123');
    expect(s1.phase).toBe('draining');
    expect(s1.operationId).toBe('op-123');
    expect(s1.accepting).toBe(false);

    // Idempotent with same opId
    const s2 = lifecycle.fence('op-123');
    expect(s2.phase).toBe('draining');

    // Conflict with different opId
    expect(() => lifecycle.fence('op-999')).toThrow(DeploymentConflictError);

    // Invalid opId format
    expect(() => lifecycle.fence('bad/id')).toThrow(DeploymentConflictError);
  });

  it('rejects quiesce when operations or runs are active', async () => {
    let runsCount = 1;
    const lifecycle = new DeploymentLifecycle({
      runtimeDataDir: tmpDir,
      getActiveRunsCount: () => runsCount,
    });

    lifecycle.fence('op-1');
    expect(() => lifecycle.quiesce('op-1')).toThrow(DeploymentConflictError);

    runsCount = 0;
    const s = lifecycle.quiesce('op-1');
    expect(s.phase).toBe('quiesced');
    expect(s.idle).toBe(true);
  });

  it('resumes and cleans up fence file', () => {
    const lifecycle = new DeploymentLifecycle({ runtimeDataDir: tmpDir });
    lifecycle.fence('op-1');
    expect(fs.existsSync(path.join(tmpDir, 'deployment-fence.json'))).toBe(true);

    const s = lifecycle.resume('op-1');
    expect(s.phase).toBe('open');
    expect(s.operationId).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'deployment-fence.json'))).toBe(false);
  });

  it('rejects withOperation when in maintenance', async () => {
    const lifecycle = new DeploymentLifecycle({ runtimeDataDir: tmpDir });
    lifecycle.fence('op-1');
    await expect(lifecycle.withOperation(async () => 'ok')).rejects.toThrow(DeploymentMaintenanceError);
  });

  it('tracks client turn leases and persists them', () => {
    const lifecycle = new DeploymentLifecycle({ runtimeDataDir: tmpDir });
    const lease = lifecycle.createClientTurn('p-1', {
      conversationId: 'c-1',
      clientTurnId: 'turn-1',
    });

    expect(lease.clientTurnId).toBe('turn-1');
    expect(lease.proxyStarted).toBe(false);

    const status1 = lifecycle.getStatus();
    expect(status1.activeClientTurns).toBe(1);
    expect(status1.idle).toBe(false);

    lifecycle.markProxyStarted(lease.leaseId);

    // Reload lifecycle from same dir
    const reloaded = new DeploymentLifecycle({ runtimeDataDir: tmpDir });
    const list = reloaded.listClientTurns('p-1', 'c-1');
    expect(list.length).toBe(1);
    expect(list[0]?.proxyStarted).toBe(true);

    const completed = reloaded.completeClientTurn(lease.leaseId);
    expect(completed).toBe(true);
    expect(reloaded.getStatus().activeClientTurns).toBe(0);
    expect(reloaded.getStatus().idle).toBe(true);
  });
});
