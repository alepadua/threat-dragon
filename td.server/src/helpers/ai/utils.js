/* eslint-disable */
import loggerHelper from '../logger.helper.js';
import crypto from 'crypto';

const logger = loggerHelper.get('helpers/ai/utils.js');

export const closeOpenStructures = (stack, targetChar) => {
    let closed = '';
    while (stack.length > 0 && stack[stack.length - 1] !== targetChar) {
        closed += stack.pop();
    }
    return closed;
};

export const repairMismatchedBrackets = (str) => {
    let repaired = '';
    const stack = [];
    let inString = false;
    let escaped = false;

    const hasMoreContent = (index) => {
        for (let j = index + 1; j < str.length; j++) {
            if (str[j] !== '}' && str[j] !== ']' && !(/\s/u).test(str[j])) {
                return true;
            }
        }
        return false;
    };

    for (let i = 0; i < str.length; i++) {
        const c = str[i];

        if (inString) {
            repaired += c;
            if (c === '\\') {
                escaped = !escaped;
            } else if (c === '"' && !escaped) {
                inString = false;
            } else {
                escaped = false;
            }
        } else if (c === '"') {
            inString = true;
            escaped = false;
            repaired += c;
        } else if (c === '{') {
            stack.push('}');
            repaired += c;
        } else if (c === '[') {
            stack.push(']');
            repaired += c;
        } else if (c === '}') {
            const isPrematureRoot = (stack.length === 1 && stack[0] === '}' && hasMoreContent(i));
            if (!isPrematureRoot) {
                if (stack.length > 0 && stack[stack.length - 1] === ']') {
                    const lastBraceIndex = stack.lastIndexOf('}');
                    if (lastBraceIndex !== -1) {
                        repaired += closeOpenStructures(stack, '}');
                    }
                }
                if (stack.length > 0 && stack[stack.length - 1] === '}') {
                    stack.pop();
                    repaired += c;
                }
            }
        } else if (c === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === '}') {
                const lastBracketIndex = stack.lastIndexOf(']');
                if (lastBracketIndex !== -1) {
                    repaired += closeOpenStructures(stack, ']');
                }
            }
            if (stack.length > 0 && stack[stack.length - 1] === ']') {
                stack.pop();
                repaired += c;
            }
        } else {
            repaired += c;
        }
    }
    return repaired;
};

export const repairMissingCommas = (str) => {
    let clean = str;
    const propRegex = /(["\d]|true|false|null|\}|\])(\s+)(?="[A-Za-z0-9_\-]+"\s*:)/gi;
    clean = clean.replace(propRegex, (match, p1, p2) => p1 + ',' + p2);
    
    const objRegex = /(\})(\s+)(?=\{)/g;
    clean = clean.replace(objRegex, (match, p1, p2) => p1 + ',' + p2);
    
    const arrRegex = /(\])(\s+)(?=\[)/g;
    clean = clean.replace(arrRegex, (match, p1, p2) => p1 + ',' + p2);
    
    return clean;
};

export const cleanJson = (str) => {
    let clean = str.trim();
    clean = clean.replace(/^```json/iu, '').replace(/```$/u, '').
trim();
    clean = clean.replace(/\/\*[\s\S]*?\*\//gu, '');
    clean = clean.replace(/(?<prefix>^|[^:])\/\/.*$/gmu, '$<prefix>');
    
    clean = repairMissingCommas(clean);
    
    clean = clean.replace(/,\s*(?<brace>[\]}])/gu, '$<brace>');
    return clean.trim();
};

export const escapeControlCharsInStrings = (str) => {
    let inString = false;
    let escaped = false;
    let result = '';
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char === '"' && !escaped) {
            inString = !inString;
            result += char;
        } else if (inString) {
            if (char === '\\') {
                escaped = !escaped;
                result += char;
            } else {
                escaped = false;
                if (char === '\n') {
                    result += '\\n';
                } else if (char === '\r') {
                    result += '\\r';
                } else if (char === '\t') {
                    result += '\\t';
                } else if (char.charCodeAt(0) < 32) {
                    result += '\\u' + ('0000' + char.charCodeAt(0).toString(16)).slice(-4);
                } else {
                    result += char;
                }
            }
        } else {
            escaped = false;
            result += char;
        }
    }
    return result;
};

export const isEscaped = (s, pos) => {
    let count = 0;
    let index = pos - 1;
    while (index >= 0 && s[index] === '\\') {
        count++;
        index--;
    }
    return count % 2 === 1;
};

export const findCandidates = (str, startIndex) => {
    const candidates = [];
    let j = startIndex;
    while (j < str.length) {
        if (str[j] === '"' && !isEscaped(str, j)) {
            let k = j + 1;
            while (k < str.length && (/\s/u).test(str[k])) {
                k++;
            }
            const nextChar = str[k];
            if (nextChar === ':' || nextChar === ',' || nextChar === '}' || nextChar === ']' || k === str.length) {
                candidates.push(j);
            }
        }
        j++;
    }
    return candidates;
};

export const escapeRange = (str, start, end) => {
    let result = '';
    for (let index = start; index < end; index++) {
        const c = str[index];
        if (c === '"' && !isEscaped(str, index)) {
            result += '\\"';
        } else {
            result += c;
        }
    }
    return result;
};

export const escapeInternalQuotes = (str) => {
    let result = '';
    let i = 0;
    while (i < str.length) {
        const char = str[i];
        if (char !== '"') {
            result += char;
            i++;
        } else {
            result += '"';
            i++;
            
            const candidates = findCandidates(str, i);
            if (candidates.length === 0) {
                result += '"';
            } else {
                const trueClosingIndex = candidates[0];
                result += escapeRange(str, i, trueClosingIndex);
                result += '"';
                i = trueClosingIndex + 1;
            }
        }
    }
    return result;
};

export const fixBracketTranspositions = (str) => {
    let result = '';
    let inString = false;
    let escaped = false;
    let i = 0;

    while (i < str.length) {
        const c = str[i];

        if (inString) {
            result += c;
            if (c === '\\') {
                escaped = !escaped;
            } else if (c === '"' && !escaped) {
                inString = false;
            } else {
                escaped = false;
            }
            i++;
        } else if (c === '"') {
            inString = true;
            escaped = false;
            result += c;
            i++;
        } else if (c === '}' && i + 2 < str.length && str[i + 1] === ']' && str[i + 2] === '}') {
            result += '}';
            result += '}';
            result += ']';
            i += 3;
        } else {
            result += c;
            i++;
        }
    }

    return result;
};

export const getErrorPosition = (err) => {
    const match = err.message.match(/position\s+(?<position>\d+)/iu);
    if (match && match.groups && match.groups.position) {
        return parseInt(match.groups.position, 10);
    }
    return null;
};

export const tryParse = (text) => {
    try {
        return JSON.parse(text);
    } catch (e) {
        try {
            return JSON.parse(escapeControlCharsInStrings(escapeInternalQuotes(text)));
        } catch (e2) {
            return null;
        }
    }
};

export const _rawRepairTruncatedJson = (text) => {
    let repaired = text.trimEnd();
    let inString = false;
    let escaped = false;
    for (let i = 0; i < repaired.length; i++) {
        const c = repaired[i];
        if (c === '\\' && inString) {
            escaped = !escaped;
        } else if (c === '"' && !escaped) {
            inString = !inString;
        } else {
            escaped = false;
        }
    }
    if (inString) {
        repaired += '"';
    }

    repaired = repaired.replace(/[,:\s]+$/u, '');

    const stack = [];
    let inStr = false;
    let esc = false;
    for (let i = 0; i < repaired.length; i++) {
        const c = repaired[i];
        if (c === '\\' && inStr) {
            esc = !esc;
        } else if (c === '"' && !esc) {
            inStr = !inStr;
        } else if (!inStr) {
            esc = false;
            if (c === '{') { stack.push('}'); }
            if (c === '[') { stack.push(']'); }
            if (c === '}' || c === ']') { stack.pop(); }
        } else {
            esc = false;
        }
    }

    let closed = repaired;
    const revStack = [...stack];
    while (revStack.length > 0) {
        closed += revStack.pop();
    }
    return closed;
};

export const repairTruncatedJson = (text) => {
    try {
        const firstTry = _rawRepairTruncatedJson(text);
        JSON.parse(escapeControlCharsInStrings(escapeInternalQuotes(firstTry)));
        return firstTry;
    } catch (e) {
        // Fall back to backtracking
    }

    const maxBacktrack = Math.min(text.length, 2000);
    for (let offset = 1; offset <= maxBacktrack; offset++) {
        const candidate = text.slice(0, text.length - offset);
        try {
            const repaired = _rawRepairTruncatedJson(candidate);
            JSON.parse(escapeControlCharsInStrings(escapeInternalQuotes(repaired)));
            return repaired;
        } catch (e) {
            // Keep backtracking
        }
    }

    return _rawRepairTruncatedJson(text);
};

export const convertDeltasToRevisedModel = (threatDeltas, methodology = 'STRIDE', title = '', description = '') => {
    const cells = (threatDeltas || []).map((delta) => ({
        id: delta.cellId,
        shape: 'process',
        data: {
            threats: delta.threats || []
        }
    }));
    
    return {
        version: '2.0.0',
        summary: {
            title: title,
            owner: 'Security Team',
            description: description,
            id: 0
        },
        detail: {
            contributors: [{ name: 'AI Threat Modeler' }],
            reviewer: 'AI Threat Modeler',
            diagrams: [
                {
                    id: 0,
                    title: 'Main System DFD',
                    diagramType: methodology || 'STRIDE',
                    placeholder: 'Main System DFD description',
                    thumbnail: './public/content/images/thumbnail.stride.jpg',
                    version: '2.0.0',
                    cells: cells
                }
            ],
            diagramTop: 1,
            threatTop: 100
        }
    };
};

// Import healDiagramCells from mergeEngine to avoid duplicate code
import { healDiagramCells } from './mergeEngine.js';

export const extractJson = (str, methodology = 'STRIDE') => {
    const parsed = _rawExtractJson(str, methodology);
    if (parsed) {
        if (parsed.threatDeltas && !parsed.threatModel) {
            parsed.threatModel = convertDeltasToRevisedModel(parsed.threatDeltas, methodology);
        }
        if (parsed.threatModel && parsed.threatModel.detail && parsed.threatModel.detail.diagrams && parsed.threatModel.detail.diagrams[0]) {
            parsed.threatModel.detail.diagrams[0].cells = healDiagramCells(parsed.threatModel.detail.diagrams[0].cells);
        }
    }
    return parsed;
};

const _rawExtractJson = (str, methodology = 'STRIDE') => {
    const cleaned = cleanJson(str);
    const parsedCleaned = tryParse(cleaned);
    if (parsedCleaned) {
        return parsedCleaned;
    }

    const transpositionFixed = fixBracketTranspositions(cleaned);
    const parsedTransposed = tryParse(transpositionFixed);
    if (parsedTransposed) {
        return parsedTransposed;
    }

    const parsedMismatched = tryParse(repairMismatchedBrackets(transpositionFixed));
    if (parsedMismatched) {
        return parsedMismatched;
    }

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const substring = cleaned.slice(firstBrace, lastBrace + 1);
        const parsedSubstring = tryParse(substring);
        if (parsedSubstring) {
            return parsedSubstring;
        }

        try {
            const repairedSub = escapeControlCharsInStrings(escapeInternalQuotes(substring));
            return JSON.parse(repairedSub);
        } catch (e) {
            logger.warn(`[extractJson] Standard repair failed: ${e.message}. Attempting truncation repair...`);
        }
    }

    const truncationBase = firstBrace !== -1 ? cleaned.slice(firstBrace) : cleaned;
    try {
        const repairedTruncated = escapeControlCharsInStrings(escapeInternalQuotes(repairTruncatedJson(truncationBase)));
        const parsedRepaired = JSON.parse(repairedTruncated);
        logger.warn('[extractJson] Successfully recovered truncated JSON via auto-repair.');
        return parsedRepaired;
    } catch (e2) {
        const pos = getErrorPosition(e2);
        if (pos !== null) {
            const start = Math.max(0, pos - 100);
            const end = Math.min(truncationBase.length, pos + 100);
            logger.error(`[extractJson] JSON parse failed at position ${pos}. Message: ${e2.message}. Context: ...${truncationBase.slice(start, pos)}[ERROR_HERE]${truncationBase.slice(pos, end)}...`);
        } else {
            logger.error(`[extractJson] JSON parse failed. Message: ${e2.message}.`);
        }
        throw e2;
    }
};

export const ensureModelMessageInHistory = (refinementHistory, questions, dfdApproved) => {
    const history = [...(refinementHistory || [])];
    const lastMsg = history[history.length - 1];
    
    if (!lastMsg || lastMsg.role !== 'model') {
        if (questions && questions.length > 0) {
            const isTransition = dfdApproved && history.length === 0;
            let welcomeText = '';
            if (isTransition) {
                welcomeText = 'Welcome! I have analyzed your approved DFD topology and prepared a Question Plan. Please answer these questions to help me identify and mitigate threats:\n\n';
            } else if (history.length > 0) {
                welcomeText = 'Thanks! Based on your feedback, I have updated the model. Here is my next round of questions:\n\n';
            } else {
                welcomeText = 'Welcome! I have mapped your initial architecture. Please answer these questions to help me refine the threat model:\n\n';
            }
            history.push({
                role: 'model',
                text: welcomeText + questions.map((q, i) => `${i + 1}. ${q.text || q}`).join('\n')
            });
        } else {
            history.push({
                role: 'model',
                text: 'Model refined successfully! I have no further questions. You can refine it again if you have more changes, or open the model in Threat Dragon.'
            });
        }
    }
    return history;
};

export const groupAndConsolidateQuestions = (questionPlan, answeredIds = [], batchSize = 3) => {
    if (!questionPlan || !Array.isArray(questionPlan.plannedQuestions)) {
        return [];
    }

    const unanswered = questionPlan.plannedQuestions.filter((q) => !answeredIds.includes(q.id));
    if (unanswered.length === 0) { return []; }

    const groupedByElemAndCat = new Map();
    unanswered.forEach((q) => {
        const key = `${q.elementType}-${q.category}`;
        if (!groupedByElemAndCat.has(key)) {
            groupedByElemAndCat.set(key, []);
        }
        groupedByElemAndCat.get(key).push(q);
    });

    const candidateGroups = [];
    groupedByElemAndCat.forEach((questions, key) => {
        const [elementType, category] = key.split('-');
        
        const elementNames = questions.map((q) => q.elementName);
        const uniqueElementNames = Array.from(new Set(elementNames));
        const displayName = uniqueElementNames.length > 1
            ? `${uniqueElementNames.slice(0, 2).join(', ')} (e outros)`
            : uniqueElementNames[0];

        candidateGroups.push({
            id: `grp-${category.toLowerCase()}-${elementType.toLowerCase()}-${crypto.randomUUID().slice(0, 4)}`,
            category,
            elementType,
            elementName: displayName,
            elements: questions.map((q) => ({ id: q.elementId, name: q.elementName })),
            originalQuestionIds: questions.map((q) => q.id)
        });
    });

    return candidateGroups.slice(0, batchSize);
};

export const healParsedConsolidatedQuestions = (parsedQuestions, roundGroups) => {
    if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
        return [];
    }
    if (!Array.isArray(roundGroups) || roundGroups.length === 0) {
        return parsedQuestions.map((q) => {
            const gid = q.id || `grp-healed-${crypto.randomUUID().slice(0, 8)}`;
            return {
                id: gid,
                originalQuestionIds: q.originalQuestionIds || [],
                category: q.category || 'Geral',
                text: typeof q === 'string' ? q : (q.text || q.question || '')
            };
        });
    }

    const healedGroups = [];
    const usedGroupIndices = new Set();

    parsedQuestions.forEach((q, idx) => {
        let text = '';
        let category = '';
        let id = '';
        let originalQuestionIds = [];

        if (typeof q === 'string') {
            text = q;
        } else if (q && typeof q === 'object') {
            text = q.text || q.question || '';
            category = q.category || '';
            id = q.id || '';
            originalQuestionIds = q.originalQuestionIds || [];
        }

        let matchedG = null;

        if (id) {
            matchedG = roundGroups.find((rg) => rg.id === id);
        }

        if (!matchedG && category) {
            matchedG = roundGroups.find((rg, rIdx) => !usedGroupIndices.has(rIdx) &&
                rg.category?.toLowerCase() === category.toLowerCase()
            );
        }

        if (!matchedG && idx < roundGroups.length) {
            matchedG = roundGroups[idx];
        }

        if (matchedG) {
            const rgIdx = roundGroups.indexOf(matchedG);
            usedGroupIndices.add(rgIdx);

            healedGroups.push({
                id: matchedG.id,
                originalQuestionIds: matchedG.originalQuestionIds,
                category: matchedG.category,
                elementType: matchedG.elementType,
                elementId: 'global',
                elementName: matchedG.elementName,
                elements: matchedG.elements,
                text: text || matchedG.text
            });
        } else {
            healedGroups.push({
                id: id || `grp-healed-${crypto.randomUUID().slice(0, 8)}`,
                originalQuestionIds: originalQuestionIds,
                category: category || 'Geral',
                elementId: 'global',
                elementName: 'Sistema',
                text: text
            });
        }
    });

    return healedGroups;
};

export const splitTextIntoChunks = (text, chunkSize = 1000, overlap = 150) => {
    const chunks = [];
    if (!text || text.trim() === '') { return chunks; }
    
    let index = 0;
    while (index < text.length) {
        const end = Math.min(index + chunkSize, text.length);
        const chunk = text.slice(index, end);
        chunks.push(chunk);
        if (end === text.length) {
            break;
        }
    index += (chunkSize - overlap);
    }
    return chunks;
};

export const compressModelForPrompt = (model) => {
    if (!model) { return model; }
    try {
        const copy = JSON.parse(JSON.stringify(model));
        let diagrams = [];
        if (copy.threatModel?.detail?.diagrams) {
            diagrams = copy.threatModel.detail.diagrams;
        } else if (copy.detail?.diagrams) {
            diagrams = copy.detail.diagrams;
        }
        
        if (Array.isArray(diagrams)) {
            diagrams.forEach((diag) => {
                if (diag && Array.isArray(diag.cells)) {
                    diag.cells.forEach((cell) => {
                        if (cell && cell.data && Array.isArray(cell.data.threats)) {
                            cell.data.threats = cell.data.threats.map((threat) => {
                                if (threat && threat.status && threat.status.toLowerCase() !== 'open' && threat.status.toLowerCase() !== 'tbd') {
                                    return {
                                        id: threat.id,
                                        title: threat.title,
                                        type: threat.type,
                                        status: threat.status,
                                        severity: threat.severity,
                                        score: threat.score,
                                        number: threat.number,
                                        modelType: threat.modelType,
                                        description: '',
                                        mitigation: ''
                                    };
                                }
                                return threat;
                            });
                        }
                    });
                }
            });
        }
        return copy;
    } catch (err) {
        logger.error(`Error compressing model for prompt: ${err.message}`);
        return model;
    }
};

export const managePromptContext = (docsContext, refinementHistory, currentModel, maxChars) => {
    let docsResult = docsContext || '';
    let historyResult = Array.isArray(refinementHistory) ? [...refinementHistory] : [];
    
    // Calculate current estimation
    const modelStr = currentModel ? JSON.stringify(currentModel) : '';
    const baseLength = 15000 + modelStr.length; // Estimating other instructions + model
    
    let totalLength = baseLength + docsResult.length + JSON.stringify(historyResult).length;
    
    if (totalLength <= maxChars) {
        return { docsContext: docsResult, refinementHistory: historyResult };
    }
    
    logger.warn(`[managePromptContext] Prompt size (${totalLength}) exceeds maximum context chars (${maxChars}). Truncating...`);
    
    // 1. Truncate history first. Keep only the last 4 messages if it's too long.
    if (historyResult.length > 4) {
        logger.info(`[managePromptContext] Truncating refinement history from ${historyResult.length} to 4 messages.`);
        historyResult = historyResult.slice(-4);
        totalLength = baseLength + docsResult.length + JSON.stringify(historyResult).length;
    }
    
    // If still exceeding, keep slicing history down to last 2 messages
    if (totalLength > maxChars && historyResult.length > 2) {
        logger.info(`[managePromptContext] Truncating refinement history further to 2 messages.`);
        historyResult = historyResult.slice(-2);
        totalLength = baseLength + docsResult.length + JSON.stringify(historyResult).length;
    }
    
    // 2. Truncate docsContext if it still exceeds
    if (totalLength > maxChars) {
        const allowedDocChars = Math.max(0, maxChars - baseLength - JSON.stringify(historyResult).length - 500);
        logger.info(`[managePromptContext] Truncating docsContext from ${docsResult.length} to ${allowedDocChars} characters.`);
        if (allowedDocChars > 0) {
            docsResult = docsResult.slice(0, allowedDocChars) + '\n... [Conteúdo restante omitido por limite de contexto] ...\n';
        } else {
            docsResult = '\n... [Conteúdo omitido por limite de contexto] ...\n';
        }
    }
    
    return { docsContext: docsResult, refinementHistory: historyResult };
};

export default {
    closeOpenStructures,
    repairMismatchedBrackets,
    repairMissingCommas,
    cleanJson,
    escapeControlCharsInStrings,
    isEscaped,
    findCandidates,
    escapeRange,
    escapeInternalQuotes,
    fixBracketTranspositions,
    getErrorPosition,
    tryParse,
    _rawRepairTruncatedJson,
    repairTruncatedJson,
    convertDeltasToRevisedModel,
    extractJson,
    ensureModelMessageInHistory,
    groupAndConsolidateQuestions,
    healParsedConsolidatedQuestions,
    splitTextIntoChunks,
    compressModelForPrompt,
    managePromptContext
};
