import { Router } from 'express';
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import prisma from '../db/prisma.js';
import { authMiddleware, generateToken } from '../auth.js';
import { validate } from '../middleware/validate.js';
import {
    RegisterVerifyBody,
    LoginOptionsBody,
    LoginVerifyBody,
    CredentialIdParam,
} from '../contracts/webauthn.contracts.js';

// ── Config ──────────────────────────────────────────
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'PMS Pro';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';

const router = Router();

// ── Helpers ─────────────────────────────────────────
function isoBase64urlToUint8Array(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const binary = atob(base64 + pad);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function uint8ArrayToBase64url(uint8) {
    let binary = '';
    for (const byte of uint8) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ═══════════════════════════════════════════════════
// REGISTRATION (requires auth — user is already logged in)
// ═══════════════════════════════════════════════════

/** Step 1: Generate registration options */
router.post('/register/options', authMiddleware, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            include: { webauthnCredentials: true },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const existingCredentials = user.webauthnCredentials.map(cred => ({
            id: cred.credentialId,
            type: 'public-key',
            transports: cred.transports ? cred.transports.split(',').filter(Boolean) : undefined,
        }));

        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: RP_ID,
            userName: user.username,
            userID: new TextEncoder().encode(user.id),
            attestationType: 'none',
            excludeCredentials: existingCredentials,
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred',
            },
        });

        // Store challenge for verification
        await prisma.user.update({
            where: { id: user.id },
            data: { currentChallenge: options.challenge },
        });

        res.json(options);
    } catch (err) {
        console.error('[WebAuthn] register/options error:', err);
        res.status(500).json({ error: err.message });
    }
});

/** Step 2: Verify registration response & store credential */
router.post('/register/verify', authMiddleware, validate(RegisterVerifyBody), async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.currentChallenge) return res.status(400).json({ error: 'No pending registration challenge' });

        const verification = await verifyRegistrationResponse({
            response: req.body,
            expectedChallenge: user.currentChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
        });

        if (!verification.verified || !verification.registrationInfo) {
            return res.status(400).json({ error: 'Registration verification failed' });
        }

        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

        // Store the credential
        await prisma.$transaction([
            prisma.webAuthnCredential.create({
                data: {
                    userId: user.id,
                    credentialId: credential.id,
                    publicKey: uint8ArrayToBase64url(credential.publicKey),
                    counter: credential.counter,
                    deviceType: credentialDeviceType || 'unknown',
                    backedUp: credentialBackedUp || false,
                    transports: (credential.transports || []).join(','),
                },
            }),
            prisma.user.update({
                where: { id: user.id },
                data: { currentChallenge: null },
            }),
        ]);

        res.json({ verified: true, message: 'Biometric credential registered successfully' });
    } catch (err) {
        console.error('[WebAuthn] register/verify error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// AUTHENTICATION (public — passwordless login)
// ═══════════════════════════════════════════════════

/** Step 1: Generate authentication options for a username */
router.post('/login/options', validate(LoginOptionsBody), async (req, res) => {
    try {
        const { username } = req.body;

        const user = await prisma.user.findUnique({
            where: { username },
            include: { webauthnCredentials: true },
        });

        if (!user || user.webauthnCredentials.length === 0) {
            return res.status(404).json({ error: 'No biometric credentials found for this user' });
        }

        if (user.status === 'BANNED') {
            return res.status(403).json({ error: 'Account banned' });
        }
        if (user.status === 'PENDING') {
            return res.status(403).json({ error: 'Account pending admin approval', status: 'PENDING' });
        }

        const allowCredentials = user.webauthnCredentials.map(cred => ({
            id: cred.credentialId,
            type: 'public-key',
            transports: cred.transports ? cred.transports.split(',').filter(Boolean) : undefined,
        }));

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            allowCredentials,
            userVerification: 'preferred',
        });

        await prisma.user.update({
            where: { id: user.id },
            data: { currentChallenge: options.challenge },
        });

        res.json(options);
    } catch (err) {
        console.error('[WebAuthn] login/options error:', err);
        res.status(500).json({ error: err.message });
    }
});

/** Step 2: Verify authentication response & issue JWT */
router.post('/login/verify', validate(LoginVerifyBody), async (req, res) => {
    try {
        const { username, ...assertionResponse } = req.body;

        const user = await prisma.user.findUnique({
            where: { username },
            include: { webauthnCredentials: true },
        });

        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        if (!user.currentChallenge) return res.status(400).json({ error: 'No pending login challenge' });

        // Find the credential used
        const credential = user.webauthnCredentials.find(c => c.credentialId === assertionResponse.id);
        if (!credential) return res.status(401).json({ error: 'Unknown credential' });

        const verification = await verifyAuthenticationResponse({
            response: assertionResponse,
            expectedChallenge: user.currentChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
            credential: {
                id: credential.credentialId,
                publicKey: isoBase64urlToUint8Array(credential.publicKey),
                counter: credential.counter,
                transports: credential.transports ? credential.transports.split(',').filter(Boolean) : undefined,
            },
        });

        if (!verification.verified) {
            return res.status(401).json({ error: 'Biometric verification failed' });
        }

        // Update sign counter
        await prisma.$transaction([
            prisma.webAuthnCredential.update({
                where: { id: credential.id },
                data: { counter: verification.authenticationInfo.newCounter },
            }),
            prisma.user.update({
                where: { id: user.id },
                data: { currentChallenge: null },
            }),
        ]);

        // Issue JWT — same as password login
        const token = generateToken(user);
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                status: user.status,
            },
        });
    } catch (err) {
        console.error('[WebAuthn] login/verify error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// CREDENTIAL MANAGEMENT (requires auth)
// ═══════════════════════════════════════════════════

/** List user's registered credentials */
router.get('/credentials', authMiddleware, async (req, res) => {
    try {
        const credentials = await prisma.webAuthnCredential.findMany({
            where: { userId: req.user.id },
            select: {
                id: true,
                credentialId: true,
                deviceType: true,
                backedUp: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(credentials);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Delete a credential */
router.delete('/credentials/:credentialId', authMiddleware, validate(CredentialIdParam, 'params'), async (req, res) => {
    try {
        const credential = await prisma.webAuthnCredential.findFirst({
            where: {
                id: req.params.credentialId,
                userId: req.user.id,
            },
        });
        if (!credential) return res.status(404).json({ error: 'Credential not found' });

        await prisma.webAuthnCredential.delete({ where: { id: credential.id } });
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
