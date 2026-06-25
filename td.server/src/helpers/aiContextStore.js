import crypto from 'crypto';
import fs from 'fs';
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

export const createSession = (data) => {
    ensureSessionsDir();
    const sessionId = crypto.randomUUID();
    const sessionData = {
        sessionId,
        createdAt: new Date().toISOString(),
        title: data.title,
        description: data.description,
        docs: data.docs || [],
        images: data.images || [],
        refinementHistory: data.refinementHistory || [],
        currentModel: data.currentModel || null,
        methodology: data.methodology || 'STRIDE'
    };

    fs.writeFileSync(getSessionPath(sessionId), JSON.stringify(sessionData, null, 2), 'utf-8');
    logger.info(`Created new threat modeling session: ${sessionId}`);
    return sessionData;
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
        return JSON.parse(content);
    } catch (err) {
        logger.error(`Error reading session ${sessionId}: ${err.message}`);
        return null;
    }
};

export const updateSession = (sessionId, updates) => {
    ensureSessionsDir();
    const session = getSession(sessionId);
    if (!session) {
        return null;
    }

    const updatedSession = {
        ...session,
        ...updates,
        updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(getSessionPath(sessionId), JSON.stringify(updatedSession, null, 2), 'utf-8');
    logger.info(`Updated threat modeling session: ${sessionId}`);
    return updatedSession;
};

export const deleteSession = (sessionId) => {
    ensureSessionsDir();
    const filePath = getSessionPath(sessionId);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`Deleted session: ${sessionId}`);
        return true;
    }
    return false;
};

export default {
    createSession,
    getSession,
    updateSession,
    deleteSession
};
