import graphFactory from '@/service/x6/graph/graph.js';
import events from '@/service/x6/graph/events.js';
import { passiveSupport } from 'passive-events-support/src/utils';

const appVersion = require('../../../package.json').version;

passiveSupport({
    events: ['touchstart', 'mousewheel']
});

const drawGraph = (diagram, graph) => {
    console.debug('open diagram version: ' + diagram.version);
    diagram.version = appVersion;
    if (diagram && Array.isArray(diagram.cells)) {
        const nodeIds = new Set();
        diagram.cells.forEach(cell => {
            if (cell && cell.id) {
                const isEdge = cell.source && typeof cell.source === 'object' && cell.source.cell;
                if (!isEdge) {
                    nodeIds.add(cell.id);
                }
            }
        });

        diagram.cells = diagram.cells.filter(cell => {
            if (cell && cell.source && typeof cell.source === 'object' && cell.source.cell) {
                const sourceCellId = cell.source.cell;
                const targetCellId = cell.target && typeof cell.target === 'object' ? cell.target.cell : null;
                if (!nodeIds.has(sourceCellId)) {
                    console.warn(`[diagram.js] Filtering out edge "${cell.id}" because its source node "${sourceCellId}" does not exist in diagram.`);
                    return false;
                }
                if (targetCellId && !nodeIds.has(targetCellId)) {
                    console.warn(`[diagram.js] Filtering out edge "${cell.id}" because its target node "${targetCellId}" does not exist in diagram.`);
                    return false;
                }
            }
            return true;
        });
    }
    graph.fromJSON(diagram);
    return graph;
};

const draw = (container, diagram) => drawGraph(diagram, graphFactory.getReadonlyGraph(container));
const edit = (container, diagram) => drawGraph(diagram, graphFactory.getEditGraph(container));

const dispose = (graph) => {
    events.removeListeners(graph);
    graph.dispose();
};

export default {
    dispose,
    draw,
    edit
};
