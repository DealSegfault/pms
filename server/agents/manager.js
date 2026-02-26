/**
 * Agent Manager — Lifecycle manager for all trading agents.
 *
 * Handles creation, lookup, and teardown of agent instances.
 * Broadcasts WS events for UI integration.
 */
import { broadcast } from '../ws.js';
import TrendAgent from './trend-agent.js';
import GridAgent from './grid-agent.js';
import DeleverageAgent from './deleverage-agent.js';

const activeAgents = new Map(); // id → AgentBase
const MAX_ACTIVE_AGENTS = 50;

const AGENT_TYPES = {
    trend: TrendAgent,
    grid: GridAgent,
    deleverage: DeleverageAgent,
};

/**
 * Start a new agent.
 * @param {string} type — 'trend' | 'grid' | 'deleverage'
 * @param {Object} config — agent-specific config
 * @returns {Object} agent status
 */
export async function startAgent(type, config) {
    const AgentClass = AGENT_TYPES[type];
    if (!AgentClass) {
        throw new Error(`Unknown agent type: ${type}. Valid: ${Object.keys(AGENT_TYPES).join(', ')}`);
    }
    if (activeAgents.size >= MAX_ACTIVE_AGENTS) {
        throw new Error(`Maximum concurrent agents (${MAX_ACTIVE_AGENTS}) reached`);
    }
    if (!config.subAccountId || !config.symbol) {
        throw new Error('Missing required fields: subAccountId, symbol');
    }

    const agent = new AgentClass({ type, ...config });
    activeAgents.set(agent.id, agent);

    await agent.start();

    broadcast('agent_started', agent.getStatus());
    console.log(`[AgentManager] Started ${type} agent ${agent.id} on ${config.symbol}`);
    return agent.getStatus();
}

/**
 * Stop an agent and kill all its managed scalpers.
 */
export async function stopAgent(agentId, reason = 'manual') {
    const agent = activeAgents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    await agent.stop(reason);
    activeAgents.delete(agentId);

    broadcast('agent_stopped', { agentId, reason });
    console.log(`[AgentManager] Stopped agent ${agentId}: ${reason}`);
    return agent.getStatus();
}

/**
 * List all active agents for a sub-account.
 */
export function listAgents(subAccountId) {
    const results = [];
    for (const [, agent] of activeAgents) {
        if (!subAccountId || agent.subAccountId === subAccountId) {
            results.push(agent.getStatus());
        }
    }
    return results;
}

/**
 * Get detailed status for a single agent.
 */
export function getAgent(agentId) {
    const agent = activeAgents.get(agentId);
    if (!agent) return null;
    return agent.getStatus();
}

/**
 * Stop all agents (used during shutdown).
 */
export async function stopAllAgents() {
    const promises = [];
    for (const [id] of activeAgents) {
        promises.push(stopAgent(id, 'shutdown').catch(() => { }));
    }
    await Promise.allSettled(promises);
}

export { AGENT_TYPES, activeAgents };
