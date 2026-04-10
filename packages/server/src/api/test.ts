import { Router } from 'express';
import { getConnectionManager, type ServiceName } from '../connections/manager.js';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';

const router = Router();

// SSE endpoint — streams the 3 test steps in real time
router.get('/:service', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const service = (req.params['service'] as string) as ServiceName;

  if (!['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar'].includes(service)) {
    res.status(400).json({ error: 'Unknown service' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const manager = getConnectionManager();

  try {
    for await (const step of manager.runTest(service)) {
      send(step);
    }
    send({ done: true });
  } catch (e) {
    send({ error: e instanceof Error ? e.message : String(e) });
  }

  writeAuditLog('test', authedReq.actor, {
    service,
    apiKeyId: authedReq.apiKey?.id,
  });

  res.end();
});

export default router;
