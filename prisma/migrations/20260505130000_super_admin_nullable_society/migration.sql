-- Enum value must commit before PostgreSQL allows CHECK constraints referencing it (see follow-up migration).
ALTER TYPE "UserRole" ADD VALUE 'SUPER_ADMIN';
