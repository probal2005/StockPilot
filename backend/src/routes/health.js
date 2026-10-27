import { Router } from 'express';
import { checkDatabase } from '../db/database.js';

const router = Router();

router.get('/', (_req, res) => {
  try {
    const connected = checkDatabase();

    res.status(connected ? 200 : 503).json({
      status: connected ? 'ok' : 'error',
      service: 'StockPilot Separate Backend',
      version: '1.0.0',
      database: connected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'StockPilot Separate Backend',
      version: '1.0.0',
      database: 'disconnected',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
