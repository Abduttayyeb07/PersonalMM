import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../src/encryption/encryption.service';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.ENCRYPTION_KEY_PREV) throw new Error('Set ENCRYPTION_KEY_PREV to the old key');
  if (process.env.ENCRYPTION_KEY === process.env.ENCRYPTION_KEY_PREV) throw new Error('Current and previous keys must differ');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as any);
  const encryption = new EncryptionService(new ConfigService(process.env));
  const rows = await prisma.exchangeCredential.findMany();
  await prisma.$transaction(rows.map((row) => {
    const aad = `${row.userId}:${row.exchange}`;
    return prisma.exchangeCredential.update({
      where: { id: row.id },
      data: {
        encryptedApiKey: encryption.encrypt(encryption.decrypt(row.encryptedApiKey, aad), aad),
        encryptedApiSecret: encryption.encrypt(encryption.decrypt(row.encryptedApiSecret, aad), aad),
      },
    });
  }));
  await prisma.$disconnect();
  process.stdout.write(`Rotated ${rows.length} credential row(s).\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
