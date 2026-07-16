/* eslint-disable */
import { DOMMatrix } from '@napi-rs/canvas';
import aiContextStore from '../helpers/aiContextStore.js';
import { badRequest, serverError } from './errors.js';
import env from '../env/Env.js';
import loggerHelper from '../helpers/logger.helper.js';
import questionPlanningEngine from '../helpers/questionPlanningEngine.js';

// Polyfill DOMMatrix for pdfjs-dist used by pdf-parse
global.DOMMatrix = DOMMatrix;

const logger = loggerHelper.get('controllers/aiController.js');

// Import modular components
import { activeJobs } from '../helpers/ai/activeJobs.js';
import {
    clientFactory,
    getMaxContextChars,
    getQuestionBatchSize,
    callAIModel
} from '../helpers/ai/aiClient.js';
import {
    areTitlesSimilar,
    mergeDiagramCells,
    mergeControlsAssessment,
    applyDeduplicationChanges
} from '../helpers/ai/mergeEngine.js';
import {
    extractJson,
    ensureModelMessageInHistory
} from '../helpers/ai/utils.js';
import {
    runGenerateJob,
    runDeduplicateJob
} from '../helpers/ai/jobRunner.js';

// Run session garbage collection once on startup
try {
    aiContextStore.cleanOldSessions(7);
} catch (err) {
    logger.error(`Failed to run startup session cleanup: ${err.message}`);
}

// Start periodic cleanup of inactive sessions every 24 hours
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const cleanupInterval = setInterval(() => {
    try {
        aiContextStore.cleanOldSessions(7);
    } catch (err) {
        logger.error(`Failed to run periodic session cleanup: ${err.message}`);
    }
}, CLEANUP_INTERVAL_MS);
if (cleanupInterval.unref) {
    cleanupInterval.unref();
}

// Helper to create and track a job
const createJob = () => {
    const jobId = 'job-' + Math.random().toString(36).
substring(2, 15);
    const job = {
        jobId,
        status: 'queued',
        progress: 0,
        error: null,
        result: null,
        createdAt: Date.now()
    };
    activeJobs.set(jobId, job);
    
    // Clean up jobs older than 30 minutes
    const now = Date.now();
    for (const [id, item] of activeJobs.entries()) {
        if (now - item.createdAt > 30 * 60 * 1000) {
            activeJobs.delete(id);
        }
    }
    
    return job;
};

const resolveModel = (provider, customModel, session) => {
    if (provider === 'bedrock-mantle') {
        return customModel || (session && session.customModel) || env.get().config.BEDROCK_MANTLE_MODEL || 'meta.llama3-70b-instruct-v1:0';
    }
    return customModel || (session && session.customModel) || env.get().config.GEMINI_MODEL || 'gemini-3.1-flash-lite';
};

const resolveApiKeyForSession = (session) => {
    if (session && session.isCustomApiKey && session.apiKey) {
        return session.apiKey;
    }
    const provider = session?.aiProvider || 'gemini';
    return provider === 'bedrock-mantle'
        ? env.get().config.BEDROCK_MANTLE_API_KEY
        : env.get().config.GEMINI_API_KEY;
};

// Rebuild history from answered questions helper
const rebuildHistoryFromAnswered = (answeredQuestions) => {
    const history = [];
    if (!answeredQuestions || !Array.isArray(answeredQuestions)) { return history; }
    answeredQuestions.forEach((q) => {
        if (q.id && q.id.startsWith('manual-req-')) {
            history.push({
                role: 'user',
                text: q.answer
            });
        } else {
            history.push({
                role: 'assistant',
                text: `Sobre o componente "${q.elementName || 'Desconhecido'}" (${q.category || ''}):\nPergunta: ${q.text}`
            });
            history.push({
                role: 'user',
                text: q.answer
            });
        }
    });
    return history;
};

// Polling status handler
const getJobStatus = (req, res) => {
    const { jobId } = req.params;
    const job = activeJobs.get(jobId);
    if (!job) {
        return res.status(404).json({
            status: 404,
            message: 'Job not found'
        });
    }
    return res.status(200).json({
        status: 200,
        data: job
    });
};

const generate = async (req, res) => {
    const {
        title,
        description,
        docs,
        images,
        apiKey: clientApiKey,
        aiProvider,
        customBaseUrl,
        customModel,
        customEmbeddingModel,
        currentModel,
        refinementHistory,
        requirements,
        methodology = 'STRIDE',
        sessionId,
        dfdApproved,
        threatModelApproved,
        extendedThinking,
        customizeStageModels,
        generatorModel,
        generatorExtendedThinking,
        criticModel,
        criticExtendedThinking,
        revisionModel,
        revisionExtendedThinking,
        deduplicatorModel,
        deduplicatorExtendedThinking,
        maxContextTokens,
        questionBatchSize
    } = req.body;

    logger.info(`[AI Generate Request] Incoming payload: ${JSON.stringify({
        title,
        description,
        docsCount: docs ? docs.length : 0,
        imagesCount: images ? images.length : 0,
        requirementsCount: requirements ? requirements.length : 0,
        aiProvider,
        customBaseUrl,
        customModel,
        sessionId,
        dfdApproved,
        threatModelApproved,
        extendedThinking,
        customizeStageModels,
        generatorModel,
        generatorExtendedThinking,
        criticModel,
        criticExtendedThinking,
        revisionModel,
        revisionExtendedThinking,
        deduplicatorModel,
        deduplicatorExtendedThinking,
        maxContextTokens,
        questionBatchSize,
        hasApiKey: Boolean(clientApiKey),
        apiKeyLength: clientApiKey ? clientApiKey.length : 0
    })}`);

    let activeSession = null;
    if (sessionId) {
        activeSession = aiContextStore.getSession(sessionId);
    }

    const provider = aiProvider || (activeSession && activeSession.aiProvider) || 'gemini';
    let extendedThinkingVal = false;
    if (extendedThinking !== undefined) {
        extendedThinkingVal = extendedThinking === true || extendedThinking === 'true';
    } else if (activeSession && activeSession.extendedThinking) {
        extendedThinkingVal = true;
    }
    const defaultEnvKey = provider === 'bedrock-mantle' ? env.get().config.BEDROCK_MANTLE_API_KEY : env.get().config.GEMINI_API_KEY;
    let resolvedApiKey = clientApiKey;
    let isCustom = false;

    if (resolvedApiKey && resolvedApiKey !== '*****') {
        if (resolvedApiKey !== defaultEnvKey) {
            isCustom = true;
        } else {
            resolvedApiKey = '';
        }
    }

    if (resolvedApiKey === '*****') {
        if (activeSession && activeSession.isCustomApiKey && activeSession.apiKey) {
            resolvedApiKey = activeSession.apiKey;
            isCustom = true;
        } else {
            resolvedApiKey = defaultEnvKey;
        }
    }

    if (!resolvedApiKey) {
        if (activeSession && activeSession.isCustomApiKey && activeSession.apiKey) {
            resolvedApiKey = activeSession.apiKey;
            isCustom = true;
        } else {
            resolvedApiKey = defaultEnvKey;
        }
    }
    const aiConfig = {
        provider: provider,
        apiKey: resolvedApiKey,
        baseUrl: customBaseUrl || (activeSession && activeSession.customBaseUrl) || env.get().config.BEDROCK_MANTLE_BASE_URL,
        model: resolveModel(provider, customModel, activeSession),
        embeddingModel: customEmbeddingModel || (activeSession && activeSession.customEmbeddingModel) || env.get().config.BEDROCK_MANTLE_EMBEDDING_MODEL || 'amazon.titan-embed-text-v1',
        extendedThinking: extendedThinkingVal,
        maxContextTokens: maxContextTokens || (activeSession && activeSession.maxContextTokens) || null,
        questionBatchSize: questionBatchSize || (activeSession && activeSession.questionBatchSize) || null
    };

    logger.info(`[AI Generate Request] Resolved aiConfig: ${JSON.stringify({
        provider: aiConfig.provider,
        baseUrl: aiConfig.baseUrl,
        model: aiConfig.model,
        embeddingModel: aiConfig.embeddingModel,
        extendedThinking: aiConfig.extendedThinking,
        maxContextTokens: aiConfig.maxContextTokens,
        questionBatchSize: aiConfig.questionBatchSize,
        hasApiKey: Boolean(aiConfig.apiKey),
        apiKeyLength: aiConfig.apiKey ? aiConfig.apiKey.length : 0
    })}`);

    const apiKey = aiConfig.apiKey;
    const dfdApprovedBool = (dfdApproved === true || dfdApproved === 'true');
    const threatModelApprovedBool = (threatModelApproved === true || threatModelApproved === 'true');

    if (!apiKey) {
        return badRequest(`API key is missing for provider ${provider}. Please configure it in the server environment or provide it in the API Key input.`, res, logger);
    }

    try {
        let finalDocs = docs || [];
        let finalImages = images || [];
        let finalMethodology = methodology;

        // Stage 1: RAG Context Evolution
        if (sessionId) {
            if (activeSession) {
                logger.info(`Resuming existing RAG threat modeling session: ${sessionId}`);
                // Load original documents/images from session if not sent in refinement request
                if (finalDocs.length === 0 && activeSession.docs.length > 0) {
                    finalDocs = activeSession.docs;
                }
                if (finalImages.length === 0 && activeSession.images.length > 0) {
                    finalImages = activeSession.images;
                }
                finalMethodology = activeSession.methodology || methodology;
                
                let questionPlan = activeSession.questionPlan || null;
                if (dfdApprovedBool && !questionPlan) {
                    const diagramCells = (currentModel && currentModel.detail && currentModel.detail.diagrams && currentModel.detail.diagrams[0])
                        ? (currentModel.detail.diagrams[0].cells || [])
                        : [];
                    if (diagramCells.length > 0) {
                        questionPlan = questionPlanningEngine.computeQuestionPlan(diagramCells, finalMethodology);
                        logger.info(`[Session ${sessionId}] Pre-computed question plan on DFD approval: ${questionPlan.totalQuestions} questions for ${finalMethodology}`);
                    }
                }

                // Build a quick lookup map for original question IDs from the question plan to avoid deep nesting
                const planQuestionsMap = new Map();
                if (activeSession.questionPlan && activeSession.questionPlan.elementQuestions) {
                    activeSession.questionPlan.elementQuestions.forEach((elem) => {
                        elem.categories.forEach((catGroup) => {
                            catGroup.questions.forEach((pq) => {
                                planQuestionsMap.set(pq.id, {
                                    elementId: elem.elementId,
                                    elementName: elem.elementName
                                });
                            });
                        });
                    });
                }

                // Process structured question answers if provided
                const sessionAnswered = activeSession.answeredQuestions || [];
                if (req.body.answeredQuestions && Array.isArray(req.body.answeredQuestions)) {
                    const existingIds = new Set(sessionAnswered.map((q) => q.id));
                    req.body.answeredQuestions.forEach((q) => {
                        const activeQ = (activeSession.questions || []).find((aq) => aq.id === q.id);
                        if (activeQ && Array.isArray(activeQ.originalQuestionIds) && activeQ.originalQuestionIds.length > 0) {
                            activeQ.originalQuestionIds.forEach((origId) => {
                                if (existingIds.has(origId)) {
                                    return;
                                }
                                const planMeta = planQuestionsMap.get(origId) || {};
                                const elementId = planMeta.elementId || q.elementId || 'global';
                                const elementName = planMeta.elementName || q.elementName || 'Sistema';

                                sessionAnswered.push({
                                    id: origId,
                                    text: activeQ.text || q.text,
                                    answer: q.answer,
                                    elementId: elementId,
                                    elementName: elementName,
                                    category: q.category || activeQ.category,
                                    timestamp: new Date().toISOString()
                                });
                                existingIds.add(origId);
                            });

                            if (q.id && !existingIds.has(q.id)) {
                                sessionAnswered.push({
                                    id: q.id,
                                    text: q.text,
                                    answer: q.answer,
                                    elementId: q.elementId || 'global',
                                    elementName: q.elementName || 'Sistema',
                                    category: q.category,
                                    timestamp: new Date().toISOString()
                                });
                                existingIds.add(q.id);
                            }
                        } else if (q.id && !existingIds.has(q.id)) {
                            sessionAnswered.push({
                                id: q.id,
                                text: q.text,
                                answer: q.answer,
                                elementId: q.elementId,
                                elementName: q.elementName,
                                category: q.category,
                                timestamp: new Date().toISOString()
                            });
                            existingIds.add(q.id);
                        }
                    });
                }

                // If userResponse (general feedback) is provided, append it as a manual request
                if (req.body.userResponse && req.body.userResponse.trim()) {
                    const manualId = `manual-req-${Date.now()}-${Math.random().toString(36).
substring(2, 7)}`;
                    sessionAnswered.push({
                        id: manualId,
                        text: 'Solicitação Manual de Ajuste',
                        answer: req.body.userResponse.trim(),
                        elementId: 'global',
                        elementName: 'Sistema',
                        category: 'Ajuste Manual',
                        timestamp: new Date().toISOString()
                    });
                }

                // Rebuild refinementHistory based on ALL answered questions
                const rebuiltHistory = rebuildHistoryFromAnswered(sessionAnswered);

                // Update answeredQuestionIds automatically
                const answeredQuestionIds = Array.from(new Set([
                    ...(activeSession.answeredQuestionIds || []),
                    ...sessionAnswered.filter((q) => q.id && !q.id.startsWith('manual-req-')).map((q) => q.id)
                ]));

                const sessionUpdates = {
                    answeredQuestions: sessionAnswered,
                    answeredQuestionIds: answeredQuestionIds,
                    refinementHistory: rebuiltHistory,
                    currentModel: currentModel || null,
                    questionPlan: questionPlan,
                    aiProvider: provider,
                    customBaseUrl: aiConfig.baseUrl,
                    customModel: aiConfig.model,
                    extendedThinking: aiConfig.extendedThinking,
                    maxContextTokens: aiConfig.maxContextTokens,
                    questionBatchSize: aiConfig.questionBatchSize,
                    customizeStageModels: customizeStageModels === true || customizeStageModels === 'true',
                    generatorModel: generatorModel || '',
                    generatorExtendedThinking: generatorExtendedThinking === true || generatorExtendedThinking === 'true',
                    criticModel: criticModel || '',
                    criticExtendedThinking: criticExtendedThinking === true || criticExtendedThinking === 'true',
                    revisionModel: revisionModel || '',
                    revisionExtendedThinking: revisionExtendedThinking === true || revisionExtendedThinking === 'true',
                    deduplicatorModel: deduplicatorModel || '',
                    deduplicatorExtendedThinking: deduplicatorExtendedThinking === true || deduplicatorExtendedThinking === 'true'
                };
                if (clientApiKey !== undefined) {
                    if (isCustom) {
                        sessionUpdates.apiKey = resolvedApiKey;
                        sessionUpdates.isCustomApiKey = true;
                    } else {
                        sessionUpdates.apiKey = '';
                        sessionUpdates.isCustomApiKey = false;
                    }
                }
                activeSession = await aiContextStore.updateSession(sessionId, sessionUpdates);
            }
        }

        // Bypassing LLM generation on explicit human approval of the final threat model
        if (threatModelApprovedBool && activeSession) {
            const previousHistory = activeSession.history || [];
            if (activeSession.currentModel) {
                previousHistory.push({
                    currentModel: activeSession.currentModel,
                    questions: activeSession.questions || [],
                    evaluation: activeSession.evaluation || null,
                    refinementHistory: activeSession.refinementHistory || [],
                    dfdApproved: activeSession.dfdApproved || false,
                    threatModelApproved: activeSession.threatModelApproved || false
                });
            }

            const updatedEvaluation = activeSession.evaluation ? {
                ...activeSession.evaluation,
                status: 'Ready',
                completenessScore: 100
            } : {
                status: 'Ready',
                completenessScore: 100,
                feedback: 'Threat model successfully approved and concluded.',
                controlsAssessment: []
            };

            activeSession = await aiContextStore.updateSession(activeSession.sessionId, {
                history: previousHistory,
                threatModelApproved: true,
                evaluation: updatedEvaluation
            });

            logger.info(`Threat model session approved by human. Session ID: ${activeSession.sessionId}`);
            return res.status(200).json({
                status: 200,
                message: 'Threat model successfully approved and concluded.',
                data: {
                    threatModel: activeSession.currentModel,
                    questions: [],
                    evaluation: activeSession.evaluation,
                    sessionId: activeSession.sessionId,
                    dfdApproved: activeSession.dfdApproved || false,
                    threatModelApproved: true,
                    refinementHistory: activeSession.refinementHistory || []
                }
            });
        }

        if (!activeSession) {
            // First round: create new session
            if (!title || title.trim() === '') {
                return badRequest('Threat model title is required to initialize a session', res, logger);
            }
            activeSession = await aiContextStore.createSession({
                title,
                description,
                docs: finalDocs,
                images: finalImages,
                requirements: requirements || [],
                refinementHistory: refinementHistory || [],
                currentModel: currentModel || null,
                methodology: finalMethodology,
                aiProvider: provider,
                customBaseUrl: aiConfig.baseUrl || '',
                customModel: aiConfig.model || '',
                apiKey: isCustom ? resolvedApiKey : '',
                isCustomApiKey: isCustom,
                extendedThinking: aiConfig.extendedThinking,
                customizeStageModels: customizeStageModels === true || customizeStageModels === 'true',
                generatorModel: generatorModel || '',
                generatorExtendedThinking: generatorExtendedThinking === true || generatorExtendedThinking === 'true',
                criticModel: criticModel || '',
                criticExtendedThinking: criticExtendedThinking === true || criticExtendedThinking === 'true',
                revisionModel: revisionModel || '',
                revisionExtendedThinking: revisionExtendedThinking === true || revisionExtendedThinking === 'true',
                deduplicatorModel: deduplicatorModel || '',
                deduplicatorExtendedThinking: deduplicatorExtendedThinking === true || deduplicatorExtendedThinking === 'true'
            });
            logger.info(`Initialized new RAG session: ${activeSession.sessionId}`);
        }

        const job = createJob();
        job.sessionId = activeSession.sessionId;

        // Kick off the background execution
        runGenerateJob(job, req.body, activeSession, finalDocs, finalImages, finalMethodology, dfdApprovedBool, aiConfig);

        return res.status(202).json({
            status: 202,
            message: 'Threat modeling job started asynchronously.',
            data: {
                jobId: job.jobId,
                sessionId: activeSession.sessionId,
                status: job.status,
                progress: job.progress
            }
        });

    } catch (err) {
        logger.error(`Error in threat modeling generation setup: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const getSessionState = (req, res) => {
    const { sessionId } = req.params;
    const session = aiContextStore.getSession(sessionId);
    if (!session) {
        return res.status(404).json({
            status: 404,
            message: 'Session not found'
        });
    }
    return res.status(200).json({
        status: 200,
        message: 'Session retrieved successfully',
        data: {
            threatModel: session.currentModel,
            questions: session.questions || [],
            evaluation: session.evaluation || null,
            deduplicateProposals: session.deduplicateProposals || null,
            hallucinationAlerts: session.hallucinationAlerts || null,
            mitigationStatus: session.mitigationStatus || null,
            answersRevision: session.answersRevision || null,
            sessionId: session.sessionId,
            title: session.title,
            description: session.description,
            methodology: session.methodology || 'STRIDE',
            aiProvider: session.aiProvider || 'gemini',
            customBaseUrl: session.customBaseUrl || '',
            customModel: session.customModel || '',
            apiKey: session.apiKey ? '*****' : '',
            refinementHistory: ensureModelMessageInHistory(session.refinementHistory || [], session.questions || [], session.dfdApproved || false),
            dfdApproved: session.dfdApproved || false,
            threatModelApproved: session.threatModelApproved || false,
            answeredQuestions: session.answeredQuestions || [],
            extendedThinking: session.extendedThinking === true || session.extendedThinking === 'true',
            customizeStageModels: session.customizeStageModels === true || session.customizeStageModels === 'true',
            generatorModel: session.generatorModel || '',
            generatorExtendedThinking: session.generatorExtendedThinking === true || session.generatorExtendedThinking === 'true',
            criticModel: session.criticModel || '',
            criticExtendedThinking: session.criticExtendedThinking === true || session.criticExtendedThinking === 'true',
            revisionModel: session.revisionModel || '',
            revisionExtendedThinking: session.revisionExtendedThinking === true || session.revisionExtendedThinking === 'true',
            deduplicatorModel: session.deduplicatorModel || '',
            deduplicatorExtendedThinking: session.deduplicatorExtendedThinking === true || session.deduplicatorExtendedThinking === 'true',
            questionPlan: session.questionPlan ? {
                methodology: session.questionPlan.methodology,
                totalQuestions: session.questionPlan.totalQuestions,
                breakdown: session.questionPlan.breakdown,
                byCategory: session.questionPlan.progress?.byCategory || session.questionPlan.byCategory,
                estimatedRounds: session.questionPlan.estimatedRounds,
                progress: session.questionPlan.progress
            } : null
        }
    });
};

const undoRefinement = async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({
            status: 400,
            message: 'sessionId is required'
        });
    }
    try {
        const session = aiContextStore.getSession(sessionId);
        if (!session) {
            return res.status(404).json({
                status: 404,
                message: 'Session not found'
            });
        }
        const history = session.history || [];
        if (history.length === 0) {
            return res.status(400).json({
                status: 400,
                message: 'No more refinement history to undo.'
            });
        }
        const lastState = history.pop();
        const restoredHistory = ensureModelMessageInHistory(
            lastState.refinementHistory || [],
            lastState.questions || [],
            lastState.dfdApproved || false
        );
        const updated = await aiContextStore.updateSession(sessionId, {
            currentModel: lastState.currentModel,
            questions: lastState.questions,
            evaluation: lastState.evaluation,
            refinementHistory: restoredHistory,
            history: history,
            dfdApproved: lastState.dfdApproved || false,
            threatModelApproved: lastState.threatModelApproved || false
        });
        return res.status(200).json({
            status: 200,
            message: 'Successfully undid last refinement round',
            data: {
                threatModel: updated.currentModel,
                questions: updated.questions,
                evaluation: updated.evaluation,
                sessionId: updated.sessionId,
                refinementHistory: updated.refinementHistory || [],
                dfdApproved: updated.dfdApproved || false,
                threatModelApproved: updated.threatModelApproved || false
            }
        });
    } catch (err) {
        logger.error(`Error performing undo for session ${sessionId}: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const editAnswers = async (req, res) => {
    const { sessionId } = req.params;
    const { answeredQuestions } = req.body;
    
    logger.info(`[Edit Answers] Editing answers for session ${sessionId}`);
    
    try {
        const session = aiContextStore.getSession(sessionId);
        if (!session) {
            return res.status(404).json({
                status: 404,
                message: 'Session not found'
            });
        }
        
        if (!answeredQuestions || !Array.isArray(answeredQuestions)) {
            return res.status(400).json({
                status: 400,
                message: 'answeredQuestions array is required'
            });
        }
        
        // Update the answers in session.answeredQuestions
        const sessionAnswered = session.answeredQuestions || [];
        answeredQuestions.forEach((update) => {
            const item = sessionAnswered.find((q) => q.id === update.id);
            if (item) {
                item.answer = update.answer;
                item.timestamp = new Date().toISOString();

                // If this is a group question, also update all associated original questions
                const activeQ = (session.questions || []).find((aq) => aq.id === update.id);
                if (activeQ && Array.isArray(activeQ.originalQuestionIds)) {
                    activeQ.originalQuestionIds.forEach((origId) => {
                        const origItem = sessionAnswered.find((q) => q.id === origId);
                        if (origItem) {
                            origItem.answer = update.answer;
                            origItem.timestamp = new Date().toISOString();
                        }
                    });
                }
            }
        });
        
        // Rebuild history
        const rebuiltHistory = rebuildHistoryFromAnswered(sessionAnswered);
        
        // Recompute plan progress
        if (session.questionPlan) {
            const answeredIds = sessionAnswered.filter((q) => q.id && !q.id.startsWith('manual-req-')).map((q) => q.id);
            session.questionPlan.progress = questionPlanningEngine.computeProgress(session.questionPlan, answeredIds);
            if (session.questionPlan.progress && session.questionPlan.progress.byCategory) {
                session.questionPlan.byCategory = session.questionPlan.progress.byCategory;
            }
            session.answeredQuestionIds = answeredIds;
        }

        const previousHistory = session.history || [];
        if (session.currentModel) {
            previousHistory.push({
                currentModel: session.currentModel,
                questions: session.questions || [],
                evaluation: session.evaluation || null,
                refinementHistory: session.refinementHistory || [],
                dfdApproved: session.dfdApproved || false,
                threatModelApproved: session.threatModelApproved || false
            });
        }
        
        // Save back to session store
        const activeSession = await aiContextStore.updateSession(sessionId, {
            answeredQuestions: sessionAnswered,
            refinementHistory: rebuiltHistory,
            answeredQuestionIds: session.answeredQuestionIds || [],
            history: previousHistory
        });
        
        // Trigger generation job asynchronously
        const job = createJob();
        job.sessionId = sessionId;
        
        // We retrieve the needed parameters for generation
        const aiConfig = {
            provider: activeSession.aiProvider || 'gemini',
            apiKey: resolveApiKeyForSession(activeSession),
            baseUrl: activeSession.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: resolveModel(activeSession.aiProvider || 'gemini', activeSession.customModel, activeSession),
            embeddingModel: env.get().config.BEDROCK_MANTLE_EMBEDDING_MODEL || 'amazon.titan-embed-text-v1',
            extendedThinking: activeSession.extendedThinking === true || activeSession.extendedThinking === 'true',
            maxContextTokens: activeSession.maxContextTokens || null,
            questionBatchSize: activeSession.questionBatchSize || null
        };
        
        runGenerateJob(
            job,
            {
                title: activeSession.title,
                description: activeSession.description,
                currentModel: activeSession.currentModel,
                dfdApproved: activeSession.dfdApproved
            },
            activeSession,
            activeSession.docs || [],
            activeSession.images || [],
            activeSession.methodology || 'STRIDE',
            activeSession.dfdApproved || false,
            aiConfig
        );
        
        return res.status(202).json({
            status: 202,
            message: 'Threat model re-generation started asynchronously.',
            data: {
                jobId: job.jobId,
                sessionId: sessionId,
                status: job.status,
                progress: job.progress
            }
        });
        
    } catch (err) {
        logger.error(`Error in edit-answers setup: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const getDeduplicateProposals = async (req, res) => {
    const { sessionId } = req.params;
    const session = aiContextStore.getSession(sessionId);
    if (!session) {
        return res.status(404).json({
            status: 404,
            message: 'Session not found'
        });
    }

    try {
        const job = createJob();
        job.sessionId = sessionId;
        
        // Kick off deduplication in background
        runDeduplicateJob(job, req.body, session);

        return res.status(202).json({
            status: 202,
            message: 'Deduplication job started asynchronously',
            data: {
                jobId: job.jobId,
                status: job.status,
                progress: job.progress
            }
        });
    } catch (err) {
        logger.error(`Error initiating deduplication job: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const applyDeduplication = async (req, res) => {
    const { sessionId } = req.params;
    const { approvedControlDeduplicationIds = [], approvedThreatDeduplicationIds = [] } = req.body;

    const session = aiContextStore.getSession(sessionId);
    if (!session) {
        return res.status(404).json({
            status: 404,
            message: 'Session not found'
        });
    }

    try {
        const proposals = session.deduplicateProposals || { controlDeduplications: [], threatDeduplications: [] };
        const currentModel = session.currentModel;
        const controlsAssessment = session.evaluation?.controlsAssessment || [];

        // Apply approved deduplications
        const { model: updatedModel, controlsAssessment: updatedControls } = applyDeduplicationChanges(
            currentModel,
            controlsAssessment,
            proposals,
            approvedControlDeduplicationIds,
            approvedThreatDeduplicationIds
        );

        // Update the session's evaluation object with the new controlsAssessment list, hallucination alerts, and mitigation status
        const updatedEvaluation = session.evaluation ? {
            ...session.evaluation,
            controlsAssessment: updatedControls,
            hallucinationAlerts: session.hallucinationAlerts || [],
            mitigationStatus: session.mitigationStatus || [],
            status: 'Ready',
            completenessScore: 100
        } : {
            status: 'Ready',
            completenessScore: 100,
            feedback: 'Threat model successfully approved and concluded.',
            controlsAssessment: updatedControls,
            hallucinationAlerts: session.hallucinationAlerts || [],
            mitigationStatus: session.mitigationStatus || []
        };

        // Push to history for potential rollback
        const previousHistory = session.history || [];
        if (session.currentModel) {
            previousHistory.push({
                currentModel: session.currentModel,
                questions: session.questions || [],
                evaluation: session.evaluation || null,
                refinementHistory: session.refinementHistory || [],
                dfdApproved: session.dfdApproved || false,
                threatModelApproved: session.threatModelApproved || false
            });
        }

        await aiContextStore.updateSession(sessionId, {
            currentModel: updatedModel,
            evaluation: updatedEvaluation,
            threatModelApproved: true,
            deduplicateProposals: null, // Clear proposals cache
            hallucinationAlerts: null,
            mitigationStatus: null,
            answersRevision: null,
            history: previousHistory
        });

        logger.info(`Successfully applied approved deduplications and approved threat model for session: ${sessionId}`);

        return res.status(200).json({
            status: 200,
            message: 'Successfully applied deduplications and approved threat model',
            data: {
                threatModel: updatedModel,
                questions: [],
                evaluation: updatedEvaluation,
                sessionId: sessionId,
                dfdApproved: session.dfdApproved || false,
                threatModelApproved: true
            }
        });

    } catch (err) {
        logger.error(`Error applying deduplications for session ${sessionId}: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

/**
 * GET /api/ai/session/:sessionId/question-count
 * Returns the question count for an existing session's DFD and methodology.
 */
const getQuestionCount = (req, res) => {
    const { sessionId } = req.params;
    const session = aiContextStore.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ status: 404, message: 'Session not found' });
    }

    if (session.questionPlan) {
        return res.status(200).json({
            status: 200,
            message: 'Question plan retrieved from session',
            data: {
                methodology: session.questionPlan.methodology,
                totalQuestions: session.questionPlan.totalQuestions,
                breakdown: session.questionPlan.breakdown,
                byCategory: session.questionPlan.byCategory,
                estimatedRounds: session.questionPlan.estimatedRounds,
                progress: session.questionPlan.progress
            }
        });
    }

    // Compute on the fly from current model
    const cells = session.currentModel?.detail?.diagrams?.[0]?.cells || [];
    const methodology = session.methodology || 'STRIDE';
    const plan = questionPlanningEngine.computeQuestionPlan(cells, methodology);

    return res.status(200).json({
        status: 200,
        message: 'Question count computed from current model',
        data: {
            methodology: plan.methodology,
            totalQuestions: plan.totalQuestions,
            breakdown: plan.breakdown,
            byCategory: plan.byCategory,
            estimatedRounds: plan.estimatedRounds,
            progress: plan.progress
        }
    });
};

/**
 * POST /api/ai/question-count
 * Stateless endpoint: receives cells + methodology and returns question count without creating a session.
 */
const computeQuestionCountStateless = (req, res) => {
    const { cells = [], methodology = 'STRIDE' } = req.body;
    const plan = questionPlanningEngine.computeQuestionPlan(cells, methodology);

    return res.status(200).json({
        status: 200,
        message: 'Question count computed successfully',
        data: {
            methodology: plan.methodology,
            totalQuestions: plan.totalQuestions,
            breakdown: plan.breakdown,
            byCategory: plan.byCategory,
            estimatedRounds: plan.estimatedRounds,
            progress: plan.progress
        }
    });
};

/**
 * GET /api/ai/frameworks
 * Returns list of available threat modeling frameworks.
 */
const getAvailableFrameworks = (req, res) => {
    const frameworks = questionPlanningEngine.getAvailableFrameworks().map((key) => {
        const def = questionPlanningEngine.getFrameworkDefinition(key);
        return {
            key,
            name: def.name,
            description: def.description,
            categories: def.categories
        };
    });
    return res.status(200).json({
        status: 200,
        data: frameworks
    });
};

const updateSessionState = async (req, res) => {
    const { sessionId } = req.params;
    const { currentModel } = req.body;
    const session = aiContextStore.getSession(sessionId);
    if (!session) {
        return res.status(404).json({
            status: 404,
            message: 'Session not found'
        });
    }
    await aiContextStore.updateSession(sessionId, {
        currentModel: currentModel || session.currentModel
    });
    logger.info(`Updated current model in session ${sessionId} with user manual edits.`);
    return res.status(200).json({
        status: 200,
        message: 'Session model updated successfully'
    });
};

// Generates all pending questions via LLM for CSV export
const exportQuestions = async (req, res) => {
    const { sessionId } = req.params;
    logger.info(`[exportQuestions] Request received for session ${sessionId}`);

    try {
        const session = aiContextStore.getSession(sessionId);
        if (!session) {
            logger.warn(`[exportQuestions] Session not found: ${sessionId}`);
            return res.status(404).json({ status: 404, message: 'Session not found' });
        }

        const questionPlan = session.questionPlan;
        if (!questionPlan) {
            logger.warn(`[exportQuestions] Question plan not computed yet for session: ${sessionId}`);
            return res.status(400).json({ status: 400, message: 'Question plan not computed yet. Approve the DFD first.' });
        }

        const answeredIds = new Set(session.answeredQuestionIds || []);
        const answeredQuestions = session.answeredQuestions || [];
        const answeredMap = new Map();
        answeredQuestions.forEach((aq) => {
            if (aq.id) { answeredMap.set(aq.id, aq); }
        });

        // Collect ALL questions from the plan (pending + answered)
        const allQuestions = [];
        questionPlan.elementQuestions.forEach((elem) => {
            elem.categories.forEach((catGroup) => {
                catGroup.questions.forEach((q) => {
                    const existingAnswer = answeredMap.get(q.id);
                    allQuestions.push({
                        id: q.id,
                        category: catGroup.category,
                        elementId: elem.elementId,
                        elementName: elem.elementName,
                        elementType: elem.elementShape,
                        type: q.type,
                        questionText: q.questionText || '',
                        answered: answeredIds.has(q.id),
                        answer: existingAnswer ? existingAnswer.answer : '',
                        source: existingAnswer ? (existingAnswer.source || 'manual') : ''
                    });
                });
            });
        });

        // Add global questions
        (questionPlan.globalQuestions || []).forEach((gq, idx) => {
            const gqId = `global-q-${idx}`;
            const existingAnswer = answeredMap.get(gqId);
            allQuestions.push({
                id: gqId,
                category: 'Global',
                elementId: 'global',
                elementName: 'Sistema',
                elementType: 'global',
                type: 'global',
                questionText: gq,
                answered: answeredIds.has(gqId),
                answer: existingAnswer ? existingAnswer.answer : '',
                source: existingAnswer ? (existingAnswer.source || 'manual') : ''
            });
        });

        // Build AI config from session
        const provider = session.aiProvider || 'gemini';
        const aiConfig = {
            provider,
            apiKey: resolveApiKeyForSession(session),
            baseUrl: session.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: resolveModel(provider, session.customModel, session),
            extendedThinking: session.extendedThinking === true || session.extendedThinking === 'true'
        };

        if (!aiConfig.apiKey) {
            return badRequest(`API key is not configured for provider ${provider}.`, res, logger);
        }

        // Use LLM to generate contextual question texts
        const questionsWithoutText = allQuestions.filter((q) => !q.questionText);
        if (questionsWithoutText.length > 0) {
            const job = createJob();
            job.sessionId = sessionId;
            job.status = 'generating';
            job.progress = 10;
            activeJobs.set(job.jobId, { ...job });

            logger.info(`[exportQuestions] Started async generation of question texts for ${questionsWithoutText.length} questions in session ${sessionId}. Job ID: ${job.jobId}`);

            // Run asynchronously to prevent HTTP gateway timeout (504)
            (async () => {
                try {
                    // Build batches of up to 50 questions each for LLM generation
                    const batches = [];
                    for (let i = 0; i < questionsWithoutText.length; i += 50) {
                        batches.push(questionsWithoutText.slice(i, i + 50));
                    }

                    // Build system description context
                    const systemDescription = `System: ${session.title || 'Unknown'}\nDescription: ${session.description || 'N/A'}\nMethodology: ${questionPlan.methodology || 'STRIDE'}`;

                    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
                        const batch = batches[batchIdx];
                        const batchSummary = batch.map((q, idx) => `${idx + 1}. [${q.id}] Category: "${q.category}", Element: "${q.elementName}" (${q.elementType}), Type: ${q.type}`).join('\n');

                        const promptText = `
You are a security expert generating threat modeling assessment questions for a ${questionPlan.methodology} analysis.

${systemDescription}

Below is a list of question slots. For each one, generate a clear, specific, and actionable security question in Portuguese (pt-BR) that a security team would need to answer to properly assess the threat/control.

The question should be relevant to the specific element, category, and question type indicated.
- "threat_identification" questions ask about how a specific threat manifests for that element.
- "mitigation" questions ask what controls/mitigations are in place for that threat category on that element.
- "consolidated" questions ask BOTH how a specific threat manifests on that element AND what controls/mitigations are in place to address it.

Questions list:
${batchSummary}

Respond ONLY with a valid JSON array of objects, each with "id" and "questionText" fields. Example:
[
  {"id": "q-abc123", "questionText": "Como é feita a autenticação dos usuários no API Gateway?"},
  {"id": "q-def456", "questionText": "Quais controles de criptografia são utilizados para proteger os dados em trânsito no Data Flow entre o Frontend e o Backend?"}
]
`;
                        try {
                            const llmResponse = await callAIModel(promptText, [], aiConfig);
                            const parsed = extractJson(llmResponse);
                            if (Array.isArray(parsed)) {
                                parsed.forEach((item) => {
                                    const target = allQuestions.find((q) => q.id === item.id);
                                    if (target && item.questionText) {
                                        target.questionText = item.questionText;
                                    }
                                });
                            }
                        } catch (llmErr) {
                            logger.error(`[exportQuestions] LLM batch ${batchIdx + 1} failed: ${llmErr.message}`);
                        }

                        job.progress = 10 + Math.round(((batchIdx + 1) / batches.length) * 80);
                        activeJobs.set(job.jobId, { ...job });
                    }

                    // Fill any remaining questions without LLM text with template fallbacks
                    allQuestions.forEach((q) => {
                        if (!q.questionText) {
                            if (q.type === 'threat_identification') {
                                q.questionText = `[${q.category}] Como a ameaça "${q.category}" pode se manifestar no componente "${q.elementName}" (${q.elementType})?`;
                            } else if (q.type === 'mitigation') {
                                q.questionText = `[${q.category}] Quais controles ou mitigações estão implementados para a categoria "${q.category}" no componente "${q.elementName}" (${q.elementType})?`;
                            } else if (q.type === 'consolidated') {
                                q.questionText = `[${q.category}] Como a ameaça "${q.category}" pode se manifestar no componente "${q.elementName}" (${q.elementType}) e quais mitigações/controles estão implementados?`;
                            } else {
                                q.questionText = `[${q.category}] Avalie o componente "${q.elementName}" em relação à categoria "${q.category}".`;
                            }
                        }
                    });

                    // Update question texts in the session's question plan
                    const updatedElementQuestions = questionPlan.elementQuestions.map((elem) => ({
                        ...elem,
                        categories: elem.categories.map((cat) => ({
                            ...cat,
                            questions: cat.questions.map((q) => {
                                const matched = allQuestions.find((aq) => aq.id === q.id);
                                return {
                                    ...q,
                                    questionText: (matched && matched.questionText) ? matched.questionText : q.questionText
                                };
                            })
                        }))
                    }));

                    const updatedQuestionPlan = {
                        ...questionPlan,
                        elementQuestions: updatedElementQuestions
                    };

                    await aiContextStore.updateSession(sessionId, {
                        questionPlan: updatedQuestionPlan
                    });

                    job.status = 'completed';
                    job.progress = 100;
                    activeJobs.set(job.jobId, { ...job });
                    logger.info(`[exportQuestions] Async generation of question texts completed for session ${sessionId}. Job ID: ${job.jobId}`);

                } catch (asyncErr) {
                    logger.error(`[exportQuestions] Async generation error: ${asyncErr.message}`);
                    job.status = 'failed';
                    job.error = asyncErr.message;
                    activeJobs.set(job.jobId, { ...job });
                }
            })();

            return res.status(202).json({
                status: 202,
                message: 'Questions generation started asynchronously.',
                data: {
                    jobId: job.jobId,
                    sessionId,
                    status: job.status,
                    progress: job.progress
                }
            });
        }

        logger.info(`[exportQuestions] Returning questions directly (all have texts) for session ${sessionId}. Count: ${allQuestions.length}`);

        return res.status(200).json({
            status: 200,
            message: 'Questions exported successfully',
            data: {
                sessionId,
                methodology: questionPlan.methodology,
                systemTitle: session.title,
                systemDescription: session.description,
                totalQuestions: allQuestions.length,
                answeredCount: allQuestions.filter((q) => q.answered).length,
                pendingCount: allQuestions.filter((q) => !q.answered).length,
                questions: allQuestions
            }
        });

    } catch (err) {
        logger.error(`[exportQuestions] Error: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

// Bulk-applies answers from an imported CSV
const importAnswers = async (req, res) => {
    const { sessionId } = req.params;
    const { answers } = req.body; // Array of { id, answer }

    try {
        const session = aiContextStore.getSession(sessionId);
        if (!session) {
            return res.status(404).json({ status: 404, message: 'Session not found' });
        }

        if (!answers || !Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({ status: 400, message: 'answers array is required and must not be empty' });
        }

        const questionPlan = session.questionPlan;
        if (!questionPlan) {
            return res.status(400).json({ status: 400, message: 'Question plan not computed yet.' });
        }

        // Build map of valid question IDs and their official plan details
        const planQuestionsMap = new Map();
        questionPlan.elementQuestions.forEach((elem) => {
            elem.categories.forEach((catGroup) => {
                catGroup.questions.forEach((q) => {
                    planQuestionsMap.set(q.id, {
                        text: q.questionText || '',
                        elementId: elem.elementId,
                        elementName: elem.elementName,
                        category: catGroup.category
                    });
                });
            });
        });
        // Also add global questions
        (questionPlan.globalQuestions || []).forEach((gq, idx) => {
            const gqId = `global-q-${idx}`;
            planQuestionsMap.set(gqId, {
                text: gq,
                elementId: 'global',
                elementName: 'Sistema',
                category: 'Global'
            });
        });

        const sessionAnswered = session.answeredQuestions || [];
        const existingIds = new Set(sessionAnswered.map((q) => q.id));
        let importedCount = 0;
        let skippedCount = 0;

        answers.forEach((item) => {
            if (!item.id || !item.answer || item.answer.trim() === '') {
                skippedCount++;
                return;
            }

            let planQ = planQuestionsMap.get(item.id);
            let planQKey = item.id;

            if (!planQ) {
                const itemElemName = (item.elementName || '').trim().toLowerCase();
                const itemCat = (item.category || '').trim().toLowerCase();
                const itemText = (item.questionText || item.text || '').trim().replace(/\s+/g, ' ').toLowerCase();

                for (const [qId, qDetail] of planQuestionsMap.entries()) {
                    const qElemName = (qDetail.elementName || '').trim().toLowerCase();
                    const qCat = (qDetail.category || '').trim().toLowerCase();
                    const qText = (qDetail.text || '').trim().replace(/\s+/g, ' ').toLowerCase();

                    if (qElemName === itemElemName && qCat === itemCat) {
                        if (itemText && (qText === itemText || qText.includes(itemText) || itemText.includes(qText))) {
                            planQ = qDetail;
                            planQKey = qId;
                            break;
                        }
                    }
                }
            }

            if (!planQ) {
                logger.warn(`[importAnswers] Skipping unknown question ID: ${item.id}`);
                skippedCount++;
                return;
            }

            item.id = planQKey;

            const resolvedText = planQ.text || item.questionText || item.text || '';
            const resolvedElementId = planQ.elementId || item.elementId || 'global';
            const resolvedElementName = planQ.elementName || item.elementName || 'Sistema';
            const resolvedCategory = planQ.category || item.category || 'Importado';

            if (existingIds.has(item.id)) {
                // Update existing answer
                const existing = sessionAnswered.find((q) => q.id === item.id);
                if (existing) {
                    existing.answer = item.answer.trim();
                    existing.text = resolvedText;
                    existing.elementId = resolvedElementId;
                    existing.elementName = resolvedElementName;
                    existing.category = resolvedCategory;
                    existing.timestamp = new Date().toISOString();
                    existing.source = item.source || 'csv_import';
                }
            } else {
                sessionAnswered.push({
                    id: item.id,
                    text: resolvedText,
                    answer: item.answer.trim(),
                    elementId: resolvedElementId,
                    elementName: resolvedElementName,
                    category: resolvedCategory,
                    timestamp: new Date().toISOString(),
                    source: item.source || 'csv_import'
                });
                existingIds.add(item.id);
            }
            importedCount++;
        });

        // Update answeredQuestionIds
        const answeredQuestionIds = Array.from(new Set([
            ...(session.answeredQuestionIds || []),
            ...sessionAnswered.filter((q) => q.id && !q.id.startsWith('manual-req-')).map((q) => q.id)
        ]));

        // Recompute progress
        if (questionPlan) {
            questionPlan.progress = questionPlanningEngine.computeProgress(questionPlan, answeredQuestionIds);
            if (questionPlan.progress && questionPlan.progress.byCategory) {
                questionPlan.byCategory = questionPlan.progress.byCategory;
            }
        }

        // Rebuild history
        const rebuiltHistory = rebuildHistoryFromAnswered(sessionAnswered);

        // Save previous state for undo
        const previousHistory = session.history || [];
        if (session.currentModel) {
            previousHistory.push({
                currentModel: session.currentModel,
                questions: session.questions || [],
                evaluation: session.evaluation || null,
                refinementHistory: session.refinementHistory || [],
                dfdApproved: session.dfdApproved || false,
                threatModelApproved: session.threatModelApproved || false
            });
        }

        // Update session
        const updatedSession = await aiContextStore.updateSession(sessionId, {
            answeredQuestions: sessionAnswered,
            answeredQuestionIds,
            refinementHistory: rebuiltHistory,
            questionPlan,
            history: previousHistory
        });

        // Start async re-generation job
        const provider = session.aiProvider || 'gemini';
        const aiConfig = {
            provider,
            apiKey: resolveApiKeyForSession(session),
            baseUrl: session.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: resolveModel(provider, session.customModel, session),
            embeddingModel: session.customEmbeddingModel || env.get().config.BEDROCK_MANTLE_EMBEDDING_MODEL || 'amazon.titan-embed-text-v1',
            extendedThinking: session.extendedThinking === true || session.extendedThinking === 'true',
            maxContextTokens: session.maxContextTokens || null,
            questionBatchSize: session.questionBatchSize || null
        };

        const job = createJob();
        job.sessionId = sessionId;

        runGenerateJob(
            job,
            {
                title: updatedSession.title,
                description: updatedSession.description,
                currentModel: updatedSession.currentModel,
                dfdApproved: updatedSession.dfdApproved
            },
            updatedSession,
            updatedSession.docs || [],
            updatedSession.images || [],
            updatedSession.methodology || 'STRIDE',
            updatedSession.dfdApproved || false,
            aiConfig
        );

        logger.info(`[importAnswers] Imported ${importedCount} answers, skipped ${skippedCount}, for session ${sessionId}. Re-generation job: ${job.jobId}`);

        return res.status(202).json({
            status: 202,
            message: `Successfully imported ${importedCount} answers. ${skippedCount} were skipped. Re-generation started.`,
            data: {
                jobId: job.jobId,
                sessionId,
                importedCount,
                skippedCount,
                totalAnswered: answeredQuestionIds.length,
                totalQuestions: questionPlan.totalQuestions,
                progress: questionPlan.progress
            }
        });

    } catch (err) {
        logger.error(`[importAnswers] Error: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

// Uses LLM to match uploaded requirements/controls against pending questions
const applyRequirements = async (req, res) => {
    const { sessionId } = req.params;
    const { requirements } = req.body; // Array of { control, description, category, status }

    try {
        const session = aiContextStore.getSession(sessionId);
        if (!session) {
            return res.status(404).json({ status: 404, message: 'Session not found' });
        }

        if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
            return res.status(400).json({ status: 400, message: 'requirements array is required and must not be empty' });
        }

        const questionPlan = session.questionPlan;
        if (!questionPlan) {
            return res.status(400).json({ status: 400, message: 'Question plan not computed yet. Approve the DFD first.' });
        }

        // Build AI config
        const provider = session.aiProvider || 'gemini';
        const aiConfig = {
            provider,
            apiKey: resolveApiKeyForSession(session),
            baseUrl: session.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: resolveModel(provider, session.customModel, session),
            extendedThinking: session.extendedThinking === true || session.extendedThinking === 'true'
        };

        if (!aiConfig.apiKey) {
            return badRequest(`API key is not configured for provider ${provider}.`, res, logger);
        }

        // Collect pending questions
        const answeredIds = new Set(session.answeredQuestionIds || []);
        const pendingQuestions = [];
        questionPlan.elementQuestions.forEach((elem) => {
            elem.categories.forEach((catGroup) => {
                catGroup.questions.forEach((q) => {
                    if (!answeredIds.has(q.id)) {
                        pendingQuestions.push({
                            id: q.id,
                            category: catGroup.category,
                            elementId: elem.elementId,
                            elementName: elem.elementName,
                            elementType: elem.elementShape,
                            type: q.type
                        });
                    }
                });
            });
        });

        if (pendingQuestions.length === 0) {
            return res.status(200).json({
                status: 200,
                message: 'No pending questions to match against requirements.',
                data: { matchedCount: 0, pendingCount: 0, matches: [] }
            });
        }

        // Create async job
        const job = createJob();
        job.sessionId = sessionId;
        job.status = 'generating';
        job.progress = 10;
        activeJobs.set(job.jobId, { ...job });

        // Run matching asynchronously
        (async () => {
            try {
                // Format requirements for LLM
                const reqSummary = requirements.map((r, idx) => {
                    let line = `${idx + 1}. Controle: "${r.control || r.requisito || r.name || 'N/A'}"`;
                    if (r.description || r.descricao) {
                        line += ` | Descrição: "${r.description || r.descricao}"`;
                    }
                    if (r.category || r.categoria) {
                        line += ` | Categoria: "${r.category || r.categoria}"`;
                    }
                    if (r.status) {
                        line += ` | Status: "${r.status}"`;
                    }
                    return line;
                }).join('\n');

                // Process in batches of 30 pending questions
                const allMatches = [];
                const batchSize = 30;
                for (let i = 0; i < pendingQuestions.length; i += batchSize) {
                    const batch = pendingQuestions.slice(i, i + batchSize);
                    const qSummary = batch.map((q, idx) => `${idx + 1}. [${q.id}] Category: "${q.category}", Element: "${q.elementName}" (${q.elementType}), Type: ${q.type}`).join('\n');

                    const promptText = `
You are a security requirements analyst. You are given a list of security REQUIREMENTS/CONTROLS that are already implemented in a system, and a list of PENDING QUESTIONS from a ${questionPlan.methodology} threat modeling assessment.

Your task is to determine which questions can be automatically answered based on the implemented requirements/controls.

A question is "covered" by a requirement if the requirement directly addresses or mitigates the concern raised by the question's category and element. Only match with HIGH CONFIDENCE.

IMPLEMENTED REQUIREMENTS/CONTROLS:
${reqSummary}

PENDING QUESTIONS:
${qSummary}

System: "${session.title || 'N/A'}"
Description: "${session.description || 'N/A'}"

For each question that CAN be answered by one or more requirements, generate:
- The question ID
- The matched requirement(s) 
- An auto-generated answer in Portuguese explaining how the requirement covers this concern
- A confidence score (0.0 to 1.0)

ONLY include matches with confidence >= 0.7.

Respond ONLY with a valid JSON array. Example:
[
  {
    "questionId": "q-abc123",
    "matchedRequirements": ["Controle de Autenticação MFA"],
    "autoAnswer": "Este requisito é atendido pelo controle de Autenticação MFA implementado, que garante autenticação multifator para todos os acessos ao sistema.",
    "confidence": 0.9
  }
]

If no matches are found, respond with an empty array: []
`;

                    try {
                        const llmResponse = await callAIModel(promptText, [], aiConfig);
                        const parsed = extractJson(llmResponse);
                        if (Array.isArray(parsed)) {
                            allMatches.push(...parsed.filter((m) => m.questionId && m.autoAnswer && m.confidence >= 0.7));
                        }
                    } catch (llmErr) {
                        logger.error(`[applyRequirements] LLM batch failed: ${llmErr.message}`);
                    }

                    job.progress = 10 + Math.round(((i + batchSize) / pendingQuestions.length) * 70);
                    activeJobs.set(job.jobId, { ...job });
                }

                // Apply matches
                const sessionAnswered = session.answeredQuestions || [];
                const existingIds = new Set(sessionAnswered.map((q) => q.id));
                let matchedCount = 0;

                allMatches.forEach((match) => {
                    const qId = match.questionId;
                    if (!existingIds.has(qId)) {
                        const pq = pendingQuestions.find((q) => q.id === qId);
                        if (pq) {
                            sessionAnswered.push({
                                id: qId,
                                text: `[Auto-respondida por Requisito] ${match.matchedRequirements.join(', ')}`,
                                answer: match.autoAnswer,
                                elementId: pq.elementId,
                                elementName: pq.elementName,
                                category: pq.category,
                                timestamp: new Date().toISOString(),
                                source: 'requirements',
                                matchedRequirements: match.matchedRequirements,
                                confidence: match.confidence
                            });
                            existingIds.add(qId);
                            matchedCount++;
                        }
                    }
                });

                // Update session
                const updatedAnsweredIds = Array.from(new Set([
                    ...(session.answeredQuestionIds || []),
                    ...sessionAnswered.filter((q) => q.id && !q.id.startsWith('manual-req-')).map((q) => q.id)
                ]));

                if (questionPlan) {
                    questionPlan.progress = questionPlanningEngine.computeProgress(questionPlan, updatedAnsweredIds);
                    if (questionPlan.progress && questionPlan.progress.byCategory) {
                        questionPlan.byCategory = questionPlan.progress.byCategory;
                    }
                }

                const rebuiltHistory = rebuildHistoryFromAnswered(sessionAnswered);

                await aiContextStore.updateSession(sessionId, {
                    answeredQuestions: sessionAnswered,
                    answeredQuestionIds: updatedAnsweredIds,
                    refinementHistory: rebuiltHistory,
                    questionPlan,
                    requirements
                });

                job.status = 'completed';
                job.progress = 100;
                job.result = {
                    matchedCount,
                    totalRequirements: requirements.length,
                    totalPendingBefore: pendingQuestions.length,
                    totalPendingAfter: pendingQuestions.length - matchedCount,
                    matches: allMatches,
                    progress: questionPlan.progress
                };
                activeJobs.set(job.jobId, { ...job });

                logger.info(`[applyRequirements] Matched ${matchedCount}/${pendingQuestions.length} questions with ${requirements.length} requirements for session ${sessionId}`);

            } catch (asyncErr) {
                logger.error(`[applyRequirements] Async job error: ${asyncErr.message}`);
                job.status = 'failed';
                job.error = asyncErr.message;
                activeJobs.set(job.jobId, { ...job });
            }
        })();

        return res.status(202).json({
            status: 202,
            message: 'Requirements matching job started.',
            data: {
                jobId: job.jobId,
                sessionId,
                totalRequirements: requirements.length,
                totalPendingQuestions: pendingQuestions.length
            }
        });

    } catch (err) {
        logger.error(`[applyRequirements] Error: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const listActiveSessions = (req, res) => {
    try {
        const sessions = aiContextStore.listSessions();
        return res.status(200).json({
            status: 200,
            message: 'Sessions retrieved successfully',
            data: sessions
        });
    } catch (err) {
        logger.error(`Error listing active sessions: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const deleteSessionRoute = (req, res) => {
    const { sessionId } = req.params;
    try {
        const deleted = aiContextStore.deleteSession(sessionId);
        if (deleted) {
            return res.status(200).json({
                status: 200,
                message: 'Session successfully deleted'
            });
        }
        return res.status(404).json({
            status: 404,
            message: 'Session not found'
        });
    } catch (err) {
        logger.error(`Error deleting session ${sessionId}: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const exportSession = (req, res) => {
    const { sessionId } = req.params;
    try {
        const session = aiContextStore.getSession(sessionId);
        if (!session) {
            return res.status(404).json({
                status: 404,
                message: 'Session not found'
            });
        }
        
        const exportedSession = { ...session };
        if (exportedSession.apiKey) {
            exportedSession.apiKey = '*****';
        }
        
        return res.status(200).json({
            status: 200,
            message: 'Session exported successfully',
            data: exportedSession
        });
    } catch (err) {
        logger.error(`Error exporting session ${sessionId}: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

const importSessionRoute = async (req, res) => {
    try {
        const sessionData = req.body;
        if (!sessionData || !sessionData.title) {
            return res.status(400).json({
                status: 400,
                message: 'Invalid session data'
            });
        }
        
        const imported = await aiContextStore.importSession(sessionData);
        return res.status(200).json({
            status: 200,
            message: 'Session imported successfully',
            data: {
                sessionId: imported.sessionId,
                title: imported.title,
                methodology: imported.methodology
            }
        });
    } catch (err) {
        logger.error(`Error importing session: ${err.message}`);
        return serverError(err.message, res, logger);
    }
};

export default {
    generate,
    getSessionState,
    updateSessionState,
    undoRefinement,
    editAnswers,
    getDeduplicateProposals,
    applyDeduplication,
    getQuestionCount,
    computeQuestionCountStateless,
    getAvailableFrameworks,
    getJobStatus,
    exportQuestions,
    importAnswers,
    applyRequirements,
    deleteSessionRoute,
    listActiveSessions,
    exportSession,
    importSessionRoute,
    _areTitlesSimilar: areTitlesSimilar,
    _mergeDiagramCells: mergeDiagramCells,
    _mergeControlsAssessment: mergeControlsAssessment,
    _applyDeduplicationChanges: applyDeduplicationChanges,
    _extractJson: extractJson,
    _callAIModel: callAIModel,
    _clientFactory: clientFactory,
    _getMaxContextChars: getMaxContextChars,
    _getQuestionBatchSize: getQuestionBatchSize,
    _resolveModel: resolveModel
};
