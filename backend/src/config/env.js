import 'dotenv/config';
import path from 'node:path';

const rawPort = process.env.PORT || '8788';
const parsedPort = Number(rawPort);

if (
  !Number.isInteger(parsedPort) ||
  parsedPort < 1 ||
  parsedPort > 65535
) {
  throw new Error('PORT must be a valid integer between 1 and 65535.');
}

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = parsedPort;

if (NODE_ENV !== 'development' && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  throw new Error(
    'This separate backend is configured for local use only. HOST must be 127.0.0.1 or localhost.'
  );
}

export const DATABASE_PATH = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH || './data/stockpilot.sqlite'
);

export const config = {
  nodeEnv: NODE_ENV,
  host: HOST,
  port: PORT,
  databasePath: DATABASE_PATH,
};
