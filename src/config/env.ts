import dotenv from "dotenv";

dotenv.config();

function mustGet(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  DATABASE_URL: mustGet("DATABASE_URL"),
  JWT_SECRET: mustGet("JWT_SECRET"),
};
