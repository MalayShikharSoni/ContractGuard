export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://guard:guard@localhost:5432/contractguard',
  webhookUrl: process.env.WEBHOOK_URL || '',
  publicUrl: process.env.PUBLIC_URL || '',
  seedDir: process.env.SEED_DIR || '',
  seedOnBoot: process.env.SEED_ON_BOOT !== '0',
};

export const SEVERITY_ORDER = { DANGEROUS: 0, WARNING: 1, DEPRECATED: 2, SAFE: 3 };
