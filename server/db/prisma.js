/**
 * Shared Prisma client singleton.
 *
 * Every module imports from here instead of constructing its own PrismaClient.
 * This eliminates connection proliferation and centralises the shutdown path.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Graceful disconnect — call once during server shutdown.
 */
export async function disconnectPrisma() {
    await prisma.$disconnect();
}

export default prisma;
