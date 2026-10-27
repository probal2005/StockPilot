import express from 'express';
import helmet from 'helmet';
import { HOST, PORT } from './config/env.js';
import { checkDatabase, closeDatabase } from './db/database.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '1mb', strict: true }));

app.get('/', (_req, res) => {
  res.status(200).json({
    name: 'StockPilot Separate Backend',
    status: 'running',
    health: '/api/health',
    authentication: '/api/auth',
    database: 'SQLite',
  });
});

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }

  console.error('API error:', err.message);

  return res.status(err.status && err.status < 500 ? err.status : 500).json({
    error: err.status && err.status < 500
      ? err.message
      : 'Internal server error',
  });
});

const server = app.listen(PORT, HOST, () => {
  let databaseStatus = 'Disconnected';

  try {
    databaseStatus = checkDatabase() ? 'Connected' : 'Disconnected';
  } catch (error) {
    console.error('SQLite connection check failed:', error.message);
  }

  console.log('');
  console.log('========================================');
  console.log(' StockPilot Separate Backend');
  console.log('========================================');
  console.log(` Local URL: http://${HOST}:${PORT}`);
  console.log(` Health:    http://${HOST}:${PORT}/api/health`);
  console.log(` Database:  ${databaseStatus}`);
  console.log('========================================');
  console.log('');
});

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);

  server.close((error) => {
    try {
      closeDatabase();
    } catch (databaseError) {
      console.error('Database shutdown error:', databaseError.message);
      process.exitCode = 1;
    }

    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
