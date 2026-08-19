export const PORT = parseInt(process.env.PORT || '3001', 10);
export const DB_HOST = process.env.DB_HOST || 'localhost';
export const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
export const DB_USER = process.env.DB_USER || 'apilens';
export const DB_PASSWORD = process.env.DB_PASSWORD || 'apilens';
export const DB_NAME = process.env.DB_NAME || 'apilens_db';
export const IS_DEV = process.env.NODE_ENV !== 'production';

export const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-for-dev';
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';

export const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
