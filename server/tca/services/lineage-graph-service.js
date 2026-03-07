import { loadRecursiveLineageGraph } from '../repositories/lineage-repository.js';

let graphTruncatedCount = 0;

export async function loadLineageGraph(subAccountId, rootNodeType, rootNodeId) {
    const graph = await loadRecursiveLineageGraph({
        subAccountId,
        rootNodeType,
        rootNodeId,
        maxNodes: 5000,
        maxEdges: 10000,
    });
    if (graph.truncated) {
        graphTruncatedCount += 1;
        console.info(`[TCA] lineage graph truncated count=${graphTruncatedCount}`);
    }
    return graph;
}

export function getLineageGraphTruncatedCount() {
    return graphTruncatedCount;
}
