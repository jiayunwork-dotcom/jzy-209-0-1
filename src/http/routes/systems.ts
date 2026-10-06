import type { FastifyInstance } from 'fastify';
import type { Store } from '../../storage/store';
import type { SystemVersionInput } from '../../types';
import { assertValidSystem, ValidationError } from '../../validation/validate';

export function registerSystemRoutes(app: FastifyInstance, store: Store): void {
  // Start a new system with version 1.
  app.post('/systems', async (req, reply) => {
    const body = req.body as SystemVersionInput;
    const issues = assertOr400(body);
    if (issues) return reply.status(400).send({ error: 'validation_error', issues });
    const version = await store.createVersion({ input: body });
    return reply.status(201).send(version);
  });

  // Append a version to an existing system.
  app.post('/systems/:systemId/versions', async (req, reply) => {
    const { systemId } = req.params as { systemId: string };
    const body = req.body as SystemVersionInput;
    const issues = assertOr400(body);
    if (issues) return reply.status(400).send({ error: 'validation_error', issues });
    const version = await store.createVersion({ systemId, input: body });
    return reply.status(201).send(version);
  });

  app.get('/systems/:systemId/versions', async (req) => {
    const { systemId } = req.params as { systemId: string };
    const versions = await store.listVersions(systemId);
    return { systemId, versions };
  });

  app.get('/versions', async () => {
    const versions = await store.listVersions();
    return { versions };
  });

  app.get('/versions/:versionId', async (req, reply) => {
    const { versionId } = req.params as { versionId: string };
    const version = await store.getVersion(versionId);
    if (!version) return reply.status(404).send({ error: 'not_found', message: `unknown version ${versionId}` });
    return version;
  });
}

function assertOr400(body: SystemVersionInput): string[] | null {
  try {
    assertValidSystem(body);
    return null;
  } catch (e) {
    if (e instanceof ValidationError) return e.issues;
    throw e;
  }
}
