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

// Polyfill DOMMatrix for pdfjs-dist used by pdf-parse
global.DOMMatrix = DOMMatrix;

const logger = loggerHelper.get('controllers/aiController.js');
const REQUEST_TIMEOUT = parseInt(process.env.AI_REQUEST_TIMEOUT, 10) || 300000;

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

const cleanJson = (str) => {
    let clean = str.trim();
    clean = clean.replace(/^```json/iu, '').replace(/```$/u, '').
trim();
    clean = clean.replace(/\/\*[\s\S]*?\*\//gu, '');
    clean = clean.replace(/(?<prefix>^|[^:])\/\/.*$/gmu, '$<prefix>');
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

const extractJson = (str) => {
    const parsed = _rawExtractJson(str);
    if (parsed && parsed.threatModel && parsed.threatModel.detail && parsed.threatModel.detail.diagrams && parsed.threatModel.detail.diagrams[0]) {
        parsed.threatModel.detail.diagrams[0].cells = healDiagramCells(parsed.threatModel.detail.diagrams[0].cells);
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
        return new OpenAI({
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseUrl
        });
    }
};


const callAIModel = async (promptText, images, aiConfig, job = null) => {
    if (job) {
        job.streamText = '';
        activeJobs.set(job.jobId, { ...job });
    }
    try {
        if (aiConfig.provider === 'bedrock-mantle') {
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
            logger.info(`[callAIModel] Bedrock Mantle sending chat completion request via OpenAI SDK to base URL: ${aiConfig.baseUrl}`);

            const requestPayload = {
                model: aiConfig.model || 'meta.llama3-70b-instruct-v1:0',
                messages: messages,
                max_tokens: 16384
            };

            if (aiConfig.extendedThinking) {
                requestPayload.thinking = {
                    type: 'enabled',
                    budget_tokens: 2048
                };
                requestPayload.reasoning_effort = 'medium';
            }

            try {
                const response = await openai.chat.completions.create(
                    requestPayload,
                    {
                        timeout: REQUEST_TIMEOUT
                    }
                );

                logger.info(`[callAIModel] Bedrock Mantle response received via OpenAI SDK.`);
                return response.choices?.[0]?.message?.content || '';
            } catch (err) {
                if (err.name === 'APITimeoutError' || err.name === 'APIConnectionTimeoutError' || err.message?.toLowerCase().includes('timeout') || err.code === 'ETIMEDOUT') {
                    logger.warn(`[callAIModel] Bedrock Mantle request timed out. Attempting to recover response from stored state...`);
                    try {
                        const listUrl = `${aiConfig.baseUrl}/responses`;
                        const listResponse = await axios.get(listUrl, {
                            headers: {
                                'Authorization': `Bearer ${aiConfig.apiKey}`,
                                'Content-Type': 'application/json'
                            },
                            params: {
                                limit: 5
                            },
                            timeout: 10000
                        });
                        
                        if (listResponse.data && listResponse.data.data && listResponse.data.data.length > 0) {
                            const matchingResponse = listResponse.data.data.find(r => {
                                const serialized = JSON.stringify(r);
                                return serialized.includes(promptText.slice(0, 200));
                            });
                            
                            if (matchingResponse) {
                                let targetResponse = matchingResponse;
                                
                                if (targetResponse.status === 'in_progress' || targetResponse.status === 'pending') {
                                    logger.info(`[callAIModel] Found matching response ${targetResponse.id} with status ${targetResponse.status}. Polling for completion...`);
                                    const retrieveUrl = `${aiConfig.baseUrl}/responses/${targetResponse.id}`;
                                    
                                    for (let attempt = 1; attempt <= 20; attempt++) {
                                        /* eslint-disable-next-line no-await-in-loop */
                                        await new Promise(resolve => setTimeout(resolve, 5000));
                                        
                                        try {
                                            /* eslint-disable-next-line no-await-in-loop */
                                            const pollResponse = await axios.get(retrieveUrl, {
                                                headers: {
                                                    'Authorization': `Bearer ${aiConfig.apiKey}`,
                                                    'Content-Type': 'application/json'
                                                },
                                                timeout: 5000
                                            });
                                            if (pollResponse.data) {
                                                targetResponse = pollResponse.data;
                                                logger.info(`[callAIModel] Polling attempt ${attempt}: status is ${targetResponse.status}`);
                                                if (targetResponse.status === 'completed') {
                                                    break;
                                                }
                                                if (targetResponse.status === 'failed') {
                                                    break;
                                                }
                                            }
                                        } catch (pollErr) {
                                            logger.error(`[callAIModel] Polling attempt ${attempt} failed: ${pollErr.message}`);
                                        }
                                    }
                                }
                                
                                if (targetResponse.status === 'completed') {
                                    logger.info(`[callAIModel] Successfully recovered timed-out response from Bedrock Mantle. Response ID: ${targetResponse.id}`);
                                    const content = targetResponse.output?.choices?.[0]?.message?.content || 
                                                    targetResponse.output?.output_text || 
                                                    targetResponse.output || '';
                                    if (content) {
                                        return content;
                                    }
                                } else {
                                    logger.warn(`[callAIModel] Recovered response ${targetResponse.id} status is ${targetResponse.status}, not completed.`);
                                }
                            } else {
                                logger.warn(`[callAIModel] No matching response found in the recent list for the current prompt.`);
                            }
                        }
                    } catch (recoverErr) {
                        logger.error(`[callAIModel] Failed to recover response from Bedrock Mantle stored state: ${recoverErr.message}`);
                    }
                }
                throw err;
            }
        } 
        
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
        logger.info(`[callAIModel] Gemini sending POST request to API. Payload size: ${JSON.stringify(payload).length} characters`);

        const response = await axios.post(
            url,
            payload,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: REQUEST_TIMEOUT
            }
        );

        logger.info(`[callAIModel] Gemini response status: ${response.status}`);
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    } catch (err) {
        logger.error(`[callAIModel] HTTP/API Request Failed: ${err.message}`);
        if (err.response) {
            logger.error(`[callAIModel] Error Response Status: ${err.response.status}`);
            try {
                logger.error(`[callAIModel] Error Response Headers: ${JSON.stringify(err.response.headers)}`);
            } catch (e) {
                logger.error(`[callAIModel] Error Response Headers: [Could not serialize]`);
            }
            try {
                // err.response.data may be a stream (circular) when responseType is 'stream'
                const data = typeof err.response.data === 'object' && typeof err.response.data?.on === 'function'
                    ? '[Stream - not serializable]'
                    : JSON.stringify(err.response.data);
                logger.error(`[callAIModel] Error Response Data: ${data}`);
            } catch (e) {
                logger.error(`[callAIModel] Error Response Data: [Could not serialize]`);
            }
        } else if (err.request) {
            // err.request is an http.ClientRequest with circular references (socket -> parser -> socket)
            logger.error(`[callAIModel] Request was sent but no response was received (possible timeout or network error).`);
        }
        throw err;
    }
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

const runGenerateJob = async (job, body, activeSession, finalDocs, finalImages, finalMethodology, dfdApprovedBool, aiConfig) => {
    try {
        const {
            title,
            description,
            currentModel,
            refinementHistory,
            threatModelApproved
        } = body;

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

        if (docsTexts.length > 0 && (!activeSession || !activeSession.embeddingsGenerated)) {
            // Stage 1: Local RAG Chunking and Embedding Generation
            await generateAndSaveEmbeddings(activeSession.sessionId, docsTexts, aiConfig);
            aiContextStore.updateSession(activeSession.sessionId, { embeddingsGenerated: true });
        }

        job.progress = 25;
        activeJobs.set(job.jobId, { ...job });

        // Process / Retrieve context from RAG
        let docsContext = '';
        if (docsTexts.length > 0) {
            const fullDocText = docsTexts.map((d) => d.text).join('');
            if (fullDocText.length <= 15000) {
                logger.info(`Documentation length (${fullDocText.length} chars) is within limits. Sending full documentation.`);
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
You must perform Threat Modeling focusing on the MITRE Fight Fraud Framework (F3).
Strictly map threats to elements using these MITRE F3 tactics:
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
1. "threatModel": The valid Threat Dragon V2 JSON object containing the summary and detail (diagrams, cells, and threats).
2. "questions": ${questionsInstruction}`;
        } else {
            // Get the next batch of planned questions from the plan
            let activeQuestionsPrompt = '';
            if (activeSession && activeSession.questionPlan) {
                const answeredIds = activeSession.answeredQuestionIds || [];
                const currentQuestionIds = (activeSession.questions || []).map((q) => q.id || q);
                const combinedIds = Array.from(new Set([...answeredIds, ...currentQuestionIds]));
                const batchSize = 3;
                const { questions: roundQuestions } = questionPlanningEngine.getQuestionsByRound(
                    activeSession.questionPlan,
                    1,
                    combinedIds,
                    batchSize
                );
                
                if (roundQuestions && roundQuestions.length > 0) {
                    activeQuestionsPrompt = '\n--- ASSIGNED QUESTIONS FOR THIS ROUND ---\n';
                    activeQuestionsPrompt += 'You MUST generate exactly the following questions for the elements and categories below. Do NOT generate questions for other categories or elements. Write a specific, technical, direct question in Portuguese for each assigned category:\n';
                    roundQuestions.forEach((q) => {
                        activeQuestionsPrompt += `- Question ID: "${q.id}" | Element ID: "${q.elementId}" | Element Name: "${q.elementName}" | Category: "${q.category}" | Type: "${q.type}"\n`;
                    });
                    activeQuestionsPrompt += '\n';
                }
            }

            questionsInstruction = `An array of objects matching the ASSIGNED QUESTIONS FOR THIS ROUND list. Each object MUST have:
- "id": The exact "Question ID" string from the assigned list.
- "elementId": The exact "Element ID" string.
- "category": The exact "Category" string.
- "text": A technical, specific question in Portuguese related to the assigned element and category.

If no questions are assigned, return an empty array [].`;

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
- Your clarifying questions in the "questions" array MUST target discovering new threats or gathering necessary context to refine and evaluate existing threats (assessing severity, score, description, and mitigations).
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
1. "threatModel": The valid Threat Dragon V2 JSON object containing the summary and detail.
   - IMPORTANT SCHEMA OPTIMIZATION FOR PHASE 2 (dfdApproved is true): To maximize your output token limit for rich, detailed, and comprehensive threat descriptions and mitigations, you MUST NOT return all cells in the "cells" array. Instead, ONLY include the cell objects under "threatModel.detail.diagrams[0].cells" that have new, updated, or modified threats. Completely omit any cell that has no changes.
2. "questions": ${questionsInstruction}
3. "resolvedQuestionIds": An array of strings containing the Question IDs (from the previous round) that have been successfully answered/mitigated by the user.

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
    {
      "id": "The exact Question ID from the ASSIGNED QUESTIONS FOR THIS ROUND list",
      "elementId": "The exact Element ID",
      "category": "The exact Category",
      "text": "A technical, specific question in Portuguese related to the assigned element and category"
    }
  ],
  "resolvedQuestionIds": [
    "Question ID 1",
    "Question ID 2"
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
            parsedOutput = extractJson(responseText);
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
                critiquePromptText += `
LANGUAGE REQUIREMENT:
You MUST write all evaluation texts, feedback/critique paragraphs, security control categories, and assessment details in Portuguese.

${reviewCriteriaPrompt}

Here is the system architecture documentation:
${docsContext}

Here is the generated Threat Dragon V2 JSON DFD model to review:
${JSON.stringify(threatModel, null, 2)}
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

Return ONLY a JSON object containing the keys "threatModel" and "questions" (as specified in the original instructions). Do not wrap the JSON output in markdown formatting.
`;

            try {
                const revResponseText = await callAIModel(revisionPromptText, finalImages, getStageConfig('revision', aiConfig), job);

                const parsedRevision = revResponseText ? extractJson(revResponseText) : null;
                if (parsedRevision && parsedRevision.threatModel) {
                    parsedOutput = parsedRevision;
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

            // Extract resolved question IDs from LLM response
            if (parsedOutput.resolvedQuestionIds && Array.isArray(parsedOutput.resolvedQuestionIds)) {
                parsedOutput.resolvedQuestionIds.forEach((id) => {
                    if (id && typeof id === 'string' && !answeredQuestionIds.includes(id)) {
                        answeredQuestionIds.push(id);
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
        logger.error(`[Job ${job.jobId}] Background generation job failed: ${err.message}`);
        job.status = 'failed';
        job.progress = 100;
        job.error = err.message;
        activeJobs.set(job.jobId, { ...job });
    }
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
        deduplicatorExtendedThinking
    } = req.body;

    logger.info(`[AI Generate Request] Incoming payload: ${JSON.stringify({
        title,
        description,
        docsCount: docs ? docs.length : 0,
        imagesCount: images ? images.length : 0,
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
        extendedThinking: extendedThinkingVal
    };

    logger.info(`[AI Generate Request] Resolved aiConfig: ${JSON.stringify({
        provider: aiConfig.provider,
        baseUrl: aiConfig.baseUrl,
        model: aiConfig.model,
        embeddingModel: aiConfig.embeddingModel,
        extendedThinking: aiConfig.extendedThinking,
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
                
                // Update history and model in session store
                aiContextStore.updateSession(sessionId, {
                    refinementHistory: refinementHistory || [],
                    currentModel: currentModel || null,
                    aiProvider: provider,
                    customBaseUrl: aiConfig.baseUrl,
                    customModel: aiConfig.model,
                    apiKey: aiConfig.apiKey,
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

        const promptText = `
You are a Security Model Refinement Expert. Your task is to analyze the following threat model and its security controls assessment report, identify any redundant or duplicate elements, and propose high-quality merges to simplify the model WITHOUT losing any important technical context or user feedback details.

Here is the current Threat Dragon V2 model (JSON):
${JSON.stringify(currentModel, null, 2)}

Here is the current Security Control Efficacy Report (JSON):
${JSON.stringify(controlsAssessment, null, 2)}

Please perform the following two analyses:
1. SECURITY CONTROL DEDUPLICATION:
Find any controls in the Security Control Efficacy Report that cover the same category or target the same core security issue. Group them. If they can be unified, provide a single "proposedMergedItem" where "userAnswer" combines all key points from the merged items' userAnswers, and "details" merges all recommendations. Do NOT merge controls that address different issues.
2. THREAT DEDUPLICATION:
Check the threats listed inside the data.threats array of each DFD element (process, store, actor, flow) in the threat model. Identify threats that represent the same technical attack vector, cause, or risk on that specific component. Group them. If they can be unified, provide a "proposedMergedThreat" that combines their title, description, and mitigation details into a single high-quality threat. Ensure you preserve original threat properties like severity, status (must remain "Open"), type, and modelType.

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
  ]
}

LANGUAGE REQUIREMENT:
All proposed titles, userAnswers, descriptions, mitigations, and details MUST be written in Portuguese.

Return ONLY the raw JSON object, without any markdown code block formatting.
`;

        logger.info(`[Job ${job.jobId}] Requesting deduplication proposals from AI Provider (${aiConfig.provider})`);
        
        job.progress = 50;
        activeJobs.set(job.jobId, { ...job });

        const candidateText = await callAIModel(promptText, [], aiConfig, job);
        
        if (!candidateText) {
            throw new Error('AI API returned an empty response for deduplication proposals');
        }

        const parsedProposals = extractJson(candidateText);
        
        // Cache the proposals in the session context
        session.deduplicateProposals = parsedProposals;
        aiContextStore.updateSession(session.sessionId, { deduplicateProposals: parsedProposals });

        job.status = 'completed';
        job.progress = 100;
        job.result = parsedProposals;
        activeJobs.set(job.jobId, { ...job });

    } catch (err) {
        logger.error(`[Job ${job.jobId}] Background deduplication job failed: ${err.message}`);
        job.status = 'failed';
        job.progress = 100;
        job.error = err.message;
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

        // Update the session's evaluation object with the new controlsAssessment list
        const updatedEvaluation = session.evaluation ? {
            ...session.evaluation,
            controlsAssessment: updatedControls
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

export default {
    generate,
    getSessionState,
    updateSessionState,
    undoRefinement,
    getDeduplicateProposals,
    applyDeduplication,
    getQuestionCount,
    computeQuestionCountStateless,
    getAvailableFrameworks,
    getJobStatus,
    _areTitlesSimilar: areTitlesSimilar,
    _mergeDiagramCells: mergeDiagramCells,
    _mergeControlsAssessment: mergeControlsAssessment,
    _applyDeduplicationChanges: applyDeduplicationChanges,
    _extractJson: extractJson,
    _callAIModel: callAIModel,
    _clientFactory: clientFactory
};
