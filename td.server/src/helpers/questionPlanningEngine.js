/* eslint-disable max-lines-per-function, max-lines */
import crypto from 'crypto';
import loggerHelper from './logger.helper.js';

const logger = loggerHelper.get('helpers/questionPlanningEngine.js');

// ─── Framework Definitions ───────────────────────────────────────────────────
// Each framework maps element shapes to applicable threat categories.
// questionsPerPair = number of questions generated per (element, category) pair.

const FRAMEWORK_DEFINITIONS = {
    STRIDE: {
        name: 'STRIDE',
        description: 'Standard cybersecurity threat modeling (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)',
        categories: ['Spoofing', 'Tampering', 'Repudiation', 'Information disclosure', 'Denial of service', 'Elevation of privilege'],
        elementMapping: {
            actor:   ['Spoofing', 'Repudiation'],
            process: ['Spoofing', 'Tampering', 'Repudiation', 'Information disclosure', 'Denial of service', 'Elevation of privilege'],
            store:   ['Tampering', 'Information disclosure', 'Denial of service'],
            flow:    ['Tampering', 'Information disclosure', 'Denial of service']
        },
        questionsPerPair: 1, // consolidated single question per category
        boundaryQuestionsEach: 1, // reduced from 2 to 1
        globalQuestions: [
            'Qual é a política de logging e auditoria implementada no sistema?',
            'Quais regulamentos de compliance (LGPD, PCI-DSS, SOC2) se aplicam a este sistema?',
            'Existe um plano de resposta a incidentes de segurança documentado?'
        ]
    },
    LINDDUN: {
        name: 'LINDDUN',
        description: 'Privacy-focused threat modeling (Linkability, Identifiability, Non-repudiation, Detectability, Disclosure, Unawareness, Non-compliance)',
        categories: ['Linkability', 'Identifiability', 'Non-repudiation', 'Detectability', 'Disclosure of information', 'Unawareness', 'Non-compliance'],
        elementMapping: {
            actor:   ['Linkability', 'Identifiability', 'Unawareness', 'Non-compliance'],
            process: ['Linkability', 'Identifiability', 'Non-repudiation', 'Detectability', 'Disclosure of information', 'Unawareness', 'Non-compliance'],
            store:   ['Linkability', 'Identifiability', 'Detectability', 'Disclosure of information', 'Non-compliance'],
            flow:    ['Linkability', 'Identifiability', 'Detectability', 'Disclosure of information']
        },
        questionsPerPair: 1,
        boundaryQuestionsEach: 1,
        globalQuestions: [
            'Foi realizada uma Avaliação de Impacto à Proteção de Dados (DPIA) para este sistema?',
            'Como é obtido e gerido o consentimento dos titulares dos dados?',
            'Qual é a política de retenção e eliminação de dados pessoais?',
            'Como são garantidos os direitos dos titulares (acesso, retificação, eliminação) conforme LGPD/GDPR?'
        ]
    },
    CIA: {
        name: 'CIA',
        description: 'Confidentiality, Integrity, Availability triad',
        categories: ['Confidentiality', 'Integrity', 'Availability'],
        elementMapping: {
            actor:   ['Confidentiality'],
            process: ['Confidentiality', 'Integrity', 'Availability'],
            store:   ['Confidentiality', 'Integrity', 'Availability'],
            flow:    ['Confidentiality', 'Integrity', 'Availability']
        },
        questionsPerPair: 1,
        boundaryQuestionsEach: 1,
        globalQuestions: [
            'Qual é a classificação de dados (público, interno, confidencial, restrito) aplicada neste sistema?',
            'Existem mecanismos de redundância e failover para garantir disponibilidade?'
        ]
    },
    DIE: {
        name: 'DIE',
        description: 'Distributed, Immutable, Ephemeral — modern cloud-native security model',
        categories: ['Distributed', 'Immutable', 'Ephemeral'],
        elementMapping: {
            actor:   [],
            process: ['Distributed', 'Immutable', 'Ephemeral'],
            store:   ['Distributed', 'Immutable', 'Ephemeral'],
            flow:    ['Distributed', 'Ephemeral']
        },
        questionsPerPair: 1,
        boundaryQuestionsEach: 0,
        globalQuestions: [
            'Qual é a estratégia de CI/CD utilizada para deploy dos componentes?',
            'A infraestrutura é gerida como código (IaC — Terraform, Pulumi, ARM)?',
            'Existe uma política de rotação automática de segredos e credenciais?'
        ]
    },
    MITRE_F3: {
        name: 'MITRE F3',
        description: 'MITRE Fight Fraud Framework — financial fraud prevention',
        categories: ['Reconnaissance', 'Resource Development', 'Initial Access', 'Defense Evasion', 'Positioning', 'Execution', 'Monetization'],
        elementMapping: {
            actor:   ['Reconnaissance', 'Resource Development', 'Initial Access'],
            process: ['Defense Evasion', 'Positioning', 'Execution'],
            store:   ['Initial Access', 'Monetization'],
            flow:    ['Execution', 'Monetization']
        },
        questionsPerPair: 1,
        boundaryQuestionsEach: 1,
        globalQuestions: [
            'Quais processos de KYC (Know Your Customer) e AML (Anti-Money Laundering) estão implementados?',
            'Existe monitoramento de transações em tempo real para detecção de fraudes?',
            'Qual é a política de chargeback e disputa de transações?'
        ]
    },
    PLOT4ai: {
        name: 'PLOT4ai',
        description: 'Practical Library Of Threats for AI — responsible AI/ML threat modeling',
        categories: ['Data & Data Governance', 'Privacy & Data Protection', 'Cybersecurity', 'Safety & Environmental Impact', 'Bias, Fairness & Discrimination', 'Transparency & Accessibility', 'Ethics & Human Rights', 'Accountability & Human Oversight'],
        elementMapping: {
            actor:   ['Privacy & Data Protection', 'Ethics & Human Rights'],
            process: ['Data & Data Governance', 'Privacy & Data Protection', 'Cybersecurity', 'Safety & Environmental Impact', 'Bias, Fairness & Discrimination', 'Transparency & Accessibility', 'Ethics & Human Rights', 'Accountability & Human Oversight'],
            store:   ['Data & Data Governance', 'Privacy & Data Protection', 'Bias, Fairness & Discrimination'],
            flow:    ['Privacy & Data Protection', 'Cybersecurity']
        },
        questionsPerPair: 1,
        boundaryQuestionsEach: 0,
        globalQuestions: [
            'O sistema está em conformidade com o EU AI Act ou regulamentações locais de IA?',
            'Existem mecanismos de explicabilidade (XAI) para as decisões do modelo?',
            'Como é monitorado o drift do modelo e a degradação de performance em produção?',
            'Foi realizada uma auditoria de viés nos datasets de treino e validação?'
        ]
    }
};

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Returns the full framework definition for a given methodology key.
 * @param {string} methodology - e.g. 'STRIDE', 'LINDDUN', 'MITRE_F3'
 * @returns {object|null}
 */
const getFrameworkDefinition = (methodology) => FRAMEWORK_DEFINITIONS[methodology] || null;

/**
 * Returns all available framework keys.
 * @returns {string[]}
 */
const getAvailableFrameworks = () => Object.keys(FRAMEWORK_DEFINITIONS);

/**
 * Classifies a DFD cell shape into one of the standard element types.
 * @param {string} shape
 * @returns {string|null} 'actor', 'process', 'store', 'flow', or null
 */
const classifyShape = (shape) => {
    if (!shape) { return null; }
    const s = shape.toLowerCase();
    if (s === 'actor') { return 'actor'; }
    if (s === 'process') { return 'process'; }
    if (s === 'store') { return 'store'; }
    if (s === 'flow') { return 'flow'; }
    return null;
};

/**
 * Analyzes DFD cells and computes a complete question plan for the given methodology.
 * @param {Array} cells - Array of Threat Dragon V2 diagram cells
 * @param {string} methodology - Framework key
 * @returns {object} Question plan with total counts, per-element breakdown, and progress
 */
const computeQuestionPlan = (cells, methodology) => {
    const framework = getFrameworkDefinition(methodology);
    if (!framework) {
        logger.warn(`Unknown methodology "${methodology}" for question planning. Falling back to STRIDE.`);
        return computeQuestionPlan(cells, 'STRIDE');
    }

    const elementQuestions = [];
    let boundaryCount = 0;

    if (!cells || !Array.isArray(cells)) {
        return _buildPlanResult(framework, elementQuestions, 0);
    }

    // Helper to get type and name of source/target cells in flows
    const getCellTypeAndName = (cellId, allCells) => {
        const cell = allCells.find((c) => c.id === cellId);
        if (!cell) { return { type: 'unknown', name: 'Unknown' }; }
        const type = classifyShape(cell.shape) || 'unknown';
        const name = (cell.data && cell.data.name) ||
                     (cell.attrs && cell.attrs.text && cell.attrs.text.text) ||
                     cell.id || 'Unknown';
        return { type, name };
    };

    const nonFlowCells = [];
    const flowCells = [];

    cells.forEach((cell) => {
        const shape = cell.shape;

        // Count trust boundaries
        if (shape === 'trust-boundary-curve' || shape === 'trust-boundary-box') {
            boundaryCount++;
            return;
        }

        const elementType = classifyShape(shape);
        if (!elementType) { return; }

        if (elementType === 'flow') {
            flowCells.push(cell);
        } else {
            nonFlowCells.push(cell);
        }
    });

    // Group flow cells by source_type to target_type
    const flowGroups = {};
    flowCells.forEach((cell) => {
        const sourceId = cell.source?.cell;
        const targetId = cell.target?.cell;
        const sourceInfo = getCellTypeAndName(sourceId, cells);
        const targetInfo = getCellTypeAndName(targetId, cells);

        const groupKey = `${sourceInfo.type}_to_${targetInfo.type}`;
        if (!flowGroups[groupKey]) {
            flowGroups[groupKey] = {
                key: groupKey,
                sourceType: sourceInfo.type,
                targetType: targetInfo.type,
                flows: []
            };
        }
        const flowName = (cell.data && cell.data.name) ||
                         (cell.attrs && cell.attrs.text && cell.attrs.text.text) ||
                         cell.id || 'Unknown';
        flowGroups[groupKey].flows.push(flowName);
    });

    // Build virtual flow cells for the flow groups
    const virtualFlowCells = Object.keys(flowGroups).map((groupKey) => {
        const groupInfo = flowGroups[groupKey];
        const flowExamples = groupInfo.flows.slice(0, 3).join(', ') + (groupInfo.flows.length > 3 ? '...' : '');

        const getTypeNamePt = (type) => {
            if (type === 'process') { return 'Processo'; }
            if (type === 'store') { return 'Data Store'; }
            if (type === 'actor') { return 'Entidade Externa'; }
            return 'Desconhecido';
        };

        const groupName = `Fluxos: ${getTypeNamePt(groupInfo.sourceType)} para ${getTypeNamePt(groupInfo.targetType)} (ex: ${flowExamples})`;

        return {
            id: `flow-group-${groupKey}`,
            shape: 'flow',
            data: {
                name: groupName
            }
        };
    });

    // Process all non-flow cells and virtual flow groups
    const finalCellsToProcess = [...nonFlowCells, ...virtualFlowCells];

    finalCellsToProcess.forEach((cell) => {
        const elementType = classifyShape(cell.shape);
        const applicableCategories = framework.elementMapping[elementType] || [];
        if (applicableCategories.length === 0) { return; }

        const cellName = (cell.data && cell.data.name) ||
                         (cell.attrs && cell.attrs.text && cell.attrs.text.text) ||
                         cell.id || 'Unknown';

        const categoryQuestions = applicableCategories.map((category) => {
            const questions = [];
            for (let i = 0; i < framework.questionsPerPair; i++) {
                questions.push({
                    id: `q-${crypto.randomUUID().slice(0, 8)}`,
                    category,
                    elementId: cell.id,
                    elementName: cellName,
                    elementType,
                    type: framework.questionsPerPair === 1 ? 'consolidated' : (i === 0 ? 'threat_identification' : 'mitigation'),
                    answered: false
                });
            }
            return { category, questions };
        });

        elementQuestions.push({
            elementId: cell.id,
            elementName: cellName,
            elementShape: elementType,
            categories: categoryQuestions
        });
    });

    return _buildPlanResult(framework, elementQuestions, boundaryCount);
};

/**
 * Internal helper to build the final plan result object.
 */
const _buildPlanResult = (framework, elementQuestions, boundaryCount) => {
    const boundaryQTotal = boundaryCount * framework.boundaryQuestionsEach;
    const globalQTotal = framework.globalQuestions.length;

    let elementQTotal = 0;
    const byCategory = {};

    framework.categories.forEach((cat) => {
        byCategory[cat] = { total: 0, answered: 0 };
    });

    elementQuestions.forEach((elem) => {
        elem.categories.forEach((catGroup) => {
            const count = catGroup.questions.length;
            elementQTotal += count;
            if (byCategory[catGroup.category]) {
                byCategory[catGroup.category].total += count;
            }
        });
    });

    // Add global and boundary questions to their conceptual categories
    const totalQuestions = elementQTotal + boundaryQTotal + globalQTotal;
    const questionsPerRound = 4; // average questions per refinement round
    const estimatedRounds = Math.max(1, Math.ceil(totalQuestions / questionsPerRound));

    return {
        methodology: framework.name,
        methodologyKey: Object.keys(FRAMEWORK_DEFINITIONS).find((k) => FRAMEWORK_DEFINITIONS[k] === framework) || 'STRIDE',
        totalQuestions,
        breakdown: {
            elementQuestions: elementQTotal,
            boundaryQuestions: boundaryQTotal,
            globalQuestions: globalQTotal
        },
        byCategory,
        elementQuestions,
        boundaryCount,
        globalQuestions: framework.globalQuestions,
        estimatedRounds,
        progress: {
            answered: 0,
            total: totalQuestions,
            percentage: 0
        }
    };
};

/**
 * Selects the next batch of questions for a given round, respecting tier/category rotation.
 * @param {object} plan - The question plan
 * @param {number} roundNumber - Current round (1-indexed)
 * @param {string[]} answeredQuestionIds - IDs of already-answered questions
 * @param {number} batchSize - Number of questions per round (default 4)
 * @returns {object} { questions: [...], pendingCategories: {...}, pendingElements: [...] }
 */
const getQuestionsByRound = (plan, roundNumber, answeredQuestionIds = [], batchSize = 4) => {
    const answeredSet = new Set(answeredQuestionIds);
    const pendingQuestions = [];

    // Collect all pending element questions
    plan.elementQuestions.forEach((elem) => {
        elem.categories.forEach((catGroup) => {
            catGroup.questions.forEach((q) => {
                if (!answeredSet.has(q.id) && !q.answered) {
                    pendingQuestions.push(q);
                }
            });
        });
    });

    if (pendingQuestions.length === 0) {
        return { questions: [], pendingCategories: {}, pendingElements: [] };
    }

    // Distribute across different elements and categories
    const selectedQuestions = [];
    const usedElements = new Set();
    const usedCategories = new Set();

    // Pass 1: Pick one question per unique (element, category) pair
    for (const q of pendingQuestions) {
        if (selectedQuestions.length >= batchSize) { break; }
        const elemKey = q.elementId;
        const catKey = q.category;
        if (!usedElements.has(elemKey) && !usedCategories.has(catKey)) {
            selectedQuestions.push(q);
            usedElements.add(elemKey);
            usedCategories.add(catKey);
        }
    }

    // Pass 2: Fill remaining slots if batch not full (relax element constraint)
    if (selectedQuestions.length < batchSize) {
        for (const q of pendingQuestions) {
            if (selectedQuestions.length >= batchSize) { break; }
            if (!selectedQuestions.includes(q) && !usedCategories.has(q.category)) {
                selectedQuestions.push(q);
                usedCategories.add(q.category);
            }
        }
    }

    // Pass 3: Fill remaining (relax both constraints)
    if (selectedQuestions.length < batchSize) {
        for (const q of pendingQuestions) {
            if (selectedQuestions.length >= batchSize) { break; }
            if (!selectedQuestions.includes(q)) {
                selectedQuestions.push(q);
            }
        }
    }

    // Build pending summary for the LLM prompt
    const pendingCategories = {};
    const pendingElementIds = new Set();
    pendingQuestions.forEach((q) => {
        if (!pendingCategories[q.category]) {
            pendingCategories[q.category] = [];
        }
        pendingCategories[q.category].push({ elementId: q.elementId, elementName: q.elementName });
        pendingElementIds.add(q.elementId);
    });

    const pendingElements = [];
    plan.elementQuestions.forEach((elem) => {
        if (pendingElementIds.has(elem.elementId)) {
            const pendingCats = elem.categories.
                filter((cg) => cg.questions.some((q) => !answeredSet.has(q.id) && !q.answered)).
                map((cg) => cg.category);
            if (pendingCats.length > 0) {
                pendingElements.push({
                    elementId: elem.elementId,
                    elementName: elem.elementName,
                    elementShape: elem.elementShape,
                    pendingCategories: pendingCats
                });
            }
        }
    });

    return {
        questions: selectedQuestions,
        pendingCategories,
        pendingElements
    };
};

/**
 * Computes current progress based on answered question IDs.
 * @param {object} plan - The question plan
 * @param {string[]} answeredQuestionIds - IDs of answered questions
 * @returns {object} Updated progress and per-category breakdown
 */
const computeProgress = (plan, answeredQuestionIds = []) => {
    const answeredSet = new Set(answeredQuestionIds);
    let totalAnswered = 0;

    const byCategory = {};
    const framework = getFrameworkDefinition(plan.methodologyKey || 'STRIDE');
    if (framework) {
        framework.categories.forEach((cat) => {
            byCategory[cat] = { total: 0, answered: 0 };
        });
    }

    plan.elementQuestions.forEach((elem) => {
        elem.categories.forEach((catGroup) => {
            catGroup.questions.forEach((q) => {
                if (byCategory[catGroup.category]) {
                    byCategory[catGroup.category].total++;
                }
                if (answeredSet.has(q.id) || q.answered) {
                    totalAnswered++;
                    if (byCategory[catGroup.category]) {
                        byCategory[catGroup.category].answered++;
                    }
                }
            });
        });
    });

    // Count global + boundary as answered if total rounds have progressed enough
    const globalAndBoundary = plan.breakdown.globalQuestions + plan.breakdown.boundaryQuestions;
    const totalElementQ = plan.breakdown.elementQuestions;
    const elementProgress = totalElementQ > 0 ? totalAnswered / totalElementQ : 1;
    const estimatedGlobalAnswered = Math.min(globalAndBoundary, Math.floor(elementProgress * globalAndBoundary));
    const totalWithExtras = totalAnswered + estimatedGlobalAnswered;

    const total = plan.totalQuestions;
    const percentage = total > 0 ? Math.min(100, Math.round((totalWithExtras / total) * 100)) : 100;

    return {
        answered: totalWithExtras,
        total,
        percentage,
        byCategory
    };
};

/**
 * Builds an LLM prompt fragment describing pending question coverage.
 * @param {object} plan - The question plan
 * @param {string[]} answeredQuestionIds
 * @returns {string} Prompt text for injection into the ThreatAgent prompt
 */
const buildPendingCoveragePrompt = (plan, answeredQuestionIds = []) => {
    const { pendingElements } = getQuestionsByRound(plan, 0, answeredQuestionIds, 100);

    if (pendingElements.length === 0) {
        return '\n--- QUESTION COVERAGE STATUS ---\nAll framework categories have been covered for all elements. Focus on deepening existing threat details.\n';
    }

    let prompt = '\n--- PENDING QUESTION PLAN ---\nThe following categories still need to be covered for a complete threat model:\n\n';

    pendingElements.forEach((elem) => {
        prompt += `Element: "${elem.elementName}" (${elem.elementShape})\n`;
        prompt += `  - Pending categories: [${elem.pendingCategories.join(', ')}]\n\n`;
    });

    // Compute answered categories
    const answeredSet = new Set(answeredQuestionIds);
    const answeredCats = new Set();
    plan.elementQuestions.forEach((elem) => {
        elem.categories.forEach((cg) => {
            const allAnswered = cg.questions.every((q) => answeredSet.has(q.id) || q.answered);
            if (allAnswered && cg.questions.length > 0) {
                answeredCats.add(cg.category);
            }
        });
    });

    if (answeredCats.size > 0) {
        prompt += `Already-covered categories (do NOT repeat): [${[...answeredCats].join(', ')}]\n\n`;
    }

    prompt += 'You MUST generate questions that target SPECIFICALLY the pending categories listed above.\n';
    prompt += 'Distribute questions across different elements and categories for maximum coverage.\n';

    return prompt;
};

export default {
    getFrameworkDefinition,
    getAvailableFrameworks,
    computeQuestionPlan,
    getQuestionsByRound,
    computeProgress,
    buildPendingCoveragePrompt,
    FRAMEWORK_DEFINITIONS
};
