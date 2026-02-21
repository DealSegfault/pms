import { z } from 'zod';

/** POST /register/verify body — attestation response from browser */
export const RegisterVerifyBody = z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
        clientDataJSON: z.string().min(1),
        attestationObject: z.string().min(1),
        transports: z.array(z.string()).optional(),
        publicKeyAlgorithm: z.number().optional(),
        publicKey: z.string().optional(),
        authenticatorData: z.string().optional(),
    }),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.unknown()).optional(),
    type: z.literal('public-key'),
});

/** POST /login/options body */
export const LoginOptionsBody = z.object({
    username: z.string().min(1, 'Username is required'),
});

/** POST /login/verify body — assertion response from browser */
export const LoginVerifyBody = z.object({
    username: z.string().min(1, 'Username is required'),
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
        clientDataJSON: z.string().min(1),
        authenticatorData: z.string().min(1),
        signature: z.string().min(1),
        userHandle: z.string().optional(),
    }),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.unknown()).optional(),
    type: z.literal('public-key'),
});

/** DELETE /:credentialId param */
export const CredentialIdParam = z.object({
    credentialId: z.string().min(1, 'credentialId is required'),
});
