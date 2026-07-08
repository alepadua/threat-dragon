/* eslint-disable max-lines-per-function, complexity, max-lines, sort-imports, require-atomic-updates, require-await */
import { DOMMatrix } from '@napi-rs/canvas';
import { PDFParse } from 'pdf-parse';
import aiContextStore from '../helpers/aiContextStore.js';
import axios from 'axios';
import OpenAI from 'openai';
import { badRequest, serverError } from './errors.js';
import env from '../env/Env.js';
import loggerHelper from '../helpers/logger.helper.js';
import mammoth from 'mammoth';
import questionPlanningEngine from '../helpers/questionPlanningEngine.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import crypto from 'crypto';

// Polyfill DOMMatrix for pdfjs-dist used by pdf-parse
global.DOMMatrix = DOMMatrix;

const logger = loggerHelper.get('controllers/aiController.js');
const REQUEST_TIMEOUT = parseInt(process.env.AI_REQUEST_TIMEOUT, 10) || 300000;

const getProxyAgent = (context = 'general') => {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        logger.info(`[getProxyAgent] [${context}] Using proxy server configured from environment: ${proxyUrl}`);
        return new HttpsProxyAgent(proxyUrl);
    }
    logger.info(`[getProxyAgent] [${context}] Connecting directly (no proxy detected in environment)`);
    return null;
};

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

const closeOpenStructures = (stack, targetChar) => {
    let closed = '';
    while (stack.length > 0 && stack[stack.length - 1] !== targetChar) {
        closed += stack.pop();
    }
    return closed;
};

const repairMismatchedBrackets = (str) => {
    let repaired = '';
    const stack = [];
    let inString = false;
    let escaped = false;

    // Helper to check if there is non-whitespace content remaining in the string
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

    while (stack.length > 0) {
        repaired += stack.pop();
    }

    return repaired;
};

const healDiagramCells = (cells) => {
    if (!Array.isArray(cells)) {
        return cells;
    }

    const nodes = [];
    const edges = [];

    // Helper to generate a slug from a string (lowercased, keeping alphanumeric and hyphens)
    const toSlug = (str) => {
        if (!str || typeof str !== 'string') {
            return '';
        }
        return str.
            toLowerCase().
            normalize('NFD').
            replace(/[\u0300-\u036f]/gu, ''). // remove diacritics
            replace(/[^a-z0-9]/gu, '-'). // replace non-alphanumeric with hyphen
            replace(/-+/gu, '-'). // collapse consecutive hyphens
            replace(/^-+|-+$/gu, ''); // trim hyphens
    };

    // 1. Separate nodes and edges, and build mapping tables
    const idToNode = new Map();
    const slugToId = new Map();

    cells.forEach((cell) => {
        if (cell && typeof cell === 'object') {
            if (cell.source && cell.target) {
                edges.push(cell);
            } else if (cell.id) {
                nodes.push(cell);
                idToNode.set(cell.id, cell);
                const nodeName = cell.data?.name || cell.attrs?.text?.text || '';
                if (nodeName) {
                    const slug = toSlug(nodeName);
                    if (slug) {
                        slugToId.set(slug, cell.id);
                    }
                }
            }
        }
    });

    const healedEdges = [];

    // Helper to try matching a reference ID to a node ID
    const resolveReference = (refId) => {
        if (idToNode.has(refId)) {
            return refId;
        }
        const refSlug = toSlug(refId.replace(/^(?:proc|actor|store|boundary|flow)-/u, ''));
        let matchedId = slugToId.get(refSlug);
        if (!matchedId) {
            // Try fuzzy matching
            for (const [slug, id] of slugToId.entries()) {
                if (slug.includes(refSlug) || refSlug.includes(slug)) {
                    matchedId = id;
                    break;
                }
            }
        }
        return matchedId || null;
    };

    // 2. Validate and heal each edge
    edges.forEach((edge) => {
        const sourceCellId = edge.source?.cell;
        const targetCellId = edge.target?.cell;

        if (sourceCellId || targetCellId) {
            const finalSourceId = sourceCellId ? resolveReference(sourceCellId) : null;
            const finalTargetId = targetCellId ? resolveReference(targetCellId) : null;

            if ((!sourceCellId || finalSourceId) && (!targetCellId || finalTargetId)) {
                if (sourceCellId) { edge.source.cell = finalSourceId; }
                if (targetCellId) { edge.target.cell = finalTargetId; }
                healedEdges.push(edge);
            } else {
                logger.warn(`[healDiagramCells] Discarding edge "${edge.id || 'unnamed'}" because source (${sourceCellId} -> ${finalSourceId}) or target (${targetCellId} -> ${finalTargetId}) does not exist.`);
            }
        } else {
            // It's a trust boundary curve (points to coordinates) or similar.
            // Just preserve it!
            healedEdges.push(edge);
        }
    });

    return [...nodes, ...healedEdges];
};

const groupAndConsolidateQuestions = (questionPlan, combinedIds, batchSize) => {
    // Determine a larger window size to pull questions from the plan.
    // Grouping allows us to consolidate more questions in one prompt.
    // We pull up to batchSize * 4 questions, minimum 24, maximum 40.
    const windowSize = Math.min(Math.max(batchSize * 4, 24), 40);

    const { questions: rawQuestions } = questionPlanningEngine.getQuestionsByRound(
        questionPlan,
        1,
        combinedIds,
        windowSize
    );

    if (!rawQuestions || rawQuestions.length === 0) {
        return [];
    }

    // Group the raw questions by category and elementType
    const groupsMap = new Map();

    rawQuestions.forEach((q) => {
        const category = q.category || 'Geral';
        const type = q.elementType || q.type || 'Processo';
        const key = `${category.toLowerCase()}|${type.toLowerCase()}`;

        if (!groupsMap.has(key)) {
            groupsMap.set(key, {
                category,
                elementType: type,
                questions: []
            });
        }
        groupsMap.get(key).questions.push(q);
    });

    const consolidatedGroups = [];
    const groups = Array.from(groupsMap.values());
    const limitedGroups = groups.slice(0, batchSize);

    limitedGroups.forEach((group) => {
        const originalQuestionIds = group.questions.map((q) => q.id);
        const elements = group.questions.map((q) => ({
            id: q.elementId,
            name: q.elementName
        }));

        const groupNames = Array.from(new Set(group.questions.map((q) => q.elementName)));
        const elementName = groupNames.join(', ');

        // Generate a stable unique ID for this group
        const groupHash = crypto.createHash('sha256').
            update(originalQuestionIds.join(',')).
            digest('hex').
            slice(0, 8);
        const groupId = `grp-${group.category.toLowerCase().replace(/[^a-z0-9]/gu, '')}-${group.elementType.toLowerCase().replace(/[^a-z0-9]/gu, '')}-${groupHash}`;

        consolidatedGroups.push({
            id: groupId,
            category: group.category,
            elementType: group.elementType,
            elementId: 'global',
            elementName,
            originalQuestionIds,
            elements,
            text: '' // to be populated by LLM
        });
    });

    return consolidatedGroups;
};

const healParsedConsolidatedQuestions = (parsedQuestions, roundGroups) => {
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

const repairMissingCommas = (str) => {
    let clean = str;
    // 1. Missing comma between properties in an object (e.g. "prop1": "val" "prop2": "val")
    const propRegex = /(["\d]|true|false|null|\}|\])(\s+)(?="[A-Za-z0-9_\-]+"\s*:)/gi;
    clean = clean.replace(propRegex, (match, p1, p2) => p1 + ',' + p2);
    
    // 2. Missing comma between objects in an array (e.g. { "id": 1 } { "id": 2 })
    const objRegex = /(\})(\s+)(?=\{)/g;
    clean = clean.replace(objRegex, (match, p1, p2) => p1 + ',' + p2);
    
    // 3. Missing comma between arrays in an array (e.g. [1, 2] [3, 4])
    const arrRegex = /(\])(\s+)(?=\[)/g;
    clean = clean.replace(arrRegex, (match, p1, p2) => p1 + ',' + p2);
    
    return clean;
};

const cleanJson = (str) => {
    let clean = str.trim();
    clean = clean.replace(/^```json/iu, '').replace(/```$/u, '').trim();
    clean = clean.replace(/\/\*[\s\S]*?\*\//gu, '');
    clean = clean.replace(/(?<prefix>^|[^:])\/\/.*$/gmu, '$<prefix>');
    
    // Repair missing commas in the JSON output structure
    clean = repairMissingCommas(clean);
    
    clean = clean.replace(/,\s*(?<brace>[\]}])/gu, '$<brace>');
    return clean.trim();
};

const escapeControlCharsInStrings = (str) => {
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

const isEscaped = (s, pos) => {
    let count = 0;
    let index = pos - 1;
    while (index >= 0 && s[index] === '\\') {
        count++;
        index--;
    }
    return count % 2 === 1;
};

const findCandidates = (str, startIndex) => {
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

const escapeRange = (str, start, end) => {
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

const escapeInternalQuotes = (str) => {
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

const fixBracketTranspositions = (str) => {
    // Fix a common LLM bracket error: `]}` outside strings should be `}]`.
    // The LLM sometimes produces `"text"}}]}` instead of `"text"}}}]`,
    // transposing the `]` and `}` closers for deeply nested label objects.
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
            // Swap `]}` to `}]`: emit `}}]` instead of `]}`
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

const getErrorPosition = (err) => {
    const match = err.message.match(/position\s+(?<position>\d+)/iu);
    if (match && match.groups && match.groups.position) {
        return parseInt(match.groups.position, 10);
    }
    return null;
};

const tryParse = (text) => {
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

const _rawRepairTruncatedJson = (text) => {
    let repaired = text.trimEnd();
    // If the JSON ends mid-string, close the string
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

    // Remove trailing comma or colon left after truncation
    repaired = repaired.replace(/[,:\s]+$/u, '');

    // Count open brackets/braces and close them
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

    // Close all remaining open structures
    let closed = repaired;
    const revStack = [...stack];
    while (revStack.length > 0) {
        closed += revStack.pop();
    }
    return closed;
};

const repairTruncatedJson = (text) => {
    // Try without backtracking first
    try {
        const firstTry = _rawRepairTruncatedJson(text);
        JSON.parse(escapeControlCharsInStrings(escapeInternalQuotes(firstTry)));
        return firstTry;
    } catch (e) {
        // Fall back to backtracking
    }

    // Backtrack character-by-character from the end
    // We only need to backtrack up to a reasonable limit (e.g. 2000 chars)
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

    // If all else fails, return the original repair attempt (which will throw)
    return _rawRepairTruncatedJson(text);
};


const _rawExtractJson = (str) => {
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
            // Fall through to truncation repair below
            logger.warn(`[extractJson] Standard repair failed: ${e.message}. Attempting truncation repair...`);
        }
    }

    // Attempt truncation repair: the LLM response may have been cut off by max_tokens
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

const convertDeltasToRevisedModel = (threatDeltas, methodology = 'STRIDE', title = '', description = '') => {
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

const extractJson = (str, methodology = 'STRIDE') => {
    const parsed = _rawExtractJson(str);
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

const ensureModelMessageInHistory = (refinementHistory, questions, dfdApproved) => {
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


const getCellName = (cell) => {
    if (!cell) { return ''; }
    if (cell.data && cell.data.name) {
        return cell.data.name;
    }
    if (cell.attrs && cell.attrs.text && cell.attrs.text.text) {
        return cell.attrs.text.text;
    }
    return '';
};

const normalizeName = (name) => {
    if (!name) { return ''; }
    return name.toLowerCase().
               replace(/[\s\-_]+/gu, '').
               replace(/(?:svc|service|db|database|api|microsserviço|microservice|serviço)$/gu, '');
};

const areTitlesSimilar = (title1, title2) => {
    if (!title1 || !title2) { return false; }
    
    const stopWords = new Set([
        'de', 'do', 'da', 'em', 'para', 'sem', 'por', 'com', 'o', 'a', 'os', 'as', 'um', 'uma',
        'of', 'in', 'to', 'without', 'by', 'with', 'the', 'a', 'an',
        'uso', 'comprometimento', 'vazamento', 'exposicao', 'exposição', 'ataque', 'risco',
        'use', 'compromise', 'leak', 'exposure', 'attack', 'risk'
    ]);

    const getTokens = (title) => {
        const clean = title.toLowerCase().
            normalize('NFD').
            replace(/[\u0300-\u036f]/gu, ''). // remove diacritics
            replace(/[^\w\s]/gu, ' '). // replace punctuation with space
            split(/\s+/gu).
            map((w) => w.trim()).
            filter((w) => w.length > 1 && !stopWords.has(w));
        return new Set(clean);
    };

    const set1 = getTokens(title1);
    const set2 = getTokens(title2);

    if (set1.size === 0 || set2.size === 0) { return false; }

    let intersectionSize = 0;
    set1.forEach((token) => {
        if (set2.has(token)) {
            intersectionSize++;
        }
    });

    const unionSize = set1.size + set2.size - intersectionSize;
    const similarity = intersectionSize / unionSize;

    return similarity >= 0.55;
};

const normalizeCellThreats = (cells, diagramType) => {
    if (!Array.isArray(cells)) { return; }
    const generateUuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (c) => {
            const r = Math.floor(Math.random() * 16);
            const v = c === 'x' ? r : Math.floor(Math.random() * 4) + 8;
            return v.toString(16);
        });
    const defaultModelType = diagramType === 'MITRE_F3' ? 'MITRE_F3' : 'STRIDE';
    cells.forEach((cell) => {
        if (cell && cell.data && Array.isArray(cell.data.threats)) {
            cell.data.threats.forEach((t) => {
                const tid = t.id || t.threatId || generateUuid();
                t.id = tid;
                t.threatId = tid;
                if (!t.modelType) {
                    t.modelType = defaultModelType;
                }
            });
            cell.data.hasOpenThreats = cell.data.threats.some((t) => t.status === 'Open');
        }
    });
};

const mergeThreats = (fromCell, toCell) => {
    if (!fromCell || !fromCell.data || !fromCell.data.threats || fromCell.data.threats.length === 0) {
        return;
    }
    if (!toCell.data) {
        toCell.data = {};
    }
    if (!toCell.data.threats || toCell.data.threats.length === 0) {
        toCell.data.threats = fromCell.data.threats;
        return;
    }
    const revisedThreatIds = new Set(toCell.data.threats.map((t) => t.id || t.threatId));
    const revisedThreatTitles = new Set(toCell.data.threats.map((t) => t.title?.toLowerCase().trim()));
    fromCell.data.threats.forEach((t) => {
        const tid = t.id || t.threatId;
        const titleKey = t.title?.toLowerCase().trim();
        if (!revisedThreatIds.has(tid) && !revisedThreatTitles.has(titleKey)) {
            toCell.data.threats.push(t);
        }
    });
};

const deduplicateDiagramCells = (cells) => {
    if (!cells || cells.length === 0) { return cells; }

    const finalNodes = [];
    const finalFlows = [];
    const finalBoundaries = [];
    const others = [];

    const nodesByNormalizedName = new Map();
    const nodeIdRedirect = new Map();

    cells.forEach((cell) => {
        if (!cell) { return; }
        if (['actor', 'process', 'store'].includes(cell.shape)) {
            const name = getCellName(cell);
            const normName = normalizeName(name);
            if (!normName) {
                finalNodes.push(cell);
                return;
            }
            if (nodesByNormalizedName.has(normName)) {
                // Duplicate found!
                const canonicalNode = nodesByNormalizedName.get(normName);
                // Merge threats
                mergeThreats(cell, canonicalNode);
                // Redirect ID
                nodeIdRedirect.set(cell.id, canonicalNode.id);
            } else {
                nodesByNormalizedName.set(normName, cell);
                finalNodes.push(cell);
            }
        } else if (cell.shape === 'flow') {
            finalFlows.push(cell);
        } else if (['trust-boundary-curve', 'trust-boundary-box'].includes(cell.shape)) {
            finalBoundaries.push(cell);
        } else {
            others.push(cell);
        }
    });

    // Update flow endpoints using nodeIdRedirect and deduplicate flows
    const flowKeys = new Set();
    const updatedFlows = [];
    finalFlows.forEach((flow) => {
        if (!flow || !flow.source || !flow.target) { return; }
        const sourceId = flow.source.cell;
        const targetId = flow.target.cell;
        
        const mappedSourceId = nodeIdRedirect.get(sourceId) || sourceId;
        const mappedTargetId = nodeIdRedirect.get(targetId) || targetId;
        
        // Update the flow cell
        flow.source.cell = mappedSourceId;
        flow.target.cell = mappedTargetId;
        
        const flowKey = `${mappedSourceId}->${mappedTargetId}`;
        if (!flowKeys.has(flowKey)) {
            flowKeys.add(flowKey);
            updatedFlows.push(flow);
        } else {
            // Merge threats from duplicate flow if any
            const canonicalFlow = updatedFlows.find((f) => f.source.cell === mappedSourceId && f.target.cell === mappedTargetId);
            if (canonicalFlow) {
                mergeThreats(flow, canonicalFlow);
            }
        }
    });

    return [...finalNodes, ...updatedFlows, ...finalBoundaries, ...others];
};

const mergeControlsAssessment = (prevAssessments, newAssessments) => {
    if (!prevAssessments || !Array.isArray(prevAssessments)) {
        return newAssessments || [];
    }
    if (!newAssessments || !Array.isArray(newAssessments)) {
        return prevAssessments || [];
    }
    
    const mergedMap = new Map();
    
    prevAssessments.forEach((item) => {
        if (item && item.securityControl) {
            const key = item.securityControl.trim().toLowerCase();
            mergedMap.set(key, item);
        }
    });
    
    newAssessments.forEach((item) => {
        if (item && item.securityControl && item.userAnswer) {
            const key = item.securityControl.trim().toLowerCase();
            mergedMap.set(key, item);
        }
    });
    
    return Array.from(mergedMap.values());
};

const applyDeduplicationChanges = (model, controlsAssessment, proposals, approvedControlIds = [], approvedThreatIds = []) => {
    const newModel = JSON.parse(JSON.stringify(model));
    let newControls = [...(controlsAssessment || [])];
    
    if (!proposals) {return { model: newModel, controlsAssessment: newControls };}
    
    // 1. Apply control merges
    if (proposals.controlDeduplications && Array.isArray(proposals.controlDeduplications)) {
        proposals.controlDeduplications.forEach((proposal) => {
            if (approvedControlIds.includes(proposal.id)) {
                // Remove merged items
                const answersToMerge = proposal.itemsToMerge.map((i) => i.userAnswer?.trim().toLowerCase());
                newControls = newControls.filter((item) => {
                    const ans = item.userAnswer?.trim().toLowerCase();
                    return !answersToMerge.includes(ans);
                });
                // Add the merged proposal
                newControls.push(proposal.proposedMergedItem);
            }
        });
    }
    
    // 2. Apply threat merges
    if (proposals.threatDeduplications && Array.isArray(proposals.threatDeduplications)) {
        proposals.threatDeduplications.forEach((proposal) => {
            if (approvedThreatIds.includes(proposal.id)) {
                const { cellId } = proposal;
                // Find cell in the diagram
                if (newModel.detail && newModel.detail.diagrams && newModel.detail.diagrams[0]) {
                    const cells = newModel.detail.diagrams[0].cells || [];
                    const cell = cells.find((c) => c.id === cellId);
                    if (cell && cell.data && Array.isArray(cell.data.threats)) {
                        const originalThreatIds = proposal.itemsToMerge.map((t) => t.id).filter(Boolean);
                        const originalThreatTitles = proposal.itemsToMerge.map((t) => t.title?.trim().toLowerCase());
                        
                        // Remove original threats
                        cell.data.threats = cell.data.threats.filter((t) => {
                            if (originalThreatIds.includes(t.id)) {return false;}
                            if (originalThreatTitles.includes(t.title?.trim().toLowerCase())) {return false;}
                            return true;
                        });
                        
                        // Generate a unique ID for the merged threat
                        const mergedThreat = {
                            id: `threat-merged-${Math.random().toString(36).
substr(2, 9)}`,
                            ...proposal.proposedMergedThreat
                        };
                        
                        cell.data.threats.push(mergedThreat);
                    }
                }
            }
        });
    }
    
    return { model: newModel, controlsAssessment: newControls };
};

const mergeDiagramCells = (currentModel, revisedModel, refinementHistory, dfdApproved = false) => {
    if (!currentModel || !currentModel.detail || !currentModel.detail.diagrams || !currentModel.detail.diagrams[0]) {
        return revisedModel;
    }
    if (!revisedModel || !revisedModel.detail || !revisedModel.detail.diagrams || !revisedModel.detail.diagrams[0]) {
        return revisedModel;
    }

    const currentCells = currentModel.detail.diagrams[0].cells || [];
    const revisedDiagram = revisedModel.detail.diagrams[0];
    const revisedCells = revisedDiagram.cells || [];
    const diagramType = revisedDiagram ? revisedDiagram.diagramType : 'STRIDE';

    if (dfdApproved) {
        // Enforce 100% preservation of the approved topology
        const currentCellMap = new Map();
        const currentCellByName = new Map();
        currentCells.forEach((cell) => {
            if (cell && cell.id) {
                currentCellMap.set(cell.id, cell);
                if (['actor', 'process', 'store'].includes(cell.shape)) {
                    const normName = normalizeName(getCellName(cell));
                    if (normName) {
                        currentCellByName.set(normName, cell);
                    }
                }
            }
        });

        // We will modify a deep clone of the current cells to avoid side effects
        const preservedCells = JSON.parse(JSON.stringify(currentCells));
        const preservedCellMap = new Map(preservedCells.map((c) => [c.id, c]));
        const preservedCellByName = new Map();
        preservedCells.forEach((cell) => {
            if (cell && cell.id && ['actor', 'process', 'store'].includes(cell.shape)) {
                const normName = normalizeName(getCellName(cell));
                if (normName) {
                    preservedCellByName.set(normName, cell);
                }
            }
        });

        // Keep track of which preserved cells have had their threats updated in this round
        const updatedCellIds = new Set();

        // Merge threats from revised cells into preserved cells
        revisedCells.forEach((revisedCell) => {
            if (!revisedCell) {return;}
            
            // Find corresponding preserved cell
            let targetCell = null;
            if (revisedCell.id && preservedCellMap.has(revisedCell.id)) {
                targetCell = preservedCellMap.get(revisedCell.id);
            } else if (['actor', 'process', 'store'].includes(revisedCell.shape)) {
                const normName = normalizeName(getCellName(revisedCell));
                if (normName) {
                    targetCell = preservedCellByName.get(normName);
                }
            }

            if (targetCell) {
                // Initialize threats array if it doesn't exist
                if (!targetCell.data) {targetCell.data = {};}
                if (!targetCell.data.threats) {targetCell.data.threats = [];}

                // Merge threats from revised cell into targetCell (updating matching threats and adding new ones)
                const revisedThreats = revisedCell.data?.threats || [];
                const existingThreatMap = new Map();
                const existingThreatByTitle = new Map();
                targetCell.data.threats.forEach((t) => {
                    const tid = t.id || t.threatId;
                    if (tid) {
                        existingThreatMap.set(tid, t);
                    }
                    if (t.title) {
                        existingThreatByTitle.set(t.title.toLowerCase().trim(), t);
                    }
                });

                revisedThreats.forEach((rt) => {
                    const rtid = rt.id || rt.threatId;
                    let matchedThreat = null;
                    if (rtid && existingThreatMap.has(rtid)) {
                        matchedThreat = existingThreatMap.get(rtid);
                    } else if (rt.title && existingThreatByTitle.has(rt.title.toLowerCase().trim())) {
                        matchedThreat = existingThreatByTitle.get(rt.title.toLowerCase().trim());
                    } else if (rt.title) {
                        const cleanTitle = rt.title.toLowerCase().trim();
                        matchedThreat = targetCell.data.threats.find((t) => t.title && areTitlesSimilar(t.title, cleanTitle));
                    }

                    if (matchedThreat) {
                        // Update existing threat fields with revised LLM content
                        if (rt.title) { matchedThreat.title = rt.title; }
                        if (rt.description) { matchedThreat.description = rt.description; }
                        if (rt.mitigation) { matchedThreat.mitigation = rt.mitigation; }
                        if (rt.status) { matchedThreat.status = rt.status; }
                        if (rt.severity) { matchedThreat.severity = rt.severity; }
                        if (rt.score) { matchedThreat.score = rt.score; }
                        if (rt.type) { matchedThreat.type = rt.type; }
                        if (rt.modelType) { matchedThreat.modelType = rt.modelType; }
                        if (rt.number) { matchedThreat.number = rt.number; }
                    } else {
                        // Brand new threat, add it
                        targetCell.data.threats.push(rt);
                    }
                });
                targetCell.data.hasOpenThreats = targetCell.data.threats.some((t) => t.status === 'Open');
                updatedCellIds.add(targetCell.id);
            } else {
                // If a completely new element is generated (e.g. user requested it), add it
                preservedCells.push(revisedCell);
            }
        });

        revisedDiagram.cells = healDiagramCells(deduplicateDiagramCells(preservedCells));
        normalizeCellThreats(revisedDiagram.cells, diagramType);
        if (currentModel && currentModel.summary) {
            revisedModel.summary = { ...currentModel.summary };
        }
        return revisedModel;
    }

    const revisedCellMap = new Map();
    revisedCells.forEach((cell) => {
        if (cell && cell.id) {
            revisedCellMap.set(cell.id, cell);
        }
    });

    const revisedNodeByName = new Map();
    revisedCells.forEach((cell) => {
        if (cell && cell.id && ['actor', 'process', 'store'].includes(cell.shape)) {
            const normName = normalizeName(getCellName(cell));
            if (normName) {
                revisedNodeByName.set(normName, cell);
            }
        }
    });

    const lastUserMsg = refinementHistory && [...refinementHistory].reverse().find((msg) => msg.role === 'user');
    const userMessage = lastUserMsg ? lastUserMsg.text.toLowerCase() : '';
    const hasDeletionKeyword = (/delet|exclu|remov|apag|clear|clean/iu).test(userMessage);

    const mergedCells = [...revisedCells];
    const nodeIdMapping = new Map();

    // Map exact ID matches
    currentCells.forEach((cell) => {
        if (cell && cell.id && revisedCellMap.has(cell.id)) {
            nodeIdMapping.set(cell.id, cell.id);
        }
    });

    // Match name similarities to prevent duplicates and merge threats
    currentCells.forEach((currentCell) => {
        if (!currentCell || !currentCell.id || !['actor', 'process', 'store'].includes(currentCell.shape)) {
            return;
        }
        if (nodeIdMapping.has(currentCell.id)) { return; }
        const normName = normalizeName(getCellName(currentCell));
        const matchingRevisedCell = revisedNodeByName.get(normName);
        if (matchingRevisedCell) {
            nodeIdMapping.set(currentCell.id, matchingRevisedCell.id);
            mergeThreats(currentCell, matchingRevisedCell);
        }
    });

    const revisedFlowSet = new Set();
    revisedCells.forEach((cell) => {
        if (cell && cell.shape === 'flow' && cell.source && cell.source.cell && cell.target && cell.target.cell) {
            revisedFlowSet.add(`${cell.source.cell}->${cell.target.cell}`);
        }
    });

    if (!hasDeletionKeyword) {
        currentCells.forEach((currentCell) => {
            if (!currentCell || !currentCell.id) { return; }

            if (['actor', 'process', 'store'].includes(currentCell.shape)) {
                if (!nodeIdMapping.has(currentCell.id)) {
                    mergedCells.push(currentCell);
                }
                return;
            }

            if (currentCell.shape === 'flow') {
                const sourceId = currentCell.source && currentCell.source.cell;
                const targetId = currentCell.target && currentCell.target.cell;
                if (!sourceId || !targetId) { return; }

                const mappedSourceId = nodeIdMapping.get(sourceId) || sourceId;
                const mappedTargetId = nodeIdMapping.get(targetId) || targetId;
                const flowKey = `${mappedSourceId}->${mappedTargetId}`;

                if (!revisedCellMap.has(currentCell.id) && !revisedFlowSet.has(flowKey)) {
                    const restoredFlow = {
                        ...currentCell,
                        source: { ...currentCell.source, cell: mappedSourceId },
                        target: { ...currentCell.target, cell: mappedTargetId }
                    };
                    mergedCells.push(restoredFlow);
                    revisedFlowSet.add(flowKey);
                    return;
                }

                if (revisedCellMap.has(currentCell.id)) {
                    const revisedCell = revisedCellMap.get(currentCell.id);
                    mergeThreats(currentCell, revisedCell);
                }
                return;
            }

            if (!['trust-boundary-curve', 'trust-boundary-box'].includes(currentCell.shape)) {
                if (!revisedCellMap.has(currentCell.id)) {
                    mergedCells.push(currentCell);
                }
            }
        });
    }

    revisedDiagram.cells = healDiagramCells(deduplicateDiagramCells(mergedCells));
    normalizeCellThreats(revisedDiagram.cells, diagramType);
    return revisedModel;
};

const splitTextIntoChunks = (text, chunkSize = 1000, overlap = 150) => {
    const chunks = [];
    if (!text || text.trim() === '') {return chunks;}
    
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


const clientFactory = {
    getOpenAIClient(aiConfig) {
        const agent = getProxyAgent('OpenAI SDK Fetch');
        const options = {
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseUrl,
            fetch: async (url, init) => {
                const headers = {};
                if (init.headers) {
                    if (typeof init.headers.forEach === 'function') {
                        init.headers.forEach((value, key) => {
                            headers[key] = value;
                        });
                    } else {
                        Object.assign(headers, init.headers);
                    }
                }

                const config = {
                    method: init.method || 'GET',
                    url: url,
                    headers: headers,
                    data: init.body,
                    timeout: init.timeout || 180000,
                    responseType: 'stream',
                    proxy: false
                };

                if (agent) {
                    config.httpAgent = agent;
                    config.httpsAgent = agent;
                }

                try {
                    const res = await axios(config);

                    const readStream = () => new Promise((resolve, reject) => {
                        let data = '';
                        res.data.on('data', (chunk) => {
                            data += chunk.toString('utf8');
                        });
                        res.data.on('end', () => resolve(data));
                        res.data.on('error', (err) => reject(err));
                    });

                    return {
                        ok: res.status >= 200 && res.status < 300,
                        status: res.status,
                        statusText: res.statusText,
                        headers: {
                            get(name) {
                                return res.headers[name.toLowerCase()];
                            },
                            entries() {
                                return Object.entries(res.headers);
                            },
                            [Symbol.iterator]() {
                                return Object.entries(res.headers)[Symbol.iterator]();
                            }
                        },
                        text: readStream,
                        json: async () => {
                            const txt = await readStream();
                            return JSON.parse(txt);
                        },
                        body: res.data
                    };
                } catch (err) {
                    if (err.response) {
                        const readErrStream = () => new Promise((resolve) => {
                            if (typeof err.response.data?.on !== 'function') {
                                resolve(JSON.stringify(err.response.data || ''));
                                return;
                            }
                            let data = '';
                            err.response.data.on('data', (chunk) => {
                                data += chunk.toString('utf8');
                            });
                            err.response.data.on('end', () => resolve(data));
                            err.response.data.on('error', () => resolve(JSON.stringify(err.response.data || '')));
                        });

                        return {
                            ok: false,
                            status: err.response.status,
                            statusText: err.response.statusText,
                            headers: {
                                get(name) {
                                    return err.response.headers[name.toLowerCase()];
                                },
                                entries() {
                                    return Object.entries(err.response.headers);
                                },
                                [Symbol.iterator]() {
                                    return Object.entries(err.response.headers)[Symbol.iterator]();
                                }
                            },
                            text: readErrStream,
                            json: async () => {
                                const txt = await readErrStream();
                                try {
                                    return JSON.parse(txt);
                                } catch {
                                    return txt;
                                }
                            },
                            body: err.response.data
                        };
                    }
                    throw err;
                }
            }
        };
        return new OpenAI(options);
    }
};


const recoverBedrockMantleResponse = async (promptText, aiConfig) => {
    /* eslint-disable max-depth, no-await-in-loop */
    const listUrl = `${aiConfig.baseUrl}/responses`;
    logger.info(`[recoverBedrockMantleResponse] Attempting to list responses from URL: ${listUrl}`);
    
    const agent = getProxyAgent('Axios Recovery');
    const listAxiosConfig = {
        headers: {
            'Authorization': `Bearer ${aiConfig.apiKey}`,
            'Content-Type': 'application/json'
        },
        params: {
            limit: 5
        },
        timeout: 10000,
        proxy: false
    };
    if (agent) {
        listAxiosConfig.httpAgent = agent;
        listAxiosConfig.httpsAgent = agent;
    }
    
    let listResponse = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            listResponse = await axios.get(listUrl, listAxiosConfig);
            break;
        } catch (listErr) {
            const listErrMessage = listErr?.message || String(listErr);
            logger.warn(`[recoverBedrockMantleResponse] Attempt ${attempt} to list responses from URL ${listUrl} failed: ${listErrMessage}`);
            if (attempt < 3) {
                logger.info(`[recoverBedrockMantleResponse] Waiting 2 seconds before retrying list responses...`);
                await new Promise((resolve) => { setTimeout(resolve, 2000); });
            } else {
                throw listErr;
            }
        }
    }
    
    if (!listResponse?.data || !Array.isArray(listResponse.data.data) || listResponse.data.data.length === 0) {
        logger.warn(`[recoverBedrockMantleResponse] No recent responses found at URL ${listUrl}`);
        return null;
    }

    const matchingResponse = listResponse.data.data.find((r) => {
        const serializedNormalized = (JSON.stringify(r) || '').toLowerCase().replace(/[^a-z0-9]/gu, '');
        const targetSlice = (promptText || '');
        const promptNormalized = targetSlice.slice(0, Math.min(targetSlice.length, 200)).toLowerCase().
replace(/[^a-z0-9]/gu, '');
        return serializedNormalized.includes(promptNormalized);
    });
    
    if (!matchingResponse) {
        logger.warn(`[recoverBedrockMantleResponse] No matching response found in the recent list for the current prompt.`);
        return null;
    }
    
    let targetResponse = matchingResponse;
    
    if (targetResponse.status === 'in_progress' || targetResponse.status === 'pending') {
        logger.info(`[recoverBedrockMantleResponse] Found matching response ${targetResponse.id} with status ${targetResponse.status}. Polling for completion...`);
        const retrieveUrl = `${aiConfig.baseUrl}/responses/${targetResponse.id}`;
        logger.info(`[recoverBedrockMantleResponse] Attempting to retrieve individual response from URL: ${retrieveUrl}`);
        
        for (let attempt = 1; attempt <= 20; attempt++) {
            await new Promise((resolve) => { setTimeout(resolve, 5000); });
            
            try {
                const retrieveAxiosConfig = {
                    headers: {
                        'Authorization': `Bearer ${aiConfig.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000,
                    proxy: false
                };
                if (agent) {
                    retrieveAxiosConfig.httpAgent = agent;
                    retrieveAxiosConfig.httpsAgent = agent;
                }
                const pollResponse = await axios.get(retrieveUrl, retrieveAxiosConfig);
                if (pollResponse?.data) {
                    targetResponse = pollResponse.data;
                    logger.info(`[recoverBedrockMantleResponse] Polling attempt ${attempt} for URL ${retrieveUrl}: status is ${targetResponse.status}`);
                    if (targetResponse.status === 'completed' || targetResponse.status === 'failed') {
                        break;
                    }
                }
            } catch (pollErr) {
                const pollErrMessage = pollErr?.message || String(pollErr);
                logger.error(`[recoverBedrockMantleResponse] Polling attempt ${attempt} failed for URL ${retrieveUrl}: ${pollErrMessage}`);
            }
        }
    }
    
    if (targetResponse.status === 'completed') {
        logger.info(`[recoverBedrockMantleResponse] Successfully recovered timed-out response from Bedrock Mantle. Response ID: ${targetResponse.id}`);
        const content = targetResponse.output?.choices?.[0]?.message?.content || 
                        targetResponse.output?.output_text || 
                        targetResponse.output || '';
        if (content) {
            return content;
        }
    } else {
        logger.warn(`[recoverBedrockMantleResponse] Recovered response ${targetResponse.id} status is ${targetResponse.status}, not completed.`);
    }

    return null;
    /* eslint-enable max-depth, no-await-in-loop */
};


const callBedrockMantle = async (promptText, images, aiConfig, job = null) => {
    const messages = [];
    let userContent = [];
    if (promptText) {
        userContent.push({ type: 'text', text: promptText });
    }
    if (images && images.length > 0) {
        images.forEach((img) => {
            const parsed = parseBase64Image(img.data || img);
            userContent.push({
                type: 'image_url',
                image_url: { url: `data:${parsed.mimeType};base64,${parsed.data}` }
            });
        });
    }
    
    if (userContent.length === 1 && userContent[0].type === 'text') {
        userContent = userContent[0].text;
    }

    messages.push({ role: 'user', content: userContent });

    const openai = clientFactory.getOpenAIClient(aiConfig);
    logger.info(`[callBedrockMantle] Bedrock Mantle sending chat completion request via OpenAI SDK to URL: ${aiConfig.baseUrl}/chat/completions`);

    const requestPayload = {
        model: aiConfig.model || 'meta.llama3-70b-instruct-v1:0',
        messages: messages,
        max_tokens: 16384,
        stream: true
    };

    if (aiConfig.extendedThinking) {
        requestPayload.thinking = {
            type: 'enabled',
            budget_tokens: 2048
        };
        requestPayload.reasoning_effort = 'medium';
    }

    try {
        const stream = await openai.chat.completions.create(
            requestPayload,
            {
                timeout: REQUEST_TIMEOUT
            }
        );

        if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
            logger.info(`[callBedrockMantle] Bedrock Mantle stream response initiated. Reading chunks...`);
            let fullContent = '';
            for await (const chunk of stream) {
                const content = chunk.choices?.[0]?.delta?.content || '';
                fullContent += content;
                if (job) {
                    job.streamText = fullContent;
                    activeJobs.set(job.jobId, { ...job });
                }
            }

            logger.info(`[callBedrockMantle] Bedrock Mantle stream response fully received via OpenAI SDK.`);
            return fullContent;
        } 
            logger.info(`[callBedrockMantle] Bedrock Mantle response received (non-stream / test stub).`);
            return stream?.choices?.[0]?.message?.content || '';
        
    } catch (err) {
        const errName = err?.name;
        const errMessage = err?.message;
        
        logger.warn(`[callBedrockMantle] Bedrock Mantle request to ${aiConfig.baseUrl}/chat/completions failed with error: ${errMessage} (${errName}). Attempting to recover response...`);
        try {
            const content = await recoverBedrockMantleResponse(promptText, aiConfig);
            if (content) {
                return content;
            }
        } catch (recoverErr) {
            const recoverErrMessage = recoverErr?.message || String(recoverErr);
            logger.error(`[callBedrockMantle] Failed to recover response: ${recoverErrMessage}`);
        }
        throw err;
    }
};


const callGemini = async (promptText, images, aiConfig) => {
    const parts = [];
    if (promptText) {
        parts.push({ text: promptText });
    }
    if (images && images.length > 0) {
        images.forEach((img) => {
            const parsed = parseBase64Image(img.data || img);
            parts.push({
                inlineData: { mimeType: parsed.mimeType, data: parsed.data }
            });
        });
    }

    const payload = {
        contents: [{ parts }],
        generationConfig: {
            maxOutputTokens: 16384,
            responseMimeType: 'application/json'
        }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${aiConfig.apiKey}`;
    logger.info(`[callGemini] Gemini sending POST request to API. Payload size: ${JSON.stringify(payload).length} characters`);

    try {
        const response = await axios.post(
            url,
            payload,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: REQUEST_TIMEOUT
            }
        );

        logger.info(`[callGemini] Gemini response status: ${response.status}`);
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    } catch (err) {
        logger.error(`[callGemini] HTTP/API Request Failed: ${err.message}`);
        if (err.response) {
            logger.error(`[callGemini] Error Response Status: ${err.response.status}`);
            try {
                logger.error(`[callGemini] Error Response Headers: ${JSON.stringify(err.response.headers)}`);
            } catch (e) {
                logger.error(`[callGemini] Error Response Headers: [Could not serialize]`);
            }
            try {
                // err.response.data may be a stream (circular) when responseType is 'stream'
                const data = typeof err.response.data === 'object' && typeof err.response.data?.on === 'function'
                    ? '[Stream - not serializable]'
                    : JSON.stringify(err.response.data);
                logger.error(`[callGemini] Error Response Data: ${data}`);
            } catch (e) {
                logger.error(`[callGemini] Error Response Data: [Could not serialize]`);
            }
        } else if (err.request) {
            // err.request is an http.ClientRequest with circular references (socket -> parser -> socket)
            logger.error(`[callGemini] Request was sent but no response was received (possible timeout or network error).`);
        }
        throw err;
    }
};


const callAIModel = async (promptText, images, aiConfig, job = null) => {
    if (job) {
        job.streamText = '';
        activeJobs.set(job.jobId, { ...job });
    }
    if (aiConfig.provider === 'bedrock-mantle') {
        return callBedrockMantle(promptText, images, aiConfig, job);
    }
    return callGemini(promptText, images, aiConfig);
};

const getEmbeddingsBatch = async (chunks, aiConfig) => {
    if (chunks.length === 0) {return [];}
    const batchSize = 100;
    const allEmbeddings = [];
    
    for (let i = 0; i < chunks.length; i += batchSize) {
        const slice = chunks.slice(i, i + batchSize);
        if (aiConfig.provider === 'bedrock-mantle') {
            const openai = clientFactory.getOpenAIClient(aiConfig);
            /* eslint-disable-next-line no-await-in-loop */
            const response = await openai.embeddings.create({
                model: aiConfig.embeddingModel || 'amazon.titan-embed-text-v1',
                input: slice
            }, {
                timeout: 30000
            });
            if (response && response.data) {
                response.data.forEach((emb) => {
                    allEmbeddings.push(emb.embedding);
                });
            }
        } else {
            const requests = slice.map((chunk) => ({
                model: 'models/gemini-embedding-001',
                content: { parts: [{ text: chunk }] }
            }));
            
            /* eslint-disable-next-line no-await-in-loop */
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${aiConfig.apiKey}`,
                { requests },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000
                }
            );
            
            if (response.data && response.data.embeddings) {
                response.data.embeddings.forEach((emb) => {
                    if (emb && emb.values) {
                        allEmbeddings.push(emb.values);
                    }
                });
            }
        }
    }
    return allEmbeddings;
};

const getEmbedding = async (text, aiConfig) => {
    if (aiConfig.provider === 'bedrock-mantle') {
        const openai = clientFactory.getOpenAIClient(aiConfig);
        const response = await openai.embeddings.create({
            model: aiConfig.embeddingModel || 'amazon.titan-embed-text-v1',
            input: text
        }, {
            timeout: 20000
        });
        if (response && response.data && response.data[0]) {
            return response.data[0].embedding;
        }
    } else {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${aiConfig.apiKey}`,
            {
                model: 'models/gemini-embedding-001',
                content: { parts: [{ text }] }
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 20000
            }
        );
        if (response.data && response.data.embedding && response.data.embedding.values) {
            return response.data.embedding.values;
        }
    }
    throw new Error('Failed to generate query embedding');
};

const cosineSimilarity = (vecA, vecB) => {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {return 0;}
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) {return 0;}
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

const retrieveContext = async (query, sessionId, aiConfig, topK = 8) => {
    try {
        const chunks = aiContextStore.getVectors(sessionId);
        if (!chunks || chunks.length === 0) {
            logger.info(`No chunks found in vector store for session ${sessionId}`);
            return '';
        }
        
        logger.info(`Retrieving context from local RAG for query: "${query}"`);
        const queryEmbedding = await getEmbedding(query, aiConfig);
        
        const chunksWithScores = chunks.map((chunk) => {
            const score = cosineSimilarity(queryEmbedding, chunk.vector);
            return { ...chunk, score };
        });
        
        chunksWithScores.sort((a, b) => b.score - a.score);
        const topChunks = chunksWithScores.slice(0, topK);
        
        let retrievedText = '\n--- CONTEXTO RELEVANTE DA DOCUMENTAÇÃO (RAG LOCAL) ---\n';
        topChunks.forEach((chunk, i) => {
            retrievedText += `\n[Trecho ${i + 1} de ${chunk.docName} (Similaridade: ${chunk.score.toFixed(3)})]:\n${chunk.text}\n`;
        });
        return retrievedText;
    } catch (err) {
        logger.error(`Error during local RAG retrieval for session ${sessionId}: ${err.message}`);
        return '';
    }
};

const extractTextFromDocs = (docs) => {
    if (!docs || docs.length === 0) {return [];}
    
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

const generateAndSaveEmbeddings = async (sessionId, docsTexts, aiConfig) => {
    if (!docsTexts || docsTexts.length === 0) {return;}
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

const activeJobs = new Map();

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

const getMaxContextChars = (aiConfig) => {
    if (aiConfig?.maxContextTokens) {
        const tokens = Number(aiConfig.maxContextTokens);
        if (!isNaN(tokens) && tokens > 0) {
            const actualTokens = tokens <= 2048 ? tokens * 1000 : tokens;
            return actualTokens * 3;
        }
    }

    const provider = aiConfig?.provider;
    const model = (aiConfig?.model || '').toLowerCase();

    // Default conservative limit (15k chars, ~5k tokens)
    let maxChars = 15000;

    if (provider === 'gemini') {
        // Gemini 1.5 Flash/Pro supports 1M+ tokens, let's allow up to 600k characters (~200k tokens)
        maxChars = 600000;
    } else if (provider === 'bedrock-mantle') {
        if (model.includes('llama3.1') || model.includes('llama-3.1')) {
            // Llama 3.1 has a 128k token context. Let's allow up to 250k characters (~80k tokens)
            maxChars = 250000;
        } else if (model.includes('claude-3') || model.includes('claude-v3') || model.includes('sonnet') || model.includes('haiku')) {
            // Claude 3 has 200k token context. Let's allow up to 400k characters (~130k tokens)
            maxChars = 400000;
        } else if (model.includes('meta.llama3') || model.includes('llama3')) {
            // Llama 3 has 8k token context (very small). Let's keep it to 15k characters (~5k tokens)
            maxChars = 15000;
        } else {
            // Default Bedrock Mantle model or custom model: assume at least 128k context if it is newer
            // Let's be moderately generous: 100k characters (~30k tokens)
            maxChars = 100000;
        }
    }

    return maxChars;
};

const getQuestionBatchSize = (aiConfig) => {
    if (aiConfig?.questionBatchSize) {
        const size = Number(aiConfig.questionBatchSize);
        if (!isNaN(size) && size > 0) {
            return Math.min(size, 15);
        }
    }

    const maxChars = getMaxContextChars(aiConfig);
    let batchSize = 3;

    if (maxChars >= 600000) {
        batchSize = 8;
    } else if (maxChars >= 250000) {
        batchSize = 5;
    } else if (maxChars >= 100000) {
        batchSize = 4;
    } else {
        batchSize = 3;
    }

    return batchSize;
};


const runGenerateJob = async (job, body, activeSession, finalDocs, finalImages, finalMethodology, dfdApprovedBool, aiConfig) => {
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
            aiContextStore.updateSession(activeSession.sessionId, { embeddingsGenerated: true });
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
        let methodologyPrompt = '';
        if (finalMethodology === 'MITRE_F3') {
            methodologyPrompt = `
You must perform Threat Modeling focusing on the MITRE Fight Fraud Framework (F3) for financial fraud prevention.
Strictly map threats to elements using these MITRE F3 tactics, and ensure your generated threats and clarifying questions focus specifically on fraud scenarios (not standard IT/network security):
- "Reconnaissance": Fraudsters gathering information on target users, routing numbers, API structures, transaction flows, or fraud system limits.
- "Resource Development": Fraudsters acquiring/preparing assets for fraud, such as mule accounts, stolen credentials, synthetic identities, or spoofed devices.
- "Initial Access": Fraudsters gaining entry to legitimate user accounts or system interfaces (e.g. credential stuffing, phishing, account takeover).
- "Defense Evasion": Fraudsters bypassing or evading fraud detection controls (e.g. bypassing KYC verification, spoofing device fingerprinting, mimicking normal user behavior, keeping transaction velocity low).
- "Positioning": Fraudsters preparing for monetization within the system (e.g. linking external bank accounts, changing transaction limits, adding new payees/beneficiaries).
- "Execution": Fraudsters carrying out unauthorized or fraudulent actions/transactions (e.g. initiating fraudulent bank transfers, executing illicit checkout payments, submitting fake invoices).
- "Monetization": Fraudsters converting the fraudulent action into cash or liquid value (e.g. cashing out via money mules, gift card conversion, moving funds to unregulated cryptocurrency accounts).

Strictly map these tactics to element types:
- "actor" (External Entity / Fraudster): Applicable threat categories are "Reconnaissance", "Resource Development", and "Initial Access".
- "process" (Internal System / Financial Engine): Applicable threat categories are "Defense Evasion", "Execution", and "Positioning".
- "store" (Data Store / Credentials Cache): Applicable threat categories are "Initial Access" and "Monetization".
- "flow" (Data Flow / Transfer): Applicable threat categories are "Execution" and "Monetization".

For each threat, the threat's "type" property MUST be set to one of the F3 tactics above, and its "modelType" property MUST be exactly "MITRE_F3".
`;
        } else if (finalMethodology === 'LINDDUN') {
            methodologyPrompt = `
You must perform Threat Modeling focusing on the LINDDUN privacy methodology.
Strictly map threats to elements using these LINDDUN categories:
- "actor" (Data Subject): Applicable categories are "Linkability", "Identifiability", "Unawareness", and "Non-compliance".
- "process": Applicable categories are "Linkability", "Identifiability", "Non-repudiation", "Detectability", "Disclosure of information", "Unawareness", and "Non-compliance".
- "store" (Data Store): Applicable categories are "Linkability", "Identifiability", "Detectability", "Disclosure of information", and "Non-compliance".
- "flow" (Data Flow): Applicable categories are "Linkability", "Identifiability", "Detectability", and "Disclosure of information".

For each threat, the threat's "type" property MUST be set to one of the LINDDUN categories above, and its "modelType" property MUST be exactly "LINDDUN".
`;
        } else if (finalMethodology === 'CIA') {
            methodologyPrompt = `
You must perform Threat Modeling focusing on the CIA triad (Confidentiality, Integrity, Availability).
Strictly map threats to elements using these CIA categories:
- "actor" (External Entity): Applicable categories are "Confidentiality" only.
- "process": Applicable categories are "Confidentiality", "Integrity", and "Availability".
- "store" (Data Store): Applicable categories are "Confidentiality", "Integrity", and "Availability".
- "flow" (Data Flow): Applicable categories are "Confidentiality", "Integrity", and "Availability".

For each threat, the threat's "type" property MUST be set to one of the CIA categories above, and its "modelType" property MUST be exactly "CIA".
`;
        } else if (finalMethodology === 'DIE') {
            methodologyPrompt = `
You must perform Threat Modeling focusing on the DIE model (Distributed, Immutable, Ephemeral) for cloud-native infrastructure resilience.
Strictly map threats to elements using these DIE categories:
- "actor" (External Entity): No DIE categories apply to external actors.
- "process": Applicable categories are "Distributed", "Immutable", and "Ephemeral".
- "store" (Data Store): Applicable categories are "Distributed", "Immutable", and "Ephemeral".
- "flow" (Data Flow): Applicable categories are "Distributed" and "Ephemeral".

For each threat, the threat's "type" property MUST be set to one of the DIE categories above, and its "modelType" property MUST be exactly "DIE".
`;
        } else if (finalMethodology === 'PLOT4ai') {
            methodologyPrompt = `
You must perform Threat Modeling focusing on the PLOT4ai framework (Practical Library Of Threats for AI).
Strictly map threats to elements using these PLOT4ai categories:
- "actor": Applicable categories are "Privacy & Data Protection" and "Ethics & Human Rights".
- "process": Applicable categories are "Data & Data Governance", "Privacy & Data Protection", "Cybersecurity", "Safety & Environmental Impact", "Bias, Fairness & Discrimination", "Transparency & Accessibility", "Ethics & Human Rights", and "Accountability & Human Oversight".
- "store" (Data Store): Applicable categories are "Data & Data Governance", "Privacy & Data Protection", and "Bias, Fairness & Discrimination".
- "flow" (Data Flow): Applicable categories are "Privacy & Data Protection" and "Cybersecurity".

For each threat, the threat's "type" property MUST be set to one of the PLOT4ai categories above, and its "modelType" property MUST be exactly "PLOT4ai".
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

        // 2. Build the detailed instruction prompt for generator (separated into DFDAgent and ThreatAgent)
        let promptText = '';
        let jsonKeysInstruction = '';
        let questionsInstruction = '';
        let roundGroups = [];
        let activeQuestionsPrompt = '';

        if (!dfdApprovedBool) {
            questionsInstruction = `An array containing EXACTLY ONE string in Portuguese.
You are strictly FORBIDDEN from generating custom clarifying questions or asking about security controls, authentication, protocols, encryption, logging, or threats in this phase.
Instead, you MUST return exactly this single validation string:
"Por favor, valide o diagrama de fluxo de dados (DFD) proposto acima. Se houver algum componente, fluxo ou fronteira de confiança faltando ou incorreto, descreva os ajustes necessários. Se estiver de acordo, clique em \\"Yes, DFD is Complete\\" para prosseguir para a análise de ameaças."`;
            promptText = `You are the DFDAgent, a specialized system architect and Data Flow Diagram (DFD) layout expert.
Your sole responsibility is to analyze the provided architecture documentation and system diagrams, perform system decomposition, and return a complete Threat Dragon V2 JSON object representing the DFD topology.

CURRENT REFINEMENT PHASE: DFD TOPOLOGY REFINEMENT (Phase 1)
- Your main goal is to map the elements and flows correctly.
- Do NOT generate detailed threats in the 'threats' array of the cells. Keep the 'threats' array empty ([]) for all cells for now.
- Do NOT ask any custom questions about security, protocols, databases, or access rules. Return exactly the single validation question in the "questions" array.
`;
            jsonKeysInstruction = `You MUST return ONLY a JSON object containing two keys:
1. "questions": ${questionsInstruction}
2. "threatModel": The valid Threat Dragon V2 JSON object containing the summary and detail (diagrams, cells, and threats).`;
        } else {
            // Get the next batch of planned questions from the plan
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
            promptText = `You are the ThreatAgent, a specialized security auditor and Threat Modeling expert.
Your sole responsibility is to analyze the approved Data Flow Diagram (DFD) topology, identify security threats (e.g. STRIDE/MITRE) for each cell, evaluate their severities, risk scores, scenario descriptions, and mitigations, and keep updating the threat model.

CURRENT REFINEMENT PHASE: THREAT ANALYSIS & SECURITY CONTROLS REFINEMENT (Phase 2)
- The Data Flow Diagram (DFD) topology has been APPROVED by the user.
- Your main goal is to identify and catalog security threats (e.g. STRIDE/MITRE) for each cell (actor, process, store, flow), assess existing mitigations, and calculate risk scores and severities.
- THREAT QUANTITY PER ELEMENT/FLOW: Depending on the system architecture and the data processed, each element (actor, process, store) and each flow can have zero, one, or multiple threats covering different STRIDE/MITRE categories. If a component is critical or exposed, map multiple distinct, detailed threats to it.
- DETAILED DESCRIPTIONS AND MITIGATIONS: Every threat must have a highly comprehensive, extensive, and detailed attack scenario description (explain exactly how an attacker would exploit the gap, the threat vectors, Entry Points, and specific impact) and complete, step-by-step technical mitigation details (specifying concrete security configurations, protocols, library names, code pattern practices, or architectural changes, rather than generic recommendations). Make them as detailed, long, and technical as possible!
- CONTINUOUS EVOLUTION AND MAP PROGRESSION: At each round of refinement questions, you MUST:
  - Map *new* threats to elements and flows based on the new context provided in the conversation history.
  - Refine, expand, and rewrite existing threats to make their descriptions and mitigations much more detailed, technical, and complete.
  - Adjust threat status (e.g. "Mitigated" vs "Open"), severity, and score based on the user's answers.
  - Keep all existing threats in the model unless explicitly invalidated, updating and expanding their details continuously.
- For each threat, you MUST assign:
  1. A concrete scenario 'description'.
  2. Actionable technical 'mitigation' details.
  3. A 'severity' level matching the risk impact.
  4. A risk 'score' value.
- Your clarifying questions in the "questions" array target probing the user about secure configuration details, deployment parameters, authentication practices, and specific network boundaries for the assigned groups. Even if you feel you have enough context to generate initial threats, you MUST formulate these questions to validate your assumptions and help refine the severity scores and mitigations. Generating a question for each assigned group is mandatory for the framework's completeness, and you are strictly forbidden from returning an empty array in the 'questions' property if groups are assigned below.
`;
            let previousQuestionsPrompt = '';
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

        if (!dfdApprovedBool) {
            promptText += `
INTEGRITY AND CONNECTIVITY MANDATORY RULES:
1. NO ISOLATED NODES: The system diagram must be a fully connected graph. For EVERY node (actor, process, store) created, you MUST create at least one connection flow (shape: "flow") that links it to other nodes in the system. Check the input architecture diagram and documentation, and trace the lines/arrows representing communication pathways into "flow" cells.
2. SYSTEM DECOMPOSITION: Do NOT group different backend services or microservices into a single generic node (such as "Microsserviços Internos" or "Backend Servers"). Each distinct service/pod shown in the architecture (e.g., Account Management, Transaction Processing, Card Services) MUST have its own dedicated "process" cell.
3. TRUST BOUNDARIES: You MUST draw trust boundaries ("trust-boundary-box" or "trust-boundary-curve" with zIndex: -1) to isolate different execution zones and network scopes (e.g., Public Internet, Kubernetes/AKS Cluster, Managed Cloud Databases).
4. CHAIN-OF-THOUGHT PRE-PLANNING: Before outputting the final JSON, mentally identify all components, determine their position coordinates (x, y) on a clean grid layout so they do not overlap, establish boundaries, and map every connection (flow) with matching source/target IDs. Ensure source and target UUIDs in flows match the exact cell IDs of the connected elements.
5. DO NOT DISCONNECT THE GRAPH: You must never remove or disconnect data flows that link processes, actors, or stores, unless the user explicitly requests to delete or remove them. If you add new elements, they must be fully connected to the existing graph. Double-check that all source and target IDs in your flow cells correspond to existing, active node IDs.
6. STRICT ANTI-HALLUCINATION RULES:
   - Do NOT invent or assume any system components, databases, network boundaries, or technologies that are not explicitly stated in the provided architecture documentation or the user's refinement answers.

LANGUAGE REQUIREMENT:
You MUST conduct all diagram labeling, component names, and clarifying questions in Portuguese. All user-facing strings MUST be written in Portuguese.

The DFD model metadata is:
- Title: "${title || activeSession.title}"
- Description: "${description || activeSession.description || ''}"

Below is the provided system documentation:
${docsContext}
`;
        } else {
            promptText += `
INTEGRITY AND CONNECTIVITY MANDATORY RULES:
1. NO ISOLATED NODES: The system diagram must be a fully connected graph. For EVERY node (actor, process, store) created, you MUST create at least one connection flow (shape: "flow") that links it to other nodes in the system. Check the input architecture diagram and documentation, and trace the lines/arrows representing communication pathways into "flow" cells.
2. SYSTEM DECOMPOSITION: Do NOT group different backend services or microservices into a single generic node (such as "Microsserviços Internos" or "Backend Servers"). Each distinct service/pod shown in the architecture (e.g., Account Management, Transaction Processing, Card Services) MUST have its own dedicated "process" cell.
3. TRUST BOUNDARIES: You MUST draw trust boundaries ("trust-boundary-box" or "trust-boundary-curve" with zIndex: -1) to isolate different execution zones and network scopes (e.g., Public Internet, Kubernetes/AKS Cluster, Managed Cloud Databases).
4. CHAIN-OF-THOUGHT PRE-PLANNING: Before outputting the final JSON, mentally identify all components, determine their position coordinates (x, y) on a clean grid layout so they do not overlap, establish boundaries, and map every connection (flow) with matching source/target IDs. Ensure source and target UUIDs in flows match the exact cell IDs of the connected elements.
5. DO NOT DISCONNECT THE GRAPH: You must never remove or disconnect data flows that link processes, actors, or stores, unless the user explicitly requests to delete or remove them. If you add new elements, they must be fully connected to the existing graph. Double-check that all source and target IDs in your flow cells correspond to existing, active node IDs.
6. STRICT ANTI-HALLUCINATION RULES:
   - Do NOT invent or assume any system components, databases, network boundaries, or technologies that are not explicitly stated in the provided architecture documentation or the user's refinement answers.
   - Do NOT assume a security control is already implemented unless the user explicitly stated it is. If the user indicates a control is missing, absent, flat, or shared, you MUST reflect that vulnerability by keeping the threat status as "Open" and mapping appropriate threats, instead of hallucinating that the control is in place.
   - All threat scenarios must be realistic and directly tied to the technologies and protocols described in the documentation (e.g. if the system uses Azure SQL and AKS, do not model threats specific to AWS RDS or EC2).
7. STRICT ANTI-REDUNDANCY AND SEMANTIC DEDUPLICATION RULES:
   - You MUST review the list of existing threats mapped to each component in the "CURRENT THREAT MODEL".
   - Do NOT create a new threat if it covers the same basic risk or attack scenario as an existing threat on that element (e.g. do not create "Uso de credenciais estáticas sem rotação" if the element already has "Comprometimento por credenciais estáticas").
   - If you have new context or a different perspective on an existing threat, you MUST modify, merge, or append your thoughts directly into the existing threat's description or mitigation fields instead of creating a duplicate threat entry.

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
        }

        if (currentModel) {
            promptText += `\n\n--- CURRENT THREAT MODEL ---\nThis is the existing Threat Dragon V2 JSON model that you have generated in the previous round:\n${JSON.stringify(currentModel, null, 2)}\n`;
            promptText += `
CRITICAL INSTRUCTION FOR INCREMENTAL REFINEMENT:
- You MUST treat this "CURRENT THREAT MODEL" as your base state.
- Preserve the exact "id" values of existing diagram components (actors, processes, stores, flows) to maintain diagram topology and reference integrity.
- DO NOT CREATE DUPLICATE OR REDUNDANT COMPONENTS: Check the "CURRENT THREAT MODEL" and compare your proposed elements. If a component (e.g. "Account Mgmt", "Azure Key Vault", "Azure SQL") is already present in the diagram, you MUST reuse it. Do NOT create a duplicate node with a slightly different name (e.g. "Account MgmtSVC" when "Account Mgmt" exists, or "Key Vault" when "Azure Key Vault" exists). You may rename, move, resize, or alter the connections of existing nodes, but DO NOT create new nodes representing existing components. Focus purely on adding new nodes for architecture elements that are not yet mapped.
- Do NOT delete existing components, data flows, or threats unless they are directly contradicted or modified by the refinement conversation history.
- EVOLVE AND ENRICH THE DIAGRAM ACTIVELY: Your goal is to move the threat model to an ideal complete state. If the user indicates that the diagram is too simple or missing components (or if there are gaps identified in the "PREVIOUS AUDITOR CRITIQUE"), you MUST actively add the missing components, data flows, and trust boundaries described in the architecture documentation and the critique feedback. Place any new elements on the clean grid layout according to the GRID LAYOUT RULES (Tier 1-4 X-positions, varying Y-positions to avoid overlap) and connect them with flows.
- Merge any new components, data flows, or threats identified through the user responses into the existing model.
- If the user answer indicates that a security control is already implemented, update the corresponding threat's mitigation details and state in the threat model.
`;
        }

        if (activeSession && activeSession.evaluation) {
            const evalObj = activeSession.evaluation;
            promptText += `\n\n--- PREVIOUS AUDITOR CRITIQUE ---\nAn independent security auditor reviewed the current threat model draft and identified these gaps that you must address:\n"${evalObj.feedback || ''}"\n`;
            
            if (evalObj.criteria) {
                if (evalObj.criteria.missingElements && evalObj.criteria.missingElements.length > 0) {
                    promptText += `\nSPECIFIC MISSING DFD ELEMENTS TO ADD (Processes, Actors, Stores, Dataflows):\n${evalObj.criteria.missingElements.map((x) => `- ${x}`).join('\n')}\n`;
                }
                if (evalObj.criteria.missingBoundaries && evalObj.criteria.missingBoundaries.length > 0) {
                    promptText += `\nSPECIFIC MISSING TRUST BOUNDARIES TO ADD:\n${evalObj.criteria.missingBoundaries.map((x) => `- ${x}`).join('\n')}\n`;
                }
                if (evalObj.criteria.missingMetadata && evalObj.criteria.missingMetadata.length > 0) {
                    promptText += `\nSPECIFIC MISSING DESCRIPTIONS / METADATA TO ADD:\n${evalObj.criteria.missingMetadata.map((x) => `- ${x}`).join('\n')}\n`;
                }
            }
        }

        if (refinementHistory && refinementHistory.length > 0) {
            promptText += `\n\n--- REFINEMENT CONVERSATION HISTORY ---\nHere are the user answers to your previous clarifying questions, or general feedback. Update the threat model elements, data flows, and threats according to these answers:\n`;
            refinementHistory.forEach((msg) => {
                promptText += `${msg.role.toUpperCase()}: ${msg.text}\n`;
            });
        }

        promptText += `\n
GRID LAYOUT RULES FOR PREVENTING OVERLAPS:
You MUST position elements horizontally based on their logical tiers to avoid overlap:
- Tier 1 (Clients/Actors): Position at X = 100.
- Tier 2 (Ingress/API Gateways/Load Balancers): Position at X = 350.
- Tier 3 (Internal Microservices/Processing Processes): Position at X = 600.
- Tier 4 (Databases/Stores/Key Vaults): Position at X = 850.
- Vertical Spacing (Y coordinate): Vary the Y coordinate from Y = 100 to Y = 500, spacing elements within the same tier by at least 150 units (e.g. Y=100, Y=250, Y=400) to prevent boxes from rendering on top of each other.

Ensure elements are positioned on this clean grid layout and flows connect them correctly using IDs.

${jsonKeysInstruction}

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
- "id": A unique UUID string
- "title": String title of the threat
- "description": String description detailing the attack scenario
- "mitigation": String describing concrete and actionable mitigation
- "severity": One of: "Critical", "High", "Medium", "Low", "TBD"
- "score": A string representing the likelihood/impact risk score or level (e.g., "1", "2", "3", "4", "5", or "Medium")
- "status": One of: "Open", "Mitigated", "NA". Note: Every threat generated MUST have "status": "Open" by default. You MUST NOT mark a threat's status as "Mitigated" unless the user's refinement conversation history explicitly states that they have implemented the corresponding security control.
- "type": One of the STRIDE/F3 categories matching the element shape rules.
- "modelType": Exactly "STRIDE" or "MITRE_F3" (matching methodology).
- "number": A unique sequential integer`;

        let jsonOutputSchema = '';
        if (!dfdApprovedBool) {
            jsonOutputSchema = `{
  "threatModel": {
    "version": "2.0.0",
    "summary": {
      "title": "${title || (activeSession && activeSession.title) || ''}",
      "owner": "Security Team",
      "description": "${description || (activeSession && activeSession.description) || ''}",
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
    "Validation question string"
  ]
}`;
        } else {
            jsonOutputSchema = `{
  "questions": [
    {
      "id": "The exact Group ID from the ASSIGNED CONSOLIDATED QUESTION GROUPS list",
      "originalQuestionIds": [
        "Original Question ID 1",
        "Original Question ID 2"
      ],
      "category": "The exact Category",
      "text": "A single consolidated, technical, specific question in Portuguese addressing all elements in the group"
    }
  ],
  "resolvedQuestionIds": [
    "Question ID 1",
    "Question ID 2"
  ],
  "threatDeltas": [
    {
      "cellId": "The exact ID of the element/flow cell (e.g., process-api-gateway)",
      "threats": [
        {
          "id": "UUID or unique string (e.g., threat-xxxx)",
          "title": "Ameaça em Português",
          "type": "Spoofing",
          "description": "Descrição detalhada...",
          "mitigation": "Mitigação detalhada...",
          "status": "Open",
          "severity": "Medium",
          "score": 75,
          "modelType": "STRIDE",
          "number": 1
        }
      ]
    }
  ]
}`;
        }

        promptText += `\nDo not wrap the JSON output in markdown formatting. Follow this exact JSON output schema:\n${jsonOutputSchema}\n`;

        // Call 1: Generator Model
        logger.info(`[Job ${job.jobId}] [${agentName}] Sending request to AI Provider (${aiConfig.provider}) for generation`);
        
        job.progress = 35;
        activeJobs.set(job.jobId, { ...job });

        const responseText = await callAIModel(promptText, finalImages, getStageConfig('generator', aiConfig), job);

        if (!responseText) {
            throw new Error('AI API returned an empty response during generation');
        }

        let parsedOutput;
        try {
            parsedOutput = extractJson(responseText, finalMethodology);
            if (currentModel && parsedOutput && parsedOutput.threatModel) {
                parsedOutput.threatModel = mergeDiagramCells(currentModel, parsedOutput.threatModel, refinementHistory, dfdApprovedBool);
            }
        } catch (parseErr) {
            logger.error(`[Job ${job.jobId}] Failed to parse generator output as JSON. Output was: ${responseText}`);
            throw new Error('Failed to parse the generated output as valid JSON.');
        }

        job.status = 'critiquing';
        job.progress = 55;
        activeJobs.set(job.jobId, { ...job });

        // Call 2: Critic Model (Independent critique and completeness score evaluation)
        const getCritique = async (threatModel, questionsCount, isDfdApproved) => {
            const criticAgentName = !isDfdApproved ? 'DFDCriticAgent' : 'ThreatCriticAgent';
            let critiquePromptText = '';
            let outputRequirements = '';
            let missingElementsSchema = '';
            let missingBoundariesSchema = '';
            let missingMetadataSchema = '';

            if (!isDfdApproved) {
                critiquePromptText = `You are the DFDCriticAgent, an independent system architecture auditor and DFD quality critic. Your goal is to review the generated Threat Dragon V2 DFD topology against the system's architecture documentation, identify any missing elements, disconnected flows, hallucinated components, or layout issues, and compute a completeness evaluation score.

CURRENT REFINEMENT PHASE: DFD TOPOLOGY AUDIT (Phase 1)
- We are currently in Phase 1 (DFD Topology Refinement). The user has not approved the diagram yet.
- Focus your critique and score primarily on the coverage of components, actors, data flows, and trust boundaries. Do NOT penalize the model or lower the score because of empty 'threats' arrays, since threats are only generated in Phase 2.
- The "status" property MUST be "AwaitingHumanApproval" because Phase 1 requires manual DFD validation before threats can be analyzed.
`;
                outputRequirements = `
CRITICAL OUTPUT REQUIREMENTS FOR THE JSON SCHEMA:
- "missingElements": List any missing System Processes, External Actors, Data Stores, or Data Flows that should exist to accurately map the system's architecture.
- "missingBoundaries": List any missing trust boundaries that are required.
- "missingMetadata": List any elements or flows that are missing descriptive metadata (descriptions, out-of-scope flags, flow protocols, or data properties).
`;
                missingElementsSchema = `["Process X", "Actor Y", "Store Z", "Dataflow W"]`;
                missingBoundariesSchema = `["Boundary A", "Boundary B"]`;
                missingMetadataSchema = `["Description for Element C", "Protocol for Flow D"]`;
            } else {
                critiquePromptText = `You are the ThreatCriticAgent, an independent application security auditor and Threat Modeling critic. Your goal is to review the threats and mitigations mapped in the Threat Dragon V2 model, check if they conform to the STRIDE or MITRE methodologies, ensure the threat analysis covers all components/flows, and compute a completeness evaluation score.

CURRENT REFINEMENT PHASE: THREATS AND MITIGATIONS AUDIT (Phase 2)
- We are in Phase 2 (Threat Analysis & Security Controls). The DFD topology has been approved.
- You must critically evaluate the completeness of the threat mapping/analysis.
- Threat modeling completeness measures the thoroughness of the threat identification process, NOT the security posture.
- THREAT COVERAGE EVALUATION RULE: Review if each process, store, and flow has been evaluated for applicable threats.
- RISK STATUS VS COMPLETENESS RULE: The completenessScore and mitigationCompleteness MUST measure ONLY if the threats and their corresponding mitigations/actions have been identified and documented.
- CRITIQUE RIGOR AND COMPLETENESS SCORE RULE:
  - Do NOT give a high completenessScore (>80%) or mark status as "Ready" if the threat mapping is shallow.
  - Only mark the status as "Ready" and score >= 85% when the threat identification is genuinely complete, robust, and highly detailed.
- SEMANTIC REDUNDANCY AUDIT: Search for semantic duplicates or redundant threats mapped to the same element. If found, flag this as a critical duplication error.
`;
                outputRequirements = `
CRITICAL OUTPUT REQUIREMENTS FOR THE JSON SCHEMA:
- "missingElements": This MUST be an empty array [] since the DFD topology is already approved.
- "missingBoundaries": This MUST be an empty array [] since the DFD topology is already approved.
- "missingMetadata": This MUST be an empty array [] since the DFD topology is already approved.
`;
                missingElementsSchema = `[]`;
                missingBoundariesSchema = `[]`;
                missingMetadataSchema = `[]`;
            }

            let reviewCriteriaPrompt = '';
            if (!isDfdApproved) {
                reviewCriteriaPrompt = `
Specifically, evaluate:
1. Component Coverage: Are all system components, actors, and data flows from the documentation represented? Check if there are any isolated elements or hallucinated elements.
2. Layout and Structure: Verify that trust boundaries separate execution zones properly and coordinates are clean.
`;
            } else {
                reviewCriteriaPrompt = `
Specifically, evaluate:
1. Component Coverage: Verify that all elements (processes, stores, flows) have been assessed.
2. Threat Mapping Completeness: Have all identified threats been documented with detailed technical descriptions and suggested/planned mitigation actions?
3. Gaps and Genuineness: Are the threats realistic and are there any critical threat categories missing?
4. Security Control Documentation Efficacy: Analyze each answer/response provided by the user.
5. ANTI-HALLUCINATION AUDIT: Verify that the model does not assume a security control is active if the user stated it is missing.
`;
            }

            if (!isDfdApproved) {
                critiquePromptText += `
LANGUAGE REQUIREMENT:
You MUST write all evaluation texts, feedback/critique paragraphs, and assessment details in Portuguese.

${reviewCriteriaPrompt}

Here is the system architecture documentation:
${docsContext}

Here is the generated Threat Dragon V2 JSON DFD model to review:
${JSON.stringify(threatModel, null, 2)}
`;
            } else {
                const sessionAnswered = activeSession?.answeredQuestions || [];
                const realAnswers = sessionAnswered.filter((q) => q.id && !q.id.startsWith('manual-req-'));

                critiquePromptText += `
LANGUAGE REQUIREMENT:
You MUST write all evaluation texts, feedback/critique paragraphs, security control categories, and assessment details in Portuguese.

${reviewCriteriaPrompt}

Here is the system architecture documentation:
${docsContext}

Here is the generated Threat Dragon V2 JSON DFD model to review:
${JSON.stringify(threatModel, null, 2)}

--- USER'S SECURITY QUESTION ANSWERS ---
Here are the actual answers provided by the user for various elements and categories in this session:
${realAnswers.length > 0
  ? realAnswers.map((q) => `- Elemento: "${q.elementName}" | Categoria: "${q.category}"\n  Pergunta: ${q.text}\n  Resposta do Usuário: "${q.answer}"`).join('\n\n')
  : 'Nenhuma pergunta foi respondida pelo usuário ainda.'}

ANTI-HALLUCINATION / ONLY REAL ANSWERS RULE:
1. You MUST ONLY evaluate the security controls/categories for which the user has explicitly provided answers in the list above.
2. Under "userAnswer" in the "controlsAssessment" array, you MUST use the EXACT user response/answer from the list above. Do NOT invent, assume, or hallucinate any user answers.
3. If the user has not answered any questions yet (or if the list above is empty), the "controlsAssessment" array MUST be empty []. Do NOT generate or critique any hypothetical controls or hallucinated answers.
`;
            }

            critiquePromptText += `
${outputRequirements}

You MUST return ONLY a JSON object containing a single key "evaluation" structured exactly as below:
{
  "evaluation": {
    "completenessScore": integer (0 to 100),
    "criteria": {
      "elementCoverage": integer (0 to 100),
      "unresolvedQuestionsCount": integer (count of remaining gaps or unanswered clarifying questions),
      "mitigationCompleteness": integer (0 to 100),
      "missingElements": ${missingElementsSchema},
      "missingBoundaries": ${missingBoundariesSchema},
      "missingMetadata": ${missingMetadataSchema}
    },
    "status": "Ready" or "AwaitingHumanApproval",
    "feedback": "A detailed, constructive critique paragraph pointing out what is missing, what is good, and what can be improved in the threat model. Specifically detail any isolated nodes, hallucinated nodes, or excessive component groupings found.",
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

CRITICAL RULES FOR STATUS FIELD:
- The "status" property MUST be "AwaitingHumanApproval" unless the user has explicitly approved the diagram/model in the refinement conversation history.
- Once you see an explicit approval or consent in the conversation history, you can set the status to "Ready" (if the completenessScore is >= 80). Otherwise, it must remain "AwaitingHumanApproval" or "Refining".

Do not wrap the JSON output in markdown formatting.
`;

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
                const criticResponseText = await callAIModel(critiquePromptText, [], getStageConfig('critic', aiConfig), job);

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

        // Self-Correction Loop: If the critic score is low, perform one automatic correction round
        if (evaluation.completenessScore < 80) {
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
                const revResponseText = await callAIModel(revisionPromptText, finalImages, getStageConfig('revision', aiConfig), job);

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
                    parsedOutput.threatModel = mergeDiagramCells(currentModel, parsedOutput.threatModel, refinementHistory, dfdApprovedBool);
                    logger.info(`[Job ${job.jobId}] Successfully received revised threat model from self-correction loop. Re-evaluating revised model...`);
                    // Re-run the critic once on the revised model to get the updated evaluation score
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
                // Keep only assessments that correspond to a real user answer
                evaluation.controlsAssessment = evaluation.controlsAssessment.filter((assessment) => {
                    if (!assessment.userAnswer) { return false; }
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

        // Compute or update question plan on DFD approval transition
        let questionPlan = activeSession.questionPlan || null;
        const answeredQuestionIds = activeSession.answeredQuestionIds || [];

        if (dfdApprovedBool && parsedOutput.threatModel) {
            const diagramCells = parsedOutput.threatModel.detail?.diagrams?.[0]?.cells || [];
            if (!questionPlan) {
                // First time DFD is approved: compute the full question plan
                questionPlan = questionPlanningEngine.computeQuestionPlan(diagramCells, finalMethodology);
                logger.info(`[Job ${job.jobId}] Question plan computed: ${questionPlan.totalQuestions} questions for ${finalMethodology} across ${diagramCells.length} cells`);
            }

            // Extract what question groups were assigned to the LLM in this round to heal the returned ones
            if (questionPlan) {
                const previousAnsweredIds = activeSession.answeredQuestionIds || [];
                const currentQuestionIds = (activeSession.questions || []).map((q) => q.id || q);
                const combinedIds = Array.from(new Set([...previousAnsweredIds, ...currentQuestionIds]));
                const batchSize = getQuestionBatchSize(aiConfig);
                roundGroups = groupAndConsolidateQuestions(questionPlan, combinedIds, batchSize);
            }

            // Step 2: Decoupled Question Generator (Phase 2 only)
            if (roundGroups && roundGroups.length > 0) {
                const questionsPrompt = `You are the QuestionAgent, a technical security analyst assisting in threat modeling.
Your task is to formulate precise, technical, and concrete clarifying questions in Portuguese for each of the assigned question groups below.

ASSIGNED CONSOLIDATED QUESTION GROUPS:
${activeQuestionsPrompt}

CONTEXT:
Here is the current Threat Model:
${JSON.stringify(parsedOutput.threatModel, null, 2)}

REFINEMENT CONVERSATION HISTORY:
${refinementHistory.map((h) => `${h.role}: ${h.content}`).join('\n')}

For each group, formulate a single consolidated question in Portuguese targeting secure configuration details, deployment parameters, authentication practices, and specific network boundaries for that group.
You MUST return ONLY a JSON object with a single key "questions":
{
  "questions": [
    {
      "id": "The exact Group ID string from the assigned list",
      "originalQuestionIds": ["original-question-id-1", ...],
      "category": "The exact Category string from the assigned list",
      "text": "A single consolidated, technical, specific question in Portuguese addressing all the elements in the group for that category."
    }
  ]
}
Do not wrap the JSON output in markdown formatting.`;

                try {
                    logger.info(`[Job ${job.jobId}] [QuestionAgent] Sending request to AI Provider (${aiConfig.provider}) for decoupled question generation`);
                    // Call the Question Generator model without images
                    const questionsResponseText = await callAIModel(questionsPrompt, [], getStageConfig('generator', aiConfig), job);
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

            // Heal the returned questions using roundGroups
            parsedOutput.questions = healParsedConsolidatedQuestions(parsedOutput.questions, roundGroups);

            // Extract resolved question IDs from LLM response and map back to original question IDs
            if (parsedOutput.resolvedQuestionIds && Array.isArray(parsedOutput.resolvedQuestionIds)) {
                parsedOutput.resolvedQuestionIds.forEach((id) => {
                    if (id && typeof id === 'string') {
                        if (!answeredQuestionIds.includes(id)) {
                            answeredQuestionIds.push(id);
                        }
                        
                        // Map the group ID back to its original question IDs so the framework progress advances
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

            // Mark matched plan questions as answered
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

            // Recompute progress
            questionPlan.progress = questionPlanningEngine.computeProgress(questionPlan, answeredQuestionIds);
            if (questionPlan.progress && questionPlan.progress.byCategory) {
                questionPlan.byCategory = questionPlan.progress.byCategory;
            }

            if (questionPlan.progress && questionPlan.progress.answered >= questionPlan.progress.total && questionPlan.progress.total > 0) {
                threatModelApprovedBool = true;
                parsedOutput.questions = [];
            }
        }

        const isTransition = dfdApprovedBool && (!activeSession || !activeSession.dfdApproved);
        const historyToUse = isTransition ? [] : (refinementHistory || []);
        const updatedHistory = ensureModelMessageInHistory(historyToUse, parsedOutput.questions, dfdApprovedBool);

        aiContextStore.updateSession(activeSession.sessionId, {
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
    const aiConfig = {
        provider: provider,
        apiKey: clientApiKey || (activeSession && activeSession.apiKey) || (provider === 'bedrock-mantle' ? env.get().config.BEDROCK_MANTLE_API_KEY : env.get().config.GEMINI_API_KEY),
        baseUrl: customBaseUrl || (activeSession && activeSession.customBaseUrl) || env.get().config.BEDROCK_MANTLE_BASE_URL,
        model: customModel || (activeSession && activeSession.customModel) || env.get().config.BEDROCK_MANTLE_MODEL,
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
substr(2, 5)}`;
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

                // Update history and model in session store
                activeSession = aiContextStore.updateSession(sessionId, {
                    answeredQuestions: sessionAnswered,
                    answeredQuestionIds: answeredQuestionIds,
                    refinementHistory: rebuiltHistory,
                    currentModel: currentModel || null,
                    questionPlan: questionPlan,
                    aiProvider: provider,
                    customBaseUrl: aiConfig.baseUrl,
                    customModel: aiConfig.model,
                    apiKey: aiConfig.apiKey,
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
                });
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

            aiContextStore.updateSession(activeSession.sessionId, {
                history: previousHistory,
                threatModelApproved: true
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
            activeSession = aiContextStore.createSession({
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
                apiKey: aiConfig.apiKey || '',
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
            sessionId: session.sessionId,
            title: session.title,
            description: session.description,
            methodology: session.methodology || 'STRIDE',
            aiProvider: session.aiProvider || 'gemini',
            customBaseUrl: session.customBaseUrl || '',
            customModel: session.customModel || '',
            apiKey: session.apiKey || '',
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

const undoRefinement = (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({
            status: 400,
            message: 'Session ID is required to undo.'
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
        const updated = aiContextStore.updateSession(sessionId, {
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
        const activeSession = aiContextStore.updateSession(sessionId, {
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
            apiKey: activeSession.apiKey || (activeSession.aiProvider === 'bedrock-mantle' ? env.get().config.BEDROCK_MANTLE_API_KEY : env.get().config.GEMINI_API_KEY),
            baseUrl: activeSession.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: activeSession.customModel || env.get().config.BEDROCK_MANTLE_MODEL,
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

const runDeduplicateJob = async (job, body, session) => {
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
        const baseModel = customModel || session.customModel || env.get().config.BEDROCK_MANTLE_MODEL;
        const baseExtendedThinking = body.extendedThinking !== undefined ? (body.extendedThinking === true || body.extendedThinking === 'true') : (session.extendedThinking === true || session.extendedThinking === 'true');

        const aiConfig = {
            provider: provider,
            apiKey: clientApiKey || session.apiKey || (provider === 'bedrock-mantle' ? env.get().config.BEDROCK_MANTLE_API_KEY : env.get().config.GEMINI_API_KEY),
            baseUrl: customBaseUrl || session.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
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
        const controlsAssessment = session.evaluation?.controlsAssessment || [];

        // Build docsContext using the same logic as runGenerateJob
        const docs = session.docs || [];
        let docsContext = '';
        if (docs && docs.length > 0) {
            const fullDocText = docs.map((d) => `--- DOCUMENT: ${d.name} ---\n${d.content}`).join('\n\n');
            const maxChars = getMaxContextChars(aiConfig);
            if (fullDocText.length > maxChars) {
                docsContext = fullDocText.slice(0, maxChars) + '\n... [Conteúdo restante omitido por limite de contexto] ...\n';
            } else {
                docsContext = fullDocText;
            }
        } else {
            docsContext = '\nNo documentation files provided.\n';
        }

        // Build historyContext
        const refinementHistory = session.refinementHistory || [];
        let historyContext = '';
        if (refinementHistory && refinementHistory.length > 0) {
            refinementHistory.forEach((msg) => {
                historyContext += `${msg.role.toUpperCase()}: ${msg.text}\n`;
            });
        } else {
            historyContext = '\nNo refinement conversation history.\n';
        }

        const promptText = `
You are a Security Model Auditing and Refinement Expert. Your task is to analyze the following threat model, its security controls assessment report, the original system architecture documentation, and the conversation history of user answers.

Here is the current Threat Dragon V2 model (JSON):
${JSON.stringify(currentModel, null, 2)}

Here is the current Security Control Efficacy Report (JSON):
${JSON.stringify(controlsAssessment, null, 2)}

Here is the system architecture documentation:
${docsContext}

Here is the conversation history of user answers and feedback:
${historyContext}

Please perform the following four analyses:

1. SECURITY CONTROL DEDUPLICATION:
Find any controls in the Security Control Efficacy Report that cover the same category or target the same core security issue. Group them. If they can be unified, provide a single "proposedMergedItem" where "userAnswer" combines all key points from the merged items' userAnswers, and "details" merges all recommendations. Do NOT merge controls that address different issues.

2. THREAT DEDUPLICATION:
Check the threats listed inside the data.threats array of each DFD element (process, store, actor, flow) in the threat model. Identify threats that represent the same technical attack vector, cause, or risk on that specific component. Group them. If they can be unified, provide a "proposedMergedThreat" that combines their title, description, and mitigation details into a single high-quality threat. Ensure you preserve original threat properties like severity, status (must remain "Open"), type, and modelType.

3. ANTI-HALLUCINATION AUDIT (INCLUDING SECURITY CONTROLS AND EFFICACY):
Compare the threat model components, trust boundaries, data flows, technologies, and security controls against the system architecture documentation and the user's conversation answers.
- Audit if any security control has been hallucinated (i.e., the model assumes a control exists, is active, or is effective when it is not supported by the documentation or is contradicted by user answers).
- Audit whether the discussed security controls are actually effective or if their effectiveness is hallucinated/overstated, explaining clearly "why" (the rationale).
- Identify any element, technology, protocol, or trust boundary that has been hallucinated by the model (i.e. it is NOT mentioned anywhere in the documentation and was NOT confirmed by the user in the answers).
- For each discrepancy, hallucinated control, or overstated efficacy found, generate a detailed hallucination alert.

4. THREAT MITIGATION STATUS EVALUATION:
For EVERY threat mapped to every element/flow in the threat model, evaluate whether it is mitigated based on its current description/mitigation field and the user answers.
Classify each threat's mitigation status into one of:
- "Mitigada" (if a complete, confirmed technical mitigation exists or has been verified by user answers).
- "Parcialmente Mitigada" (if there is a partial mitigation, but some aspects are missing or require improvement).
- "Não Mitigada" (if no mitigation exists, or the user answers explicitly state that the mitigation/control is missing or not implemented).
Provide a detailed technical reason for the classification, and technical recommendations to achieve full mitigation.

Return a JSON object structured EXACTLY as follows:
{
  "controlDeduplications": [
    {
      "id": "control-dup-1",
      "controlCategory": "e.g. Segregação de Rede",
      "itemsToMerge": [
        {
          "userAnswer": "...",
          "assessment": "...",
          "details": "..."
        }
      ],
      "proposedMergedItem": {
        "userAnswer": "...",
        "securityControl": "...",
        "assessment": "...",
        "details": "..."
      }
    }
  ],
  "threatDeduplications": [
    {
      "id": "threat-dup-1",
      "cellId": "...",
      "cellName": "...",
      "itemsToMerge": [
        {
          "id": "...",
          "title": "...",
          "description": "...",
          "mitigation": "..."
        }
      ],
      "proposedMergedThreat": {
        "title": "...",
        "description": "...",
        "mitigation": "...",
        "severity": "...",
        "status": "Open",
        "type": "...",
        "modelType": "..."
      }
    }
  ],
  "hallucinationAlerts": [
    {
      "id": "string (unique identifier like hall-1)",
      "targetType": "Component" or "Data Flow" or "Security Control" or "Threat",
      "targetName": "string (name of the element, flow, or control)",
      "issue": "string (clear explanation in Portuguese of the hallucinated detail or discrepancy. If it targets a Security Control, explain if the control is effective and why)",
      "severity": "High" or "Medium" or "Low"
    }
  ],
  "mitigationStatus": [
    {
      "threatId": "string (the threat id from the model)",
      "threatTitle": "string",
      "elementName": "string (the name of the element/flow containing this threat)",
      "status": "Mitigada" or "Parcialmente Mitigada" or "Não Mitigada",
      "reason": "string (detailed justification in Portuguese based on user responses and mitigation field)",
      "recommendations": "string (technical recommendations in Portuguese on how to fully mitigate this threat)"
    }
  ]
}

LANGUAGE REQUIREMENT:
All proposed titles, userAnswers, descriptions, mitigations, details, issues, reasons, and recommendations MUST be written in Portuguese.

Return ONLY the raw JSON object, without any markdown code block formatting.
`;

        logger.info(`[Job ${job.jobId}] Requesting deduplication and audit proposals from AI Provider (${aiConfig.provider})`);
        
        job.progress = 50;
        activeJobs.set(job.jobId, { ...job });

        const candidateText = await callAIModel(promptText, [], aiConfig, job);
        
        if (!candidateText) {
            throw new Error('AI API returned an empty response for deduplication and audit proposals');
        }

        const parsedProposals = extractJson(candidateText);

        if (!parsedProposals.controlDeduplications) {parsedProposals.controlDeduplications = [];}
        if (!parsedProposals.threatDeduplications) {parsedProposals.threatDeduplications = [];}
        if (!parsedProposals.hallucinationAlerts) {parsedProposals.hallucinationAlerts = [];}
        if (!parsedProposals.mitigationStatus) {parsedProposals.mitigationStatus = [];}
        
        // Cache the proposals in the session context
        session.deduplicateProposals = parsedProposals;
        session.hallucinationAlerts = parsedProposals.hallucinationAlerts;
        session.mitigationStatus = parsedProposals.mitigationStatus;

        aiContextStore.updateSession(session.sessionId, {
            deduplicateProposals: parsedProposals,
            hallucinationAlerts: parsedProposals.hallucinationAlerts,
            mitigationStatus: parsedProposals.mitigationStatus
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

const applyDeduplication = (req, res) => {
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
            mitigationStatus: session.mitigationStatus || []
        } : null;

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

        aiContextStore.updateSession(sessionId, {
            currentModel: updatedModel,
            evaluation: updatedEvaluation,
            threatModelApproved: true,
            deduplicateProposals: null, // Clear proposals cache
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

const updateSessionState = (req, res) => {
    const { sessionId } = req.params;
    const { currentModel } = req.body;
    const session = aiContextStore.getSession(sessionId);
    if (!session) {
        return res.status(404).json({
            status: 404,
            message: 'Session not found'
        });
    }
    aiContextStore.updateSession(sessionId, {
        currentModel: currentModel || session.currentModel
    });
    logger.info(`Updated current model in session ${sessionId} with user manual edits.`);
    return res.status(200).json({
        status: 200,
        message: 'Session model updated successfully'
    });
};

// ─── Export Questions Endpoint ────────────────────────────────────────────────
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
            apiKey: session.apiKey || (provider === 'bedrock-mantle' ? env.get().config.BEDROCK_MANTLE_API_KEY : env.get().config.GEMINI_API_KEY),
            baseUrl: session.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: session.customModel || env.get().config.BEDROCK_MANTLE_MODEL,
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
                            } else {
                                q.questionText = `[${q.category}] Avalie o componente "${q.elementName}" em relação à categoria "${q.category}".`;
                            }
                        }
                    });

                    // Update question texts in the session's question plan
                    const updatedElementQuestions = questionPlan.elementQuestions.map((elem) => {
                        return {
                            ...elem,
                            categories: elem.categories.map((cat) => {
                                return {
                                    ...cat,
                                    questions: cat.questions.map((q) => {
                                        const matched = allQuestions.find((aq) => aq.id === q.id);
                                        return {
                                            ...q,
                                            questionText: (matched && matched.questionText) ? matched.questionText : q.questionText
                                        };
                                    })
                                };
                            })
                        };
                    });

                    const updatedQuestionPlan = {
                        ...questionPlan,
                        elementQuestions: updatedElementQuestions
                    };

                    aiContextStore.updateSession(sessionId, {
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

// ─── Import Answers Endpoint ─────────────────────────────────────────────────
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

        // Build set of valid question IDs from the plan
        const validIds = new Set();
        questionPlan.elementQuestions.forEach((elem) => {
            elem.categories.forEach((catGroup) => {
                catGroup.questions.forEach((q) => {
                    validIds.add(q.id);
                });
            });
        });
        // Also add global question IDs
        (questionPlan.globalQuestions || []).forEach((_gq, idx) => {
            validIds.add(`global-q-${idx}`);
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

            if (!validIds.has(item.id)) {
                logger.warn(`[importAnswers] Skipping unknown question ID: ${item.id}`);
                skippedCount++;
                return;
            }

            if (existingIds.has(item.id)) {
                // Update existing answer
                const existing = sessionAnswered.find((q) => q.id === item.id);
                if (existing) {
                    existing.answer = item.answer.trim();
                    existing.timestamp = new Date().toISOString();
                    existing.source = item.source || 'csv_import';
                }
            } else {
                sessionAnswered.push({
                    id: item.id,
                    text: item.questionText || item.text || '',
                    answer: item.answer.trim(),
                    elementId: item.elementId || 'global',
                    elementName: item.elementName || 'Sistema',
                    category: item.category || 'Importado',
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
        const updatedSession = aiContextStore.updateSession(sessionId, {
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
            apiKey: session.apiKey || (provider === 'bedrock-mantle' ? env.get().config.BEDROCK_MANTLE_API_KEY : env.get().config.GEMINI_API_KEY),
            baseUrl: session.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: session.customModel || env.get().config.BEDROCK_MANTLE_MODEL,
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

// ─── Apply Requirements Endpoint ─────────────────────────────────────────────
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
            apiKey: session.apiKey || (provider === 'bedrock-mantle' ? env.get().config.BEDROCK_MANTLE_API_KEY : env.get().config.GEMINI_API_KEY),
            baseUrl: session.customBaseUrl || env.get().config.BEDROCK_MANTLE_BASE_URL,
            model: session.customModel || env.get().config.BEDROCK_MANTLE_MODEL,
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
                        /* eslint-disable-next-line no-await-in-loop */
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

                aiContextStore.updateSession(sessionId, {
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
    _areTitlesSimilar: areTitlesSimilar,
    _mergeDiagramCells: mergeDiagramCells,
    _mergeControlsAssessment: mergeControlsAssessment,
    _applyDeduplicationChanges: applyDeduplicationChanges,
    _extractJson: extractJson,
    _callAIModel: callAIModel,
    _clientFactory: clientFactory,
    _getMaxContextChars: getMaxContextChars,
    _getQuestionBatchSize: getQuestionBatchSize
};
