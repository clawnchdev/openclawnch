---
name: nookplot
description: Multi-agent coordination for collaborative DeFi strategies, parallel token launches, and research
---

# nookplot — Agent Coordination Protocol

nookplot enables multi-agent coordination for collaborative DeFi strategies.

## What It Is

An Agent Coordination Protocol used by the openclawnch community for:
- Coordinating multiple AI agents for collaborative DeFi strategies
- Parallel token launches with coordinated LP provisioning
- Multi-agent research workflows
- Cross-agent communication via standardized protocol

## Integration Path

nookplot integration depends on their API documentation (currently sparse). Likely ACP-based:
- Our ACP Provenance mode (already enabled) provides the identity verification layer
- nookplot coordinates the messaging and task allocation between agents
- Each agent maintains its own execution context and wallet

## When to Use

- User wants to coordinate multiple openclawnch agents for a strategy
- User asks about multi-agent DeFi workflows
- User wants to parallelize research or execution across agents
- User mentions "nookplot" or "agent coordination" by name

## Potential Workflows

### Coordinated Token Launch
1. Agent A researches market conditions and optimal timing
2. Agent B prepares token deployment parameters
3. Agent C monitors LP pools for optimal entry
4. nookplot coordinates execution order and timing

### Multi-Agent Research
1. Agent A analyzes on-chain data for a protocol
2. Agent B monitors social sentiment (Farcaster/X)
3. Agent C tracks governance proposals
4. nookplot aggregates findings into a unified report

### Collaborative LP Management
1. Multiple agents each manage a portion of LP positions
2. nookplot ensures they don't overlap or compete
3. Coordinated rebalancing across all positions

## Relationship to OpenClawnch

| Component | Role |
|-----------|------|
| ACP Provenance | Identity verification between agents |
| Molten | Agent marketplace for finding specialized agents |
| nookplot | Coordination protocol for multi-agent workflows |
| ClawnchConnect | Per-agent wallet signing (each agent has its own wallet) |

## Important Notes

1. **API is sparse** — nookplot is early-stage. Full integration depends on public API docs.
2. **ACP-compatible** — our existing ACP provenance mode aligns with nookplot's coordination model
3. **Community-driven** — popular with our early users; integration provides distribution
4. **Each agent is independent** — nookplot coordinates but doesn't control. Each agent retains its own wallet and decision-making.
