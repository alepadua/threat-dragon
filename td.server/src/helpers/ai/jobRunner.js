/* eslint-disable */
import loggerHelper from '../logger.helper.js';
import aiContextStore from '../aiContextStore.js';
import questionPlanningEngine from '../questionPlanningEngine.js';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

// Import helpers
import { activeJobs } from './activeJobs.js';
import { 
    callAIModel, 
    getEmbeddingsBatch, 
    getMaxContextChars, 
    getQuestionBatchSize,
    retrieveContext
} from './aiClient.js';
import {
    buildCritiquePrompt,
    buildDedupAuditPrompt,
    buildGeneratorPrompt,
    buildMitigationRevisionPrompt,
    buildQuestionAgentPrompt,
    getMethodologyPrompt
} from './promptBuilder.js';
import {
    healDiagramCells,
    mergeControlsAssessment,
    mergeDiagramCells
} from './mergeEngine.js';
import {
    ensureModelMessageInHistory,
    extractJson,
    groupAndConsolidateQuestions,
    healParsedConsolidatedQuestions,
    splitTextIntoChunks,
    compressModelForPrompt,
    managePromptContext
} from './utils.js';

const logger = loggerHelper.get('helpers/ai/jobRunner.js');

export const extractTextFromDocs = (docs) => {
    if (!docs || docs.length === 0) { return []; }
    
    const docPromises = docs.map(async (doc, idx) => {
        let contentText = '';
        if (doc.name.endsWith('.docx')) {
            try {
                const base64Data = doc.content.replace(/^data:application\/vnd\.openxmlformats-officedocument\/wordprocessingml\.document;base64,/u, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const result = await mammoth.extractRawText({ buffer });
                contentText = result.value;
            } catch (docxErr) {
                logger.error(`Failed to parse docx file ${doc.name}: ${docxErr.message}`);
                contentText = '(Word Document parsing failed)';
            }
        } else if (doc.name.toLowerCase().endsWith('.pdf')) {
            try {
                const base64Data = doc.content.replace(/^data:application\/pdf;base64,/u, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const result = await new PDFParse({ data: buffer }).getText();
                contentText = result.text;
            } catch (pdfErr) {
                logger.error(`Failed to parse pdf file ${doc.name}: ${pdfErr.message}`);
                contentText = '(PDF parsing failed)';
            }
        } else {
            contentText = doc.content;
        }
        return {
            name: doc.name,
            text: `\n--- Document [${idx + 1}]: ${doc.name} ---\n${contentText}\n`
        };
    });
    return Promise.all(docPromises);
};

export const generateAndSaveEmbeddings = async (sessionId, docsTexts, aiConfig) => {
    if (!docsTexts || docsTexts.length === 0) { return; }
    try {
        let allChunks = [];
        docsTexts.forEach((docText) => {
            const chunks = splitTextIntoChunks(docText.text);
            chunks.forEach((chunk, chunkIdx) => {
                allChunks.push({
                    docName: docText.name,
                    chunkIndex: chunkIdx,
                    text: chunk
                });
            });
        });

        if (allChunks.length > 1000) {
            logger.warn(`Session ${sessionId} has ${allChunks.length} chunks. Capping to 1000.`);
            allChunks = allChunks.slice(0, 1000);
        }

        if (allChunks.length > 0) {
            logger.info(`Generating embeddings for ${allChunks.length} chunks in session ${sessionId}...`);
            const rawEmbeddings = await getEmbeddingsBatch(allChunks.map((c) => c.text), aiConfig);
            const chunksWithVectors = allChunks.map((chunk, idx) => ({
                ...chunk,
                vector: rawEmbeddings[idx] || []
            }));
            aiContextStore.saveVectors(sessionId, chunksWithVectors);
        }
    } catch (embErr) {
        logger.error(`Failed to generate/save embeddings for session ${sessionId}: ${embErr.message}`);
    }
};

export const runGenerateJob = async (job, body, activeSession, finalDocs, finalImages, finalMethodology, dfdApprovedBool, aiConfig) => {
    try {
        const {
            title,
            description,
            currentModel,
            refinementHistory: bodyRefinementHistory,
            threatModelApproved
        } = body;

        const refinementHistory = (activeSession && activeSession.refinementHistory) || bodyRefinementHistory || [];

        // Pre-compute the question plan early on DFD approval transition so that questions are assigned in Phase 2's first prompt
        if (dfdApprovedBool && activeSession && !activeSession.questionPlan && currentModel) {
            const diagramCells = currentModel.detail?.diagrams?.[0]?.cells || [];
            if (diagramCells.length > 0) {
                activeSession.questionPlan = questionPlanningEngine.computeQuestionPlan(diagramCells, finalMethodology);
                logger.info(`[Job ${job.jobId}] Pre-computed question plan on transition: ${activeSession.questionPlan.totalQuestions} questions for ${finalMethodology}`);
            }
        }

        const agentName = !dfdApprovedBool ? 'DFDAgent' : 'ThreatAgent';
        let threatModelApprovedBool = (threatModelApproved === true || threatModelApproved === 'true');

        const customizeStageModels = activeSession && (activeSession.customizeStageModels === true || activeSession.customizeStageModels === 'true');
        
        const getStageConfig = (stagePrefix, baseConfig) => {
            if (!customizeStageModels) {
                return baseConfig;
            }
            const stageModel = activeSession[`${stagePrefix}Model`];
            const stageExtended = activeSession[`${stagePrefix}ExtendedThinking`];
            return {
                ...baseConfig,
                model: (stageModel && stageModel.trim() !== '') ? stageModel : baseConfig.model,
                extendedThinking: stageExtended === true || stageExtended === 'true'
            };
        };

        job.status = 'generating';
        job.progress = 10;
        activeJobs.set(job.jobId, { ...job });

        let docsTexts = [];
        if (finalDocs && finalDocs.length > 0) {
            docsTexts = await extractTextFromDocs(finalDocs);
        }

        const fullDocText = docsTexts.map((d) => d.text).join('');
        const maxContextChars = getMaxContextChars(aiConfig);
        const skipRag = fullDocText.length <= maxContextChars;

        if (docsTexts.length > 0 && !skipRag && (!activeSession || !activeSession.embeddingsGenerated)) {
            // Stage 1: Local RAG Chunking and Embedding Generation
            await generateAndSaveEmbeddings(activeSession.sessionId, docsTexts, aiConfig);
            await aiContextStore.updateSession(activeSession.sessionId, { embeddingsGenerated: true });
        }

        job.progress = 25;
        activeJobs.set(job.jobId, { ...job });

        // Process / Retrieve context from RAG
        let docsContext = '';
        if (docsTexts.length > 0) {
            if (skipRag) {
                logger.info(`[runGenerateJob] Documentation length (${fullDocText.length} chars) is within context limit (${maxContextChars} chars) for ${aiConfig.provider}/${aiConfig.model}. Skipping RAG and sending full documentation.`);
                docsContext = fullDocText;
            } else {
                // Otherwise, use RAG retrieval
                const lastUserMsg = refinementHistory && [...refinementHistory].reverse().find((msg) => msg.role === 'user');
                const baseQuery = lastUserMsg ? lastUserMsg.text : `${title || ''} ${description || ''}`.trim() || 'threat model architecture overview';
                let critiqueContextQuery = '';
                if (activeSession && activeSession.evaluation && activeSession.evaluation.feedback) {
                    critiqueContextQuery = ' ' + activeSession.evaluation.feedback.slice(0, 300);
                }
                const expandedQuery = `${baseQuery} network boundaries databases actors data flows microservices components security${critiqueContextQuery}`.trim();

                // Get RAG context
                docsContext = await retrieveContext(expandedQuery, activeSession.sessionId, aiConfig);

                if (!docsContext || docsContext.trim() === '') {
                    logger.warn('RAG retrieval returned empty context. Falling back to first 12,000 characters of full documentation.');
                    docsContext = fullDocText.slice(0, 12000) + '\n... [Conteúdo restante omitido por limite de contexto] ...\n';
                }
            }
        } else {
            docsContext = '\nNo documentation files provided.\n';
        }

        // Stage 3: Methodology Selection Prompts
        const methodologyPrompt = getMethodologyPrompt(finalMethodology);

        let roundGroups = [];
        let activeQuestionsPrompt = '';
        let questionsInstruction = '';
        let previousQuestionsPrompt = '';
        let jsonKeysInstruction = '';

        if (!dfdApprovedBool) {
            questionsInstruction = `An array containing EXACTLY ONE string in Portuguese.
You are strictly FORBIDDEN from generating custom clarifying questions or asking about security controls, authentication, protocols, encryption, logging, or threats in this phase.
Instead, you MUST return exactly this single validation string:
"Por favor, valide o diagrama de fluxo de dados (DFD) proposto acima. Se houver algum componente, fluxo ou fronteira de confiança faltando ou incorreto, descreva os ajustes necessários. Se estiver de acordo, clique em \\"Yes, DFD is Complete\\" para prosseguir para a análise de ameaças."`;
            
            jsonKeysInstruction = `You MUST return ONLY a JSON object containing two keys:
1. "questions": ${questionsInstruction}
2. "threatModel": The valid Threat Dragon V2 JSON object containing the summary and detail (diagrams, cells, and threats).`;
        } else {
            if (activeSession && activeSession.questionPlan) {
                const answeredIds = activeSession.answeredQuestionIds || [];
                const currentQuestionIds = (activeSession.questions || []).map((q) => q.id || q);
                const combinedIds = Array.from(new Set([...answeredIds, ...currentQuestionIds]));
                const batchSize = getQuestionBatchSize(aiConfig);
                roundGroups = groupAndConsolidateQuestions(activeSession.questionPlan, combinedIds, batchSize);
                
                if (roundGroups && roundGroups.length > 0) {
                    activeQuestionsPrompt = '\n--- ASSIGNED CONSOLIDATED QUESTION GROUPS FOR THIS ROUND ---\n';
                    activeQuestionsPrompt += 'You MUST generate exactly one consolidated, direct, and technical question in Portuguese for each group below. This question should address the specified category across all listed elements in that group. Do NOT generate questions for other elements or categories:\n';
                    roundGroups.forEach((g) => {
                        const elemNames = g.elements.map((e) => e.name).join(', ');
                        activeQuestionsPrompt += `- Group ID: "${g.id}" | Category: "${g.category}" | Element Type: "${g.elementType}" | Elements: [${elemNames}]\n`;
                    });
                    activeQuestionsPrompt += '\n';
                }
            }

            questionsInstruction = `An array of objects matching the ASSIGNED CONSOLIDATED QUESTION GROUPS list. Each object MUST have:
- "id": The exact "Group ID" string from the assigned list.
- "originalQuestionIds": The array of original Question IDs mapped to this group (must match the originalQuestionIds from the group definition).
- "category": The exact "Category" string from the group definition.
- "text": A single consolidated, technical, specific question in Portuguese addressing all the elements in the group for that category.

If no groups are assigned, return an empty array [].`;

            if (activeQuestionsPrompt) {
                questionsInstruction += '\n' + activeQuestionsPrompt;
            }

            if (activeSession && activeSession.questions && activeSession.questions.length > 0) {
                previousQuestionsPrompt = '\n--- QUESTIONS ASKED IN PREVIOUS ROUND ---\n';
                previousQuestionsPrompt += 'The user has provided answers/feedback in the conversation history to these specific questions from the previous round:\n';
                activeSession.questions.forEach((q) => {
                    const qId = q.id || '';
                    const qText = q.text || q;
                    previousQuestionsPrompt += `- Question ID: "${qId}" | Text: "${qText}"\n`;
                });
                previousQuestionsPrompt += '\nCompare the user answers in REFINEMENT CONVERSATION HISTORY against this list. If the user successfully answered/resolved/mitigated a question, include its Question ID in the "resolvedQuestionIds" array.\n';
            }

            jsonKeysInstruction = `You MUST return ONLY a JSON object containing three keys:
1. "questions": ${questionsInstruction}
2. "resolvedQuestionIds": An array of strings containing the Question IDs (from the previous round) that have been successfully answered/mitigated by the user.
3. "threatDeltas": An array of objects. Each object MUST represent the new or updated threats for a single element/flow and contain:
   - "cellId": The exact ID string of the element/flow (from the system diagram).
   - "threats": An array of threat objects for this element conforming to the threat schema:
     - "id": A unique UUID string or new ID (e.g. "threat-xxxx").
     - "title": A concise, descriptive title in Portuguese.
     - "type": One of the STRIDE/F3 categories matching the element shape rules.
     - "description": A detailed explanation of the threat in Portuguese.
     - "mitigation": Specific technical steps or configuration changes recommended to mitigate the threat in Portuguese.
     - "status": "Open", "Mitigated", or "Accepted".
     - "severity": "High", "Medium", or "Low".
     - "score": A completion score (0-100) indicating mitigation status or severity.
     - "modelType": Exactly "STRIDE" or "MITRE_F3" (matching methodology).
     - "number": A unique sequential integer.

${previousQuestionsPrompt}`;
        }

        const compressedModel = compressModelForPrompt(currentModel);
        const maxContextCharsLimit = getMaxContextChars(aiConfig);
        const managed = managePromptContext(docsContext, refinementHistory, compressedModel, maxContextCharsLimit);
        const managedDocsContext = managed.docsContext;
        const managedRefinementHistory = managed.refinementHistory;

        const promptText = buildGeneratorPrompt({
            dfdApprovedBool,
            title,
            description,
            activeSession: {
                ...activeSession,
                refinementHistory: managedRefinementHistory
            },
            docsContext: managedDocsContext,
            finalMethodology,
            roundGroups,
            activeQuestionsPrompt,
            previousQuestionsPrompt,
            questionsInstruction,
            jsonKeysInstruction,
            methodologyPrompt,
            currentModel: compressedModel
        });

        // Call 1: Generator Model
        logger.info(`[Job ${job.jobId}] [${agentName}] Sending request to AI Provider (${aiConfig.provider}) for generation`);
        
        job.progress = 35;
        activeJobs.set(job.jobId, { ...job });

        const generatorConfig = {
            ...getStageConfig('generator', aiConfig),
            temperature: 0.1
        };
        const responseText = await callAIModel(promptText, finalImages, generatorConfig, job);

        if (!responseText) {
            throw new Error('AI API returned an empty response during generation');
        }

        let parsedOutput;
        try {
            parsedOutput = extractJson(responseText, finalMethodology);
            if (currentModel && parsedOutput && parsedOutput.threatModel) {
                // Use original currentModel and refinementHistory for local cell merging logic
                parsedOutput.threatModel = mergeDiagramCells(currentModel, parsedOutput.threatModel, refinementHistory, dfdApprovedBool);
            }
        } catch (parseErr) {
            logger.error(`[Job ${job.jobId}] Failed to parse LLM generation output: ${parseErr.message}`);
            throw parseErr;
        }

        if (!parsedOutput) {
            throw new Error('Failed to parse generation output JSON.');
        }

        const criticAgentName = !dfdApprovedBool ? 'DFDCriticAgent' : 'ThreatCriticAgent';

        // Critic/Auditor Step
        const getCritique = async (threatModel, questionsCount, isDfdApproved) => {
            const compressedThreatModel = compressModelForPrompt(threatModel);
            const managedCritiqueContext = managePromptContext(docsContext, refinementHistory, compressedThreatModel, maxContextCharsLimit);
            
            const critiquePromptText = buildCritiquePrompt({
                isDfdApproved,
                docsContext: managedCritiqueContext.docsContext,
                threatModel: compressedThreatModel,
                activeSession: {
                    ...activeSession,
                    refinementHistory: managedCritiqueContext.refinementHistory
                },
                questionsCount
            });

            let evalResult = {
                completenessScore: 40,
                criteria: {
                    elementCoverage: 50,
                    unresolvedQuestionsCount: questionsCount,
                    mitigationCompleteness: 30,
                    missingElements: [],
                    missingBoundaries: [],
                    missingMetadata: []
                },
                status: 'Refining',
                feedback: 'Evaluation fallback due to critique step issue.',
                controlsAssessment: []
            };

            try {
                logger.info(`[Job ${job.jobId}] [${criticAgentName}] Auditing model...`);
                const criticConfig = {
                    ...getStageConfig('critic', aiConfig),
                    temperature: 0.5
                };
                const criticResponseText = await callAIModel(critiquePromptText, [], criticConfig, job);

                if (criticResponseText) {
                    const parsedCritique = extractJson(criticResponseText);
                    if (parsedCritique.evaluation) {
                        evalResult = parsedCritique.evaluation;
                    }
                }
            } catch (criticErr) {
                logger.warn(`[Job ${job.jobId}] Critique step failed, falling back to default evaluation: ${criticErr.message}`);
            }
            return evalResult;
        };

        let evaluation = await getCritique(parsedOutput.threatModel, parsedOutput.questions?.length || 3, dfdApprovedBool);

        // Self-Correction Loop: If the critic score is low, perform one automatic correction round (if enabled)
        const enableSelfCorrection = activeSession && activeSession.enableSelfCorrection !== false && activeSession.enableSelfCorrection !== 'false' && process.env.AI_ENABLE_SELF_CORRECTION !== 'false';
        if (enableSelfCorrection && evaluation.completenessScore < 80) {
            job.status = 'revising';
            job.progress = 75;
            activeJobs.set(job.jobId, { ...job });

            logger.info(`[Job ${job.jobId}] Initial completeness score is ${evaluation.completenessScore}/100. Triggering automatic self-correction revision pass...`);
            
            const revisionPromptText = `${promptText}

--- REVISION/CORRECTION REQUEST ---
An independent security auditor has reviewed your first draft of the Threat Dragon V2 model and identified the following gaps, errors, or feedback:
"${evaluation.feedback}"

You MUST revise and correct the threat model to address all these points. Specifically:
1. Ensure all elements are fully connected with flows (no isolated components).
2. Remove any hallucinated components that are not present in the system documentation.
3. Decompose any excessively grouped components.
4. Correct layout coordinates using the tier rules to prevent overlaps.

Return ONLY a JSON object containing the keys "${dfdApprovedBool ? 'threatDeltas' : 'threatModel'}" and "questions" (as specified in the original instructions). Do not wrap the JSON output in markdown formatting.
`;

            try {
                const revisionConfig = {
                    ...getStageConfig('revision', aiConfig),
                    temperature: 0.1
                };
                const revResponseText = await callAIModel(revisionPromptText, finalImages, revisionConfig, job);

                const parsedRevision = revResponseText ? extractJson(revResponseText, finalMethodology) : null;
                if (parsedRevision && parsedRevision.threatModel) {
                    const originalResolved = parsedOutput.resolvedQuestionIds;
                    const originalQuestions = parsedOutput.questions;
                    parsedOutput = parsedRevision;
                    if (!parsedOutput.resolvedQuestionIds && originalResolved) {
                        parsedOutput.resolvedQuestionIds = originalResolved;
                    }
                    if ((!parsedOutput.questions || parsedOutput.questions.length === 0) && originalQuestions && originalQuestions.length > 0) {
                        parsedOutput.questions = originalQuestions;
                    }
                    // Use original currentModel and refinementHistory for local cell merging logic
                    parsedOutput.threatModel = mergeDiagramCells(currentModel, parsedOutput.threatModel, refinementHistory, dfdApprovedBool);
                    logger.info(`[Job ${job.jobId}] Successfully received revised threat model from self-correction loop. Re-evaluating revised model...`);
                    evaluation = await getCritique(parsedOutput.threatModel, parsedOutput.questions?.length || 3, dfdApprovedBool);
                }
            } catch (revErr) {
                logger.error(`[Job ${job.jobId}] Self-correction revision pass failed: ${revErr.message}`);
            }
        }

        // Incrementally merge security controls assessments from previous rounds
        if (activeSession && activeSession.evaluation && activeSession.evaluation.controlsAssessment) {
            evaluation.controlsAssessment = mergeControlsAssessment(
                activeSession.evaluation.controlsAssessment,
                evaluation.controlsAssessment
            );
        }

        // Filter controlsAssessment to ensure no hallucinated/unanswered items are retained
        if (evaluation.controlsAssessment && Array.isArray(evaluation.controlsAssessment)) {
            const realAnswers = (activeSession.answeredQuestions || []).filter((q) => q.id && !q.id.startsWith('manual-req-'));
            if (realAnswers.length === 0) {
                evaluation.controlsAssessment = [];
            } else {
                evaluation.controlsAssessment = evaluation.controlsAssessment.filter((assessment) => {
                    if (!assessment || !assessment.userAnswer) { return false; }
                    const cleanUserAnswer = assessment.userAnswer.toLowerCase().trim();
                    return realAnswers.some((q) => {
                        const cleanActual = q.answer.toLowerCase().trim();
                        return cleanActual.includes(cleanUserAnswer) || cleanUserAnswer.includes(cleanActual);
                    });
                });
            }
        }

        // Cache the latest model, questions, and evaluation in the session context store
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

        let questionPlan = activeSession.questionPlan || null;
        const answeredQuestionIds = activeSession.answeredQuestionIds || [];

        if (dfdApprovedBool && parsedOutput.threatModel) {
            const diagramCells = parsedOutput.threatModel.detail?.diagrams?.[0]?.cells || [];
            if (!questionPlan) {
                questionPlan = questionPlanningEngine.computeQuestionPlan(diagramCells, finalMethodology);
                logger.info(`[Job ${job.jobId}] Question plan computed: ${questionPlan.totalQuestions} questions for ${finalMethodology} across ${diagramCells.length} cells`);
            }

            if (questionPlan) {
                const previousAnsweredIds = activeSession.answeredQuestionIds || [];
                const currentQuestionIds = (activeSession.questions || []).map((q) => q.id || q);
                const combinedIds = Array.from(new Set([...previousAnsweredIds, ...currentQuestionIds]));
                const batchSize = getQuestionBatchSize(aiConfig);
                roundGroups = groupAndConsolidateQuestions(questionPlan, combinedIds, batchSize);
            }

            // Step 2: Decoupled Question Generator (Phase 2 only)
            if (roundGroups && roundGroups.length > 0) {
                const compressedOutputModel = compressModelForPrompt(parsedOutput.threatModel);
                const managedQuestions = managePromptContext(docsContext, refinementHistory, compressedOutputModel, maxContextCharsLimit);
                const questionsPrompt = buildQuestionAgentPrompt(activeQuestionsPrompt, compressedOutputModel, managedQuestions.refinementHistory);

                try {
                    logger.info(`[Job ${job.jobId}] [QuestionAgent] Sending request to AI Provider (${aiConfig.provider}) for decoupled question generation`);
                    const questionsConfig = {
                        ...getStageConfig('generator', aiConfig),
                        temperature: 0.5
                    };
                    const questionsResponseText = await callAIModel(questionsPrompt, [], questionsConfig, job);
                    const parsedQuestions = questionsResponseText ? extractJson(questionsResponseText, finalMethodology) : null;
                    if (parsedQuestions && parsedQuestions.questions) {
                        parsedOutput.questions = parsedQuestions.questions;
                    } else {
                        logger.warn(`[Job ${job.jobId}] Decoupled question generation did not return valid questions list.`);
                    }
                } catch (qErr) {
                    logger.error(`[Job ${job.jobId}] Error during decoupled question generation: ${qErr.message}`);
                }
            }

            parsedOutput.questions = healParsedConsolidatedQuestions(parsedOutput.questions, roundGroups);

            if (parsedOutput.resolvedQuestionIds && Array.isArray(parsedOutput.resolvedQuestionIds)) {
                parsedOutput.resolvedQuestionIds.forEach((id) => {
                    if (id && typeof id === 'string') {
                        if (!answeredQuestionIds.includes(id)) {
                            answeredQuestionIds.push(id);
                        }
                        
                        const matchedGroup = (activeSession.questions || []).find((q) => q.id === id);
                        if (matchedGroup && Array.isArray(matchedGroup.originalQuestionIds)) {
                            matchedGroup.originalQuestionIds.forEach((origId) => {
                                if (!answeredQuestionIds.includes(origId)) {
                                    answeredQuestionIds.push(origId);
                                }
                            });
                        }
                    }
                });
            }

            if (questionPlan.elementQuestions) {
                questionPlan.elementQuestions.forEach((elem) => {
                    elem.categories.forEach((catGroup) => {
                        catGroup.questions.forEach((q) => {
                            if (answeredQuestionIds.includes(q.id)) {
                                q.answered = true;
                            }
                        });
                    });
                });
            }

            if (questionPlan.plannedQuestions) {
                questionPlan.plannedQuestions.forEach((q) => {
                    if (answeredQuestionIds.includes(q.id)) {
                        q.answered = true;
                    }
                });
            }

            questionPlan.progress = questionPlanningEngine.computeProgress(questionPlan, answeredQuestionIds);
            if (questionPlan.progress && questionPlan.progress.byCategory) {
                questionPlan.byCategory = questionPlan.progress.byCategory;
            }

            if (questionPlan.progress && questionPlan.progress.answered >= questionPlan.progress.total && questionPlan.progress.total > 0) {
                threatModelApprovedBool = true;
                parsedOutput.questions = [];
            }
        }

        if (threatModelApprovedBool) {
            if (!evaluation) {
                evaluation = {
                    status: 'Ready',
                    completenessScore: 100,
                    feedback: 'Threat model successfully approved and concluded.',
                    controlsAssessment: []
                };
            } else {
                evaluation.status = 'Ready';
                evaluation.completenessScore = 100;
            }
        }

        const isTransition = dfdApprovedBool && (!activeSession || !activeSession.dfdApproved);
        const historyToUse = isTransition ? [] : (refinementHistory || []);
        const updatedHistory = ensureModelMessageInHistory(historyToUse, parsedOutput.questions, dfdApprovedBool);

        const updatedSession = await aiContextStore.updateSession(activeSession.sessionId, {
            currentModel: parsedOutput.threatModel,
            questions: parsedOutput.questions || [],
            evaluation: evaluation,
            history: previousHistory,
            dfdApproved: dfdApprovedBool,
            threatModelApproved: threatModelApprovedBool,
            questionPlan: questionPlan,
            answeredQuestionIds: answeredQuestionIds,
            refinementHistory: updatedHistory
        });

        logger.info(`[Job ${job.jobId}] Threat model session round processed. Session ID: ${activeSession.sessionId}`);
        
        job.status = 'completed';
        job.progress = 100;
        job.result = {
            threatModel: parsedOutput.threatModel,
            questions: parsedOutput.questions || [],
            evaluation: evaluation,
            sessionId: activeSession.sessionId,
            dfdApproved: dfdApprovedBool,
            threatModelApproved: threatModelApprovedBool,
            refinementHistory: updatedHistory,
            answeredQuestions: updatedSession.answeredQuestions || [],
            questionPlan: questionPlan ? {
                methodology: questionPlan.methodology,
                totalQuestions: questionPlan.totalQuestions,
                breakdown: questionPlan.breakdown,
                byCategory: questionPlan.progress?.byCategory || questionPlan.byCategory,
                estimatedRounds: questionPlan.estimatedRounds,
                progress: questionPlan.progress
            } : null
        };
        activeJobs.set(job.jobId, { ...job });

    } catch (err) {
        const errMessage = err?.message || String(err);
        logger.error(`[Job ${job.jobId}] Background generation job failed: ${errMessage}`);
        job.status = 'failed';
        job.progress = 100;
        job.error = errMessage;
        activeJobs.set(job.jobId, { ...job });
    }
};

export const runDeduplicateJob = async (job, body, session) => {
    try {
        const {
            aiProvider,
            customBaseUrl,
            customModel,
            apiKey: clientApiKey,
            customizeStageModels,
            deduplicatorModel,
            deduplicatorExtendedThinking
        } = body;

        const customizeStageModelsVal = customizeStageModels !== undefined ? (customizeStageModels === true || customizeStageModels === 'true') : (session.customizeStageModels === true || session.customizeStageModels === 'true');
        const dedupModelVal = deduplicatorModel || session.deduplicatorModel;
        const dedupExtendedVal = deduplicatorExtendedThinking !== undefined ? (deduplicatorExtendedThinking === true || deduplicatorExtendedThinking === 'true') : (session.deduplicatorExtendedThinking === true || session.deduplicatorExtendedThinking === 'true');

        const provider = aiProvider || session.aiProvider || 'gemini';
        const baseModel = customModel || session.customModel || (provider === 'bedrock-mantle' ? (process.env.BEDROCK_MANTLE_MODEL || 'meta.llama3-70b-instruct-v1:0') : (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'));
        const baseExtendedThinking = body.extendedThinking !== undefined ? (body.extendedThinking === true || body.extendedThinking === 'true') : (session.extendedThinking === true || session.extendedThinking === 'true');

        const aiConfig = {
            provider: provider,
            apiKey: clientApiKey || session.apiKey || (provider === 'bedrock-mantle' ? process.env.BEDROCK_MANTLE_API_KEY : process.env.GEMINI_API_KEY),
            baseUrl: customBaseUrl || session.customBaseUrl || process.env.BEDROCK_MANTLE_BASE_URL,
            model: (customizeStageModelsVal && dedupModelVal && dedupModelVal.trim() !== '') ? dedupModelVal : baseModel,
            extendedThinking: customizeStageModelsVal ? dedupExtendedVal : baseExtendedThinking
        };

        logger.info(`[AI Deduplicate Job] Incoming body: ${JSON.stringify({
            aiProvider,
            customBaseUrl,
            customModel,
            hasApiKey: Boolean(clientApiKey),
            apiKeyLength: clientApiKey ? clientApiKey.length : 0
        })}`);

        logger.info(`[AI Deduplicate Job] Resolved aiConfig: ${JSON.stringify({
            provider: aiConfig.provider,
            baseUrl: aiConfig.baseUrl,
            model: aiConfig.model,
            hasApiKey: Boolean(aiConfig.apiKey),
            apiKeyLength: aiConfig.apiKey ? aiConfig.apiKey.length : 0
        })}`);

        if (!aiConfig.apiKey) {
            throw new Error(`API key is not configured for provider ${provider}.`);
        }

        job.status = 'generating';
        job.progress = 30;
        activeJobs.set(job.jobId, { ...job });

        const currentModel = session.currentModel;
        const compressedModel = compressModelForPrompt(currentModel);
        const controlsAssessment = session.evaluation?.controlsAssessment || [];

        // Build docsContext
        const docs = session.docs || [];
        let docsContext = '';
        if (docs && docs.length > 0) {
            docsContext = docs.map((d) => `--- DOCUMENT: ${d.name} ---\n${d.content}`).join('\n\n');
        } else {
            docsContext = '\nNo documentation files provided.\n';
        }

        // Build historyContext
        const refinementHistory = session.refinementHistory || [];
        const maxContextCharsLimit = getMaxContextChars(aiConfig);
        const managed = managePromptContext(docsContext, refinementHistory, compressedModel, maxContextCharsLimit);
        const managedDocsContext = managed.docsContext;

        let historyContext = '';
        if (managed.refinementHistory && managed.refinementHistory.length > 0) {
            managed.refinementHistory.forEach((msg) => {
                historyContext += `${msg.role.toUpperCase()}: ${msg.text}\n`;
            });
        } else {
            historyContext = '\nNo refinement conversation history.\n';
        }

        if (session.answeredQuestions && session.answeredQuestions.length > 0) {
            historyContext += `\n\n--- USER-PROVIDED ANSWERS AND COMPONENT SPECIFICATIONS ---\n`;
            session.answeredQuestions.forEach((q) => {
                historyContext += `\nElement/Flow: "${q.elementName || 'Global'}" | Category: "${q.category || ''}"\n`;
                historyContext += `- Question: ${q.text}\n`;
                historyContext += `- User Answer: ${q.answer}\n`;
            });
        }

        const promptTextDedupAudit = buildDedupAuditPrompt(compressedModel, controlsAssessment, managedDocsContext, historyContext);
        const promptTextMitigationRevision = buildMitigationRevisionPrompt(compressedModel, managedDocsContext, historyContext);

        logger.info(`[Job ${job.jobId}] Requesting sequential deduplication/audit and mitigation/revision jobs from AI Provider (${aiConfig.provider})`);
        
        job.progress = 40;
        activeJobs.set(job.jobId, { ...job });

        const dedupConfig = { ...aiConfig, temperature: 0.1 };
        const responseDedupAudit = await callAIModel(promptTextDedupAudit, [], dedupConfig, job);

        job.progress = 70;
        activeJobs.set(job.jobId, { ...job });

        const responseMitigationRevision = await callAIModel(promptTextMitigationRevision, [], dedupConfig, job);
        
        if (!responseDedupAudit || !responseMitigationRevision) {
            throw new Error('AI API returned an empty response for one or both of the parallel jobs');
        }

        const parsedDedupAudit = extractJson(responseDedupAudit);
        const parsedMitigationRevision = extractJson(responseMitigationRevision);

        // Augment mitigationStatus with original threat description and mitigation
        const allThreats = [];
        if (currentModel && currentModel.detail && currentModel.detail.diagrams) {
            currentModel.detail.diagrams.forEach((diagram) => {
                if (diagram.cells) {
                    diagram.cells.forEach((cell) => {
                        const cellThreats = cell.data?.threats || [];
                        allThreats.push(...cellThreats);
                    });
                }
            });
        }

        if (parsedMitigationRevision.mitigationStatus && Array.isArray(parsedMitigationRevision.mitigationStatus)) {
            parsedMitigationRevision.mitigationStatus.forEach((statusItem) => {
                const originalThreat = allThreats.find((t) => t.id === statusItem.threatId);
                if (originalThreat) {
                    statusItem.originalDescription = originalThreat.description;
                    statusItem.originalMitigation = originalThreat.mitigation;
                }
            });
        }

        const parsedProposals = {
            controlDeduplications: parsedDedupAudit.controlDeduplications || [],
            threatDeduplications: parsedDedupAudit.threatDeduplications || [],
            hallucinationAlerts: parsedDedupAudit.hallucinationAlerts || [],
            mitigationStatus: parsedMitigationRevision.mitigationStatus || [],
            answersRevision: parsedMitigationRevision.answersRevision || []
        };
        
        session.deduplicateProposals = parsedProposals;
        session.hallucinationAlerts = parsedProposals.hallucinationAlerts;
        session.mitigationStatus = parsedProposals.mitigationStatus;
        session.answersRevision = parsedProposals.answersRevision;

        await aiContextStore.updateSession(session.sessionId, {
            deduplicateProposals: parsedProposals,
            hallucinationAlerts: parsedProposals.hallucinationAlerts,
            mitigationStatus: parsedProposals.mitigationStatus,
            answersRevision: parsedProposals.answersRevision
        });

        job.status = 'completed';
        job.progress = 100;
        job.result = parsedProposals;
        activeJobs.set(job.jobId, { ...job });

    } catch (err) {
        const errMessage = err?.message || String(err);
        logger.error(`[Job ${job.jobId}] Background deduplication and audit job failed: ${errMessage}`);
        job.status = 'failed';
        job.progress = 100;
        job.error = errMessage;
        activeJobs.set(job.jobId, { ...job });
    }
};

export default {
    extractTextFromDocs,
    generateAndSaveEmbeddings,
    runGenerateJob,
    runDeduplicateJob
};
