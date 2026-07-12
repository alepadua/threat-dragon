/* eslint-disable */
import crypto from 'crypto';
import fs from 'fs';
import encryptionHelper from './encryption.helper.js';
import loggerHelper from './logger.helper.js';
import path from 'path';

const logger = loggerHelper.get('helpers/aiContextStore.js');

// Store sessions in td.server/ai-sessions directory
const SESSIONS_DIR = path.join(process.cwd(), 'ai-sessions');

const ensureSessionsDir = () => {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
};

const getSessionPath = (sessionId) => {
    // Sanitize sessionId to avoid path traversal
    const safeId = sessionId.replace(/[^a-zA-Z0-9-]/gu, '');
    return path.join(SESSIONS_DIR, `${safeId}.json`);
};

const getVectorsPath = (sessionId) => {
    const safeId = sessionId.replace(/[^a-zA-Z0-9-]/gu, '');
    return path.join(SESSIONS_DIR, `${safeId}.vectors.json`);
};

export const hashPassword = (password, salt) => {
    if (!password) return '';
    return crypto.createHash('sha256').update(password + salt).digest('hex');
};

export const createSession = async (data) => {
    ensureSessionsDir();
    const sessionId = crypto.randomUUID();
    let encryptedKey = '';
    if (data.apiKey && data.apiKey.trim() !== '') {
        try {
            const encrypted = await encryptionHelper.encryptPromise(data.apiKey);
            encryptedKey = JSON.stringify(encrypted);
        } catch (err) {
            logger.error(`Error encrypting API key on session creation: ${err.message}`);
        }
    }

    let passwordHash = '';
    if (data.password && data.password.trim() !== '') {
        passwordHash = hashPassword(data.password, sessionId);
    }

    const sessionData = {
        sessionId,
        createdAt: new Date().toISOString(),
        title: data.title,
        description: data.description,
        docs: data.docs || [],
        images: data.images || [],
        refinementHistory: data.refinementHistory || [],
        currentModel: data.currentModel || null,
        history: [],
        methodology: data.methodology || 'STRIDE',
        questionPlan: data.questionPlan || null,
        answeredQuestionIds: data.answeredQuestionIds || [],
        requirements: data.requirements || [],
        aiProvider: data.aiProvider || 'gemini',
        customBaseUrl: data.customBaseUrl || '',
        customModel: data.customModel || '',
        apiKey: encryptedKey,
        passwordHash
    };

    fs.writeFileSync(getSessionPath(sessionId), JSON.stringify(sessionData, null, 2), 'utf-8');
    logger.info(`Created new threat modeling session: ${sessionId}`);
    
    return {
        ...sessionData,
        apiKey: data.apiKey || ''
    };
};

export const getSession = (sessionId) => {
    ensureSessionsDir();
    const filePath = getSessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
        logger.warn(`Session not found: ${sessionId}`);
        return null;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const session = JSON.parse(content);
        if (session.apiKey && session.apiKey.trim() !== '') {
            if (session.apiKey.startsWith('{')) {
                try {
                    const encryptedObj = JSON.parse(session.apiKey);
                    session.apiKey = encryptionHelper.decrypt(encryptedObj);
                } catch (decErr) {
                    logger.error(`Error decrypting API key for session ${sessionId}: ${decErr.message}`);
                }
            }
        }
        return session;
    } catch (err) {
        logger.error(`Error reading session ${sessionId}: ${err.message}`);
        return null;
    }
};

export const saveVectors = (sessionId, chunksWithEmbeddings) => {
    ensureSessionsDir();
    const filePath = getVectorsPath(sessionId);
    fs.writeFileSync(filePath, JSON.stringify(chunksWithEmbeddings, null, 2), 'utf-8');
    logger.info(`Saved session vectors: ${sessionId}`);
    return true;
};

export const getVectors = (sessionId) => {
    ensureSessionsDir();
    const filePath = getVectorsPath(sessionId);
    if (!fs.existsSync(filePath)) {
        logger.warn(`Vectors not found for session: ${sessionId}`);
        return null;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        logger.error(`Error reading vectors for session ${sessionId}: ${err.message}`);
        return null;
    }
};

export const updateSession = async (sessionId, updates) => {
    ensureSessionsDir();
    const session = getSession(sessionId);
    if (!session) {
        return null;
    }

    let updatedApiKey = session.apiKey;
    if (updates.apiKey !== undefined) {
        if (updates.apiKey === '*****') {
            updatedApiKey = session.apiKey;
        } else if (updates.apiKey && updates.apiKey.trim() !== '') {
            try {
                const encrypted = await encryptionHelper.encryptPromise(updates.apiKey);
                updatedApiKey = JSON.stringify(encrypted);
            } catch (err) {
                logger.error(`Error encrypting updated API key: ${err.message}`);
            }
        } else {
            updatedApiKey = '';
        }
    }

    const decryptedApiKey = (updates.apiKey !== undefined)
        ? (updates.apiKey === '*****' ? session.apiKey : updates.apiKey)
        : session.apiKey;

    let passwordHash = session.passwordHash || '';
    if (updates.password !== undefined) {
        if (updates.password && updates.password.trim() !== '') {
            passwordHash = hashPassword(updates.password, sessionId);
        } else {
            passwordHash = '';
        }
    }

    const updatedSession = {
        ...session,
        ...updates,
        passwordHash,
        apiKey: decryptedApiKey,
        updatedAt: new Date().toISOString()
    };
    delete updatedSession.password;

    const diskSession = { ...updatedSession };
    if (diskSession.apiKey && diskSession.apiKey.trim() !== '') {
        try {
            const encrypted = await encryptionHelper.encryptPromise(diskSession.apiKey);
            diskSession.apiKey = JSON.stringify(encrypted);
        } catch (err) {
            logger.error(`Error encrypting API key for disk write: ${err.message}`);
        }
    } else {
        diskSession.apiKey = '';
    }

    delete diskSession.password;
    fs.writeFileSync(getSessionPath(sessionId), JSON.stringify(diskSession, null, 2), 'utf-8');
    logger.info(`Updated threat modeling session: ${sessionId}`);
    return updatedSession;
};

export const deleteSession = (sessionId) => {
    ensureSessionsDir();
    const filePath = getSessionPath(sessionId);
    const vectorsPath = getVectorsPath(sessionId);
    let deleted = false;
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted = true;
    }
    if (fs.existsSync(vectorsPath)) {
        fs.unlinkSync(vectorsPath);
    }
    if (deleted) {
        logger.info(`Deleted session and associated vectors: ${sessionId}`);
        return true;
    }
    return false;
};

export const cleanOldSessions = (maxAgeDays = 7) => {
    ensureSessionsDir();
    try {
        const files = fs.readdirSync(SESSIONS_DIR);
        const now = Date.now();
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        let deletedCount = 0;

        files.forEach((file) => {
            if (file.endsWith('.json') && !file.endsWith('.vectors.json')) {
                const filePath = path.join(SESSIONS_DIR, file);
                try {
                    const stats = fs.statSync(filePath);
                    const ageMs = now - stats.mtimeMs;
                    if (ageMs > maxAgeMs) {
                        const sessionId = path.basename(file, '.json');
                        deleteSession(sessionId);
                        deletedCount++;
                    }
                } catch (statErr) {
                    logger.error(`Error checking stats for session file ${file}: ${statErr.message}`);
                }
            }
        });

        if (deletedCount > 0) {
            logger.info(`Garbage Collector: Cleaned up ${deletedCount} inactive sessions (> ${maxAgeDays} days).`);
        }
        return deletedCount;
    } catch (err) {
        logger.error(`Error during session garbage collection: ${err.message}`);
        return 0;
    }
};

export const listSessions = () => {
    ensureSessionsDir();
    try {
        const files = fs.readdirSync(SESSIONS_DIR);
        const sessions = [];
        files.forEach((file) => {
            if (file.endsWith('.json') && !file.endsWith('.vectors.json')) {
                const filePath = path.join(SESSIONS_DIR, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const session = JSON.parse(content);
                    if (session.sessionId) {
                        sessions.push({
                            sessionId: session.sessionId,
                            title: session.title || 'Untitled Session',
                            methodology: session.methodology || 'STRIDE',
                            createdAt: session.createdAt,
                            updatedAt: session.updatedAt || session.createdAt,
                            hasPassword: Boolean(session.passwordHash)
                        });
                    }
                } catch (err) {
                    logger.error(`Error reading session file ${file} in listSessions: ${err.message}`);
                }
            }
        });
        sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        return sessions;
    } catch (err) {
        logger.error(`Error listing sessions: ${err.message}`);
        return [];
    }
};

export default {
    createSession,
    getSession,
    updateSession,
    deleteSession,
    saveVectors,
    getVectors,
    cleanOldSessions,
    listSessions,
    hashPassword
};

