/* eslint-disable max-lines-per-function, complexity, max-lines */
import { badRequest, serverError } from './errors.js';
import aiContextStore from '../helpers/aiContextStore.js';
import axios from 'axios';
import env from '../env/Env.js';
import loggerHelper from '../helpers/logger.helper.js';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

const logger = loggerHelper.get('controllers/aiController.js');

const parseBase64Image = (dataUri) => {
    const matches = dataUri.match(/^data:(?<mime>[a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(?<data>.+)$/u);
    if (matches && matches.groups) {
        return {
            mimeType: matches.groups.mime,
            data: matches.groups.data
        };
    }
    return {
        mimeType: 'image/png',
        data: dataUri.replace(/^data:image\/[a-zA-Z]+;base64,/u, '')
    };
};

const cleanJson = (str) => {
    let clean = str.trim();
    clean = clean.replace(/^```json/iu, '').replace(/```$/u, '').
trim();
    clean = clean.replace(/\/\*[\s\S]*?\*\//gu, '');
    clean = clean.replace(/(?<prefix>^|[^:])\/\/.*$/gmu, '$<prefix>');
    clean = clean.replace(/,\s*(?<brace>[\]}])/gu, '$<brace>');
    return clean.trim();
};

const extractJson = (str) => {
    const cleaned = cleanJson(str);
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            const substring = cleaned.slice(firstBrace, lastBrace + 1);
            return JSON.parse(substring);
        }
        throw e;
    }
};

const generate = async (req, res) => {
    const {
        title,
        description,
        docs,
        images,
        apiKey: clientApiKey,
        currentModel,
        refinementHistory,
        methodology = 'STRIDE',
        sessionId
    } = req.body;

    const apiKey = clientApiKey || env.get().config.GEMINI_API_KEY;

    if (!apiKey) {
        return badRequest('Gemini API key is missing. Please configure GEMINI_API_KEY in the server environment or provide it in the API Key input.', res, logger);
    }

    try {
        let activeSession = null;
        let finalDocs = docs || [];
        let finalImages = images || [];
        let finalMethodology = methodology;

        // Stage 1: RAG Context Evolution
        if (sessionId) {
            activeSession = aiContextStore.getSession(sessionId);
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
                
                // Update history and model in session store
                aiContextStore.updateSession(sessionId, {
                    refinementHistory: refinementHistory || [],
                    currentModel: currentModel || null
                });
            }
        }

        if (!activeSession) {
            // First round: create new session
            if (!title || title.trim() === '') {
                return badRequest('Threat model title is required to initialize a session', res, logger);
            }
            activeSession = aiContextStore.createSession({
                title,
                description,
                docs: finalDocs,
                images: finalImages,
                refinementHistory: refinementHistory || [],
                currentModel: currentModel || null,
                methodology: finalMethodology
            });
            logger.info(`Initialized new RAG session: ${activeSession.sessionId}`);
        }

        // Process documents, including .docx parsing if they are fresh or retrieved
        let docsContext = '';
        if (finalDocs && finalDocs.length > 0) {
            const docPromises = finalDocs.map(async (doc, idx) => {
                if (doc.name.endsWith('.docx')) {
                    try {
                        const base64Data = doc.content.replace(/^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,/u, '');
                        const buffer = Buffer.from(base64Data, 'base64');
                        const result = await mammoth.extractRawText({ buffer });
                        return `\n--- Document [${idx + 1}]: ${doc.name} (Extracted DOCX Word Document) ---\n${result.value}\n`;
                    } catch (docxErr) {
                        logger.error(`Failed to parse docx file ${doc.name}: ${docxErr.message}`);
                        return `\n--- Document [${idx + 1}]: ${doc.name} (Word Document parsing failed) ---\n`;
                    }
                }
                if (doc.name.toLowerCase().endsWith('.pdf')) {
                    try {
                        const base64Data = doc.content.replace(/^data:application\/pdf;base64,/u, '');
                        const buffer = Buffer.from(base64Data, 'base64');
                        const result = await new PDFParse({ data: buffer }).getText();
                        return `\n--- Document [${idx + 1}]: ${doc.name} (Extracted PDF) ---\n${result.text}\n`;
                    } catch (pdfErr) {
                        logger.error(`Failed to parse pdf file ${doc.name}: ${pdfErr.message}`);
                        return `\n--- Document [${idx + 1}]: ${doc.name} (PDF parsing failed) ---\n`;
                    }
                }
                return `\n--- Document [${idx + 1}]: ${doc.name} ---\n${doc.content}\n`;
            });
            const docsTexts = await Promise.all(docPromises);
            docsContext = docsTexts.join('');
        } else {
            docsContext = '\nNo documentation files provided.\n';
        }

        // Stage 3: Methodology Selection Prompts
        let methodologyPrompt = '';
        if (finalMethodology === 'MITRE_F3') {
            methodologyPrompt = `
You must perform Threat Modeling focusing on the MITRE Fight Fraud Framework (F3).
Strictly map threats to elements using these MITRE F3 tactics:
- "actor" (External Entity / Fraudster): Applicable threat categories are "Reconnaissance", "Resource Development", and "Initial Access".
- "process" (Internal System / Financial Engine): Applicable threat categories are "Defense Evasion", "Execution", and "Positioning".
- "store" (Data Store / Credentials Cache): Applicable threat categories are "Initial Access" and "Monetization".
- "flow" (Data Flow / Transfer): Applicable threat categories are "Execution" and "Monetization".

For each threat, the threat's "type" property MUST be set to one of the F3 tactics above, and its "modelType" property MUST be exactly "MITRE_F3".
`;
        } else {
            methodologyPrompt = `
You must perform Threat Modeling focusing on the STRIDE methodology.
Strictly map threats to elements using these STRIDE categories:
- "actor" (External Entity): Applicable threat categories are "Spoofing" and "Repudiation" only.
- "process": Applicable threat categories are "Spoofing", "Tampering", "Repudiation", "Information disclosure", "Denial of service", and "Elevation of privilege".
- "store" (Data Store): Applicable threat categories are "Tampering", "Information disclosure", and "Denial of service" only.
- "flow" (Data Flow): Applicable threat categories are "Tampering", "Information disclosure", and "Denial of service" only.

For each threat, the threat's "type" property MUST be set to one of the STRIDE categories above, and its "modelType" property MUST be exactly "STRIDE".
`;
        }

        // 2. Build the detailed instruction prompt for generator
        let promptText = `You are an expert security architect and Threat Modeling assistant. Your goal is to analyze the provided architecture documentation and system diagrams, perform threat modeling, and return a complete Threat Dragon V2 JSON object along with clarifying questions.

LANGUAGE REQUIREMENT:
You MUST conduct all threat modeling, diagram labeling, component names, threat generation, mitigation details, and clarifying questions in Portuguese. All user-facing strings (e.g., threat titles, threat descriptions, mitigations, and the array of clarifying questions) MUST be written in Portuguese.


${methodologyPrompt}

For each threat generated, supply technical and actionable mitigations (e.g. MFA, audit logging, input validation, encryption in transit and at rest, rate limiting, and RBAC).

The threat model metadata is:
- Title: "${title || activeSession.title}"
- Description: "${description || activeSession.description || ''}"

Below is the provided system documentation:
${docsContext}
`;

        if (currentModel) {
            promptText += `\n\n--- CURRENT THREAT MODEL ---\nThis is the existing Threat Dragon V2 JSON model that you have generated in the previous round:\n${JSON.stringify(currentModel, null, 2)}\n`;
            promptText += `
CRITICAL INSTRUCTION FOR INCREMENTAL REFINEMENT:
- You MUST treat this "CURRENT THREAT MODEL" as your base state.
- Do NOT reconstruct the diagram or threats from scratch.
- Preserve the exact "id" values of existing diagram components (actors, processes, stores, flows) to maintain diagram topology and reference integrity.
- Do NOT delete existing components, data flows, or threats unless they are directly contradicted or modified by the refinement conversation history.
- Merge any new components, data flows, or threats identified through the user responses into the existing model.
- If the user answer indicates that a security control is already implemented, update the corresponding threat's mitigation details and state in the threat model.
`;
        }

        if (refinementHistory && refinementHistory.length > 0) {
            promptText += `\n\n--- REFINEMENT CONVERSATION HISTORY ---\nHere are the user answers to your previous clarifying questions, or general feedback. Update the threat model elements, data flows, and threats according to these answers:\n`;
            refinementHistory.forEach((msg) => {
                promptText += `${msg.role.toUpperCase()}: ${msg.text}\n`;
            });
        }

        promptText += `\n
Ensure elements are positioned on a clean grid layout (X: 50-900, Y: 50-600) and flows connect them correctly using IDs.

You MUST return ONLY a JSON object containing two keys:
1. "threatModel": The complete and valid Threat Dragon V2 JSON object containing the summary and detail (diagrams, cells, and threats).
2. "questions": An array of 3-5 clarifying questions targeting specific areas of ambiguity in the architecture, data processing, or security controls. If you feel the model is now complete and no further clarification is needed, return an empty array [].

CRITICAL SCHEMA REQUIREMENT FOR DIAGRAM CELLS:
Every item in the "cells" array of the diagram must represent a valid Threat Dragon V2 node or edge, conforming to the Antv/X6 model schema. Specifically:
- Every cell object MUST have the following root-level properties:
  - "id": A unique UUID string (e.g. "a10e3c57-dad4-4914-b702-a43d9bf13956")
  - "shape": A string matching exactly one of: "actor", "process", "store", "flow", "trust-boundary-curve", "trust-boundary-box"
  - "zIndex": An integer (use -1 for boundaries, 2 for actors/processes/stores, 10 for flows)
  - "visible": boolean (true)
- Elements (actor, process, store, trust-boundary-curve, trust-boundary-box) must also have:
  - "position": {"x": number, "y": number}
  - "size": {"width": number, "height": number}
  - "attrs": {"text": {"text": "Name of the element"}}
  - "data": An object with:
    - "type": A string matching exactly one of: "tm.Actor", "tm.Process", "tm.Store", "tm.BoundaryBox", "tm.Boundary"
    - "name": String name of the element
    - "description": String description
    - "hasOpenThreats": boolean (true if threats array has elements, false otherwise)
    - "threats": An array of threats (see details below)
- Data Flows (shape: "flow") must also have:
  - "source": {"cell": "source-element-uuid"}
  - "target": {"cell": "target-element-uuid"}
  - "labels": [{"attrs": {"labelText": {"text": "Flow Name"}}}]
  - "data": An object with:
    - "type": "tm.Flow"
    - "name": String name of the flow
    - "description": String description
    - "protocol": String (e.g. "HTTPS", "gRPC", "mTLS")
    - "isEncrypted": boolean
    - "isPublicNetwork": boolean
    - "hasOpenThreats": boolean
    - "threats": An array of threats (see details below)

CRITICAL SCHEMA REQUIREMENT FOR THREATS:
Every object inside the "threats" array of any cell must have:
- "threatId": A unique UUID string
- "title": String title of the threat
- "description": String description detailing the attack scenario
- "mitigation": String describing concrete and actionable mitigation
- "severity": One of: "High", "Medium", "Low"
- "status": One of: "Open", "Mitigated", "NA"
- "type": One of the STRIDE/F3 categories matching the element shape rules.
- "modelType": Exactly "STRIDE" or "MITRE_F3" (matching methodology).
- "number": A unique sequential integer

Do not wrap the JSON output in markdown formatting. Follow this exact JSON output schema:
{
  "threatModel": {
    "version": "2.0.0",
    "summary": {
      "title": "${title || activeSession.title}",
      "owner": "Security Team",
      "description": "${description || activeSession.description || ''}",
      "id": 0
    },
    "detail": {
      "contributors": [{"name": "AI Threat Modeler"}],
      "reviewer": "AI Threat Modeler",
      "diagrams": [
        {
          "id": 0,
          "title": "Main System DFD",
          "diagramType": "${finalMethodology === 'MITRE_F3' ? 'MITRE_F3' : 'STRIDE'}",
          "placeholder": "Main System DFD description",
          "thumbnail": "./public/content/images/thumbnail.stride.jpg",
          "version": "2.0.0",
          "cells": [
            // List of cells conforming to the strict schemas above
          ]
        }
      ],
      "diagramTop": 1,
      "threatTop": 100
    }
  },
  "questions": [
    "Question 1...",
    "Question 2..."
  ]
}
`;

        const parts = [{ text: promptText }];

        if (finalImages && finalImages.length > 0) {
            finalImages.forEach((img) => {
                const parsed = parseBase64Image(img.data);
                parts.push({
                    inlineData: {
                        mimeType: parsed.mimeType,
                        data: parsed.data
                    }
                });
            });
            logger.info(`Attached ${finalImages.length} images to Gemini payload`);
        }

        // Call 1: Generator Model
        const generatorResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
            {
                contents: [{ parts }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    maxOutputTokens: 8192
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 90000
            }
        );

        const candidate = generatorResponse.data?.candidates?.[0];
        const responseText = candidate?.content?.parts?.[0]?.text;

        if (!responseText) {
            logger.error('Gemini API returned an empty response during generation');
            return serverError('Failed to generate threat model. Gemini returned an empty response.', res, logger);
        }

        let parsedOutput;
        try {
            parsedOutput = extractJson(responseText);
        } catch (parseErr) {
            logger.error(`Failed to parse Gemini generator output as JSON. Output was: ${responseText}`);
            return serverError('Failed to parse the generated output as valid JSON. Please try again.', res, logger);
        }

        // Call 2: Critic Model (Independent critique and completeness score evaluation)
        const critiquePromptText = `You are an expert security auditor and critic. Your goal is to review the generated Threat Dragon V2 threat model against the system's architecture documentation, identify any security gaps or strengths, and compute a completeness evaluation score.

LANGUAGE REQUIREMENT:
You MUST write all evaluation texts, feedback/critique paragraphs, security control categories, and assessment details in Portuguese.


Here is the system architecture documentation:
${docsContext}

Here is the generated Threat Dragon V2 JSON threat model to review:
${JSON.stringify(parsedOutput.threatModel, null, 2)}

Please perform a critical review of the generated threat model using the ${finalMethodology === 'MITRE_F3' ? 'MITRE Fight Fraud (F3) Framework' : 'STRIDE methodology'}.
Specifically, evaluate:
1. Component Coverage: Are all system components, actors, and data flows from the documentation represented?
2. Mitigation Completeness: Do all threats have actionable, concrete mitigations?
3. Gaps and Genuineness: Are the threats realistic and are there any critical threat categories missing?
4. Security Control Efficacy: Analyze each answer/response provided by the user in the refinement conversation history (if any). For each answer, evaluate if the controls mentioned by the user are sufficient/adequate for the security threats in that area.

You MUST return ONLY a JSON object containing a single key "evaluation" structured exactly as below:
{
  "evaluation": {
    "completenessScore": integer (0 to 100),
    "criteria": {
      "elementCoverage": integer (0 to 100),
      "unresolvedQuestionsCount": integer (count of remaining gaps or unanswered clarifying questions),
      "mitigationCompleteness": integer (0 to 100)
    },
    "status": "Refining" (if completenessScore < 85) or "Ready" (if 85 or above),
    "feedback": "A detailed, constructive critique paragraph pointing out what is missing, what is good, and what can be improved in the threat model.",
    "controlsAssessment": [
      {
        "userAnswer": "string (the user's answer/response)",
        "securityControl": "string (the control category, e.g. Access Control, Data Encryption, Logging)",
        "assessment": "Eficaz" or "Carece Melhoria",
        "details": "string (explanation of why it is effective or what improvement is needed)"
      }
    ]
  }
}

Do not wrap the JSON output in markdown formatting.
`;

        let evaluation = {
            completenessScore: 40,
            criteria: {
                elementCoverage: 50,
                unresolvedQuestionsCount: parsedOutput.questions?.length || 3,
                mitigationCompleteness: 30
            },
            status: 'Refining',
            feedback: 'Evaluation fallback due to critique step issue.',
            controlsAssessment: []
        };

        try {
            const criticResponse = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: critiquePromptText }] }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        maxOutputTokens: 4096
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 45000
                }
            );

            const criticCandidate = criticResponse.data?.candidates?.[0];
            const criticResponseText = criticCandidate?.content?.parts?.[0]?.text;

            if (criticResponseText) {
                const parsedCritique = extractJson(criticResponseText);
                if (parsedCritique.evaluation) {
                    evaluation = parsedCritique.evaluation;
                }
            }
        } catch (criticErr) {
            logger.warn(`Critique step failed, falling back to default evaluation: ${criticErr.message}`);
        }

        // Cache the latest model, questions, and evaluation in the session context store
        aiContextStore.updateSession(activeSession.sessionId, {
            currentModel: parsedOutput.threatModel,
            questions: parsedOutput.questions || [],
            evaluation: evaluation
        });

        logger.info(`Threat model session round processed. Session ID: ${activeSession.sessionId}`);
        return res.status(200).json({
            status: 200,
            message: 'Successfully processed threat modeling session round',
            data: {
                threatModel: parsedOutput.threatModel,
                questions: parsedOutput.questions || [],
                evaluation: evaluation,
                sessionId: activeSession.sessionId
            }
        });

    } catch (err) {
        logger.error('Error in AI threat model controller:', err.message);
        if (err.response) {
            logger.error('Gemini API error details:', JSON.stringify(err.response.data));
            return res.status(err.response.status || 500).json({
                status: err.response.status || 500,
                message: err.response.data?.error?.message || 'Error occurred while contacting Gemini API',
                details: err.response.data
            });
        }
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
            sessionId: session.sessionId,
            title: session.title,
            description: session.description,
            methodology: session.methodology || 'STRIDE',
            refinementHistory: session.refinementHistory || []
        }
    });
};

export default {
    generate,
    getSessionState
};
