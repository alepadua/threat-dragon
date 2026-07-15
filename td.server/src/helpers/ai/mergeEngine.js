/* eslint-disable */
import loggerHelper from '../logger.helper.js';

const logger = loggerHelper.get('helpers/ai/mergeEngine.js');

export const getCellName = (cell) => {
    if (!cell) { return ''; }
    if (cell.data && cell.data.name) {
        return cell.data.name;
    }
    if (cell.attrs && cell.attrs.text && cell.attrs.text.text) {
        return cell.attrs.text.text;
    }
    return '';
};

export const normalizeName = (name) => {
    if (!name) { return ''; }
    return name.toLowerCase().
               replace(/[\s\-_]+/gu, '').
               replace(/(?:svc|service|db|database|api|microsserviço|microservice|serviço)$/gu, '');
};

export const areTitlesSimilar = (title1, title2) => {
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

export const normalizeCellThreats = (cells, diagramType) => {
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

export const mergeThreats = (fromCell, toCell) => {
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

export const deduplicateDiagramCells = (cells) => {
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
                const canonicalNode = nodesByNormalizedName.get(normName);
                mergeThreats(cell, canonicalNode);
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

    const flowKeys = new Set();
    const updatedFlows = [];
    finalFlows.forEach((flow) => {
        if (!flow || !flow.source || !flow.target) { return; }
        const sourceId = flow.source.cell;
        const targetId = flow.target.cell;
        
        const mappedSourceId = nodeIdRedirect.get(sourceId) || sourceId;
        const mappedTargetId = nodeIdRedirect.get(targetId) || targetId;
        
        flow.source.cell = mappedSourceId;
        flow.target.cell = mappedTargetId;
        
        const flowKey = `${mappedSourceId}->${mappedTargetId}`;
        if (!flowKeys.has(flowKey)) {
            flowKeys.add(flowKey);
            updatedFlows.push(flow);
        } else {
            const canonicalFlow = updatedFlows.find((f) => f.source.cell === mappedSourceId && f.target.cell === mappedTargetId);
            if (canonicalFlow) {
                mergeThreats(flow, canonicalFlow);
            }
        }
    });

    return [...finalNodes, ...updatedFlows, ...finalBoundaries, ...others];
};

export const mergeControlsAssessment = (prevAssessments, newAssessments) => {
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

export const healDiagramCells = (cells) => {
    if (!Array.isArray(cells)) {
        return cells;
    }

    const nodes = [];
    const edges = [];

    const toSlug = (str) => {
        if (!str || typeof str !== 'string') {
            return '';
        }
        return str.
            toLowerCase().
            normalize('NFD').
            replace(/[\u0300-\u036f]/gu, '').
            replace(/[^a-z0-9]/gu, '-').
            replace(/-+/gu, '-').
            replace(/^-+|-+$/gu, '');
    };

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

    const resolveReference = (refId) => {
        if (idToNode.has(refId)) {
            return refId;
        }
        const refSlug = toSlug(refId.replace(/^(?:proc|actor|store|boundary|flow)-/u, ''));
        const refSlugClean = toSlug(refId.replace(/^(?:proc|actor|store|boundary|flow)-/u, ''));
        let matchedId = slugToId.get(refSlugClean);
        if (!matchedId) {
            for (const [slug, id] of slugToId.entries()) {
                if (slug.includes(refSlugClean) || refSlugClean.includes(slug)) {
                    matchedId = id;
                    break;
                }
            }
        }
        return matchedId || null;
    };

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
            healedEdges.push(edge);
        }
    });

    return [...nodes, ...healedEdges];
};

export const applyDeduplicationChanges = (model, controlsAssessment, proposals, approvedControlIds = [], approvedThreatIds = []) => {
    const newModel = JSON.parse(JSON.stringify(model));
    let newControls = (controlsAssessment || []).filter(item => item && item.securityControl);
    
    if (!proposals) { return { model: newModel, controlsAssessment: newControls }; }
    
    if (proposals.controlDeduplications && Array.isArray(proposals.controlDeduplications)) {
        proposals.controlDeduplications.forEach((proposal) => {
            if (approvedControlIds.includes(proposal.id)) {
                const answersToMerge = proposal.itemsToMerge.map((i) => i.userAnswer?.trim().toLowerCase());
                newControls = newControls.filter((item) => {
                    const ans = item.userAnswer?.trim().toLowerCase();
                    return !answersToMerge.includes(ans);
                });
                newControls.push(proposal.proposedMergedItem);
            }
        });
    }
    
    if (proposals.threatDeduplications && Array.isArray(proposals.threatDeduplications)) {
        proposals.threatDeduplications.forEach((proposal) => {
            if (approvedThreatIds.includes(proposal.id)) {
                const { cellId } = proposal;
                if (newModel.detail && newModel.detail.diagrams && newModel.detail.diagrams[0]) {
                    const cells = newModel.detail.diagrams[0].cells || [];
                    const cell = cells.find((c) => c.id === cellId);
                    if (cell && cell.data && Array.isArray(cell.data.threats)) {
                        const originalThreatIds = proposal.itemsToMerge.map((t) => t.id).filter(Boolean);
                        const originalThreatTitles = proposal.itemsToMerge.map((t) => t.title?.trim().toLowerCase());
                        
                        cell.data.threats = cell.data.threats.filter((t) => {
                            if (originalThreatIds.includes(t.id)) { return false; }
                            if (originalThreatTitles.includes(t.title?.trim().toLowerCase())) { return false; }
                            return true;
                        });
                        
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
    
    // Update threat status from proposals.mitigationStatus
    if (proposals.mitigationStatus && Array.isArray(proposals.mitigationStatus)) {
        proposals.mitigationStatus.forEach((statusItem) => {
            const { threatId, status } = statusItem;
            if (threatId) {
                if (newModel.detail && newModel.detail.diagrams && newModel.detail.diagrams[0]) {
                    const cells = newModel.detail.diagrams[0].cells || [];
                    cells.forEach((cell) => {
                        if (cell.data && Array.isArray(cell.data.threats)) {
                            const threat = cell.data.threats.find((t) => t.id === threatId || t.threatId === threatId);
                            if (threat) {
                                if (status === 'Mitigada' || status === 'Mitigated') {
                                    threat.status = 'Mitigated';
                                } else {
                                    threat.status = 'Open';
                                }
                            }
                        }
                    });
                }
            }
        });
        
        // Re-evaluate hasOpenThreats for all cells
        if (newModel.detail && newModel.detail.diagrams && newModel.detail.diagrams[0]) {
            const cells = newModel.detail.diagrams[0].cells || [];
            cells.forEach((cell) => {
                if (cell.data && Array.isArray(cell.data.threats)) {
                    cell.data.hasOpenThreats = cell.data.threats.some((t) => t.status === 'Open');
                }
            });
        }
    }
    
    return { model: newModel, controlsAssessment: newControls };
};

export const mergeDiagramCells = (currentModel, revisedModel, refinementHistory, dfdApproved = false) => {
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

        const updatedCellIds = new Set();

        revisedCells.forEach((revisedCell) => {
            if (!revisedCell) { return; }
            
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
                if (!targetCell.data) { targetCell.data = {}; }
                if (!targetCell.data.threats) { targetCell.data.threats = []; }

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
                        targetCell.data.threats.push(rt);
                    }
                });
                targetCell.data.hasOpenThreats = targetCell.data.threats.some((t) => t.status === 'Open');
                updatedCellIds.add(targetCell.id);
            } else {
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

    currentCells.forEach((cell) => {
        if (cell && cell.id && revisedCellMap.has(cell.id)) {
            nodeIdMapping.set(cell.id, cell.id);
        }
    });

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

export default {
    getCellName,
    normalizeName,
    areTitlesSimilar,
    normalizeCellThreats,
    mergeThreats,
    deduplicateDiagramCells,
    mergeControlsAssessment,
    healDiagramCells,
    applyDeduplicationChanges,
    mergeDiagramCells
};
