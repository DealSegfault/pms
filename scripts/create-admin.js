#!/usr/bin/env node

/**
 * Create an admin user for PMS.
 * Usage: node scripts/create-admin.js --user admin --pass <password>
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword, generateApiKey } from '../server/auth.js';

const args = process.argv.slice(2);
function getArg(flag) {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const username = getArg('--user') || getArg('-u');
const password = getArg('--pass') || getArg('-p');

if (!username || !password) {
    console.error('Usage: node scripts/create-admin.js --user <username> --pass <password>');
    process.exit(1);
}

const prisma = new PrismaClient();

try {
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
        console.log(`User "${username}" already exists (role: ${existing.role}, status: ${existing.status}).`);
        if (existing.role !== 'ADMIN') {
            await prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN', status: 'APPROVED' } });
            console.log(`→ Upgraded to ADMIN.`);
        }
    } else {
        const apiKey = generateApiKey();
        const user = await prisma.user.create({
            data: {
                username,
                passwordHash: hashPassword(password),
                role: 'ADMIN',
                status: 'APPROVED',
                apiKey,
            },
        });
        console.log(`✅ Admin "${username}" created.`);
        console.log(`   ID:      ${user.id}`);
        console.log(`   API Key: ${apiKey}`);
    }
} catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}

